// MCP server that gives an agent a Lightning wallet with a spending policy.
// It discovers L402 services, pays their challenges, reuses paid tokens, asks a
// human (MCP elicitation) above a threshold, and keeps a receipt for every decision.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { decide, parseChallenge, type Receipt, spentToday } from "./policy";

const ROOT = resolve(import.meta.dir, "..");
const DEMO = resolve(ROOT, ".demo");
const STATE = process.env.L402_STATE_DIR ?? resolve(DEMO, "agent");
const LEDGER = resolve(STATE, "receipts.jsonl");
const TOKENS = resolve(STATE, "tokens.json");
const FEE_LIMIT_SATS = 10;
const policy = {
	autoApproveSats: Number(process.env.L402_AUTO_APPROVE_SATS ?? 100),
	dailyBudgetSats: Number(process.env.L402_DAILY_BUDGET_SATS ?? 5000),
};
mkdirSync(STATE, { recursive: true, mode: 0o700 });

type Manifest = {
	provider?: { name?: string; node_pubkey?: string };
	services: {
		name: string;
		description?: string;
		resources: { path?: string; method?: string; pricing: { model: string; price_msat?: number } }[];
	}[];
};
const manifests = new Map<string, Manifest>();
// Paid tokens are bearer credentials (macaroon + preimage): keep them owner-readable only.
const tokens: Record<string, string> = existsSync(TOKENS) ? JSON.parse(readFileSync(TOKENS, "utf8")) : {};
const saveTokens = () => writeFileSync(TOKENS, JSON.stringify(tokens, null, 2), { mode: 0o600 });
const readLedger = (): Receipt[] =>
	existsSync(LEDGER) ? readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const record = (r: Receipt) => appendFileSync(LEDGER, `${JSON.stringify(r)}\n`, { mode: 0o600 });
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

// The agent's node credential is a baked macaroon limited to reading and paying invoices.
async function lncli(...args: string[]): Promise<string> {
	const p = Bun.spawn(
		[
			resolve(ROOT, ".bin/lncli"),
			"--network=regtest",
			"--rpcserver=127.0.0.1:10019",
			`--tlscertpath=${DEMO}/buyer/tls.cert`,
			`--macaroonpath=${DEMO}/agent-pay.macaroon`,
			...args,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	if (code !== 0) throw new Error(`lncli ${args[0]} failed: ${(err || out).trim()}`);
	return out;
}

async function discover(origin: string): Promise<Manifest> {
	const res = await fetch(`${origin}/.well-known/l402.json`, { signal: AbortSignal.timeout(5000) });
	if (!res.ok) throw new Error(`no L402 manifest at ${origin} (HTTP ${res.status})`);
	const manifest = (await res.json()) as Manifest;
	manifests.set(origin, manifest);
	return manifest;
}

const serviceFor = (url: URL) =>
	manifests
		.get(url.origin)
		?.services.find((s) => s.resources.some((r) => r.path && url.pathname.startsWith(r.path)))?.name ?? url.pathname;

async function readBody(res: Response): Promise<unknown> {
	const text = (await res.text()).slice(0, 8000);
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

const server = new McpServer({ name: "l402-wallet", version: "0.1.0" });

async function askHuman(message: string): Promise<string | undefined> {
	if (!server.server.getClientCapabilities()?.elicitation)
		return "needs human approval, but this MCP client cannot prompt a human";
	const r = await server.server.elicitInput({
		message,
		requestedSchema: {
			type: "object",
			properties: { approve: { type: "boolean", title: "Approve this payment", default: false } },
			required: ["approve"],
		},
	});
	if (r.action === "accept" && r.content?.approve === true) return undefined;
	return { accept: "the human declined the payment", decline: "the human declined the payment", cancel: "the human dismissed the approval request" }[r.action];
}

server.registerTool(
	"l402_discover",
	{
		title: "Discover L402 services",
		description:
			"Read a provider's free L402 discovery manifest (/.well-known/l402.json): its services, paths, and prices in sats. Call this before buying from a provider.",
		inputSchema: { url: z.string().url().describe("Any URL on the provider") },
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	async ({ url }) => {
		const origin = new URL(url).origin;
		const m = await discover(origin);
		return json({
			provider: m.provider,
			resources: m.services.flatMap((s) =>
				s.resources.map((r) => ({
					service: s.name,
					method: r.method ?? "GET",
					url: `${origin}${r.path ?? ""}`,
					price_sats: r.pricing.model === "fixed" ? (r.pricing.price_msat ?? 0) / 1000 : r.pricing.model,
					description: s.description,
				})),
			),
		});
	},
);

server.registerTool(
	"l402_fetch",
	{
		title: "Fetch a paid resource",
		description:
			"Make an HTTP request, paying any L402 Lightning challenge from the agent wallet and reusing a paid token when one exists. " +
			`Payments up to ${policy.autoApproveSats} sats are automatic; larger ones ask the human; anything over max_sats or the ` +
			`${policy.dailyBudgetSats}-sat daily budget is refused. Set max_sats to the most this one call may cost.`,
		inputSchema: {
			url: z.string().url(),
			max_sats: z.number().int().positive().describe("Most this call may spend, in sats"),
			method: z.enum(["GET", "POST"]).default("GET"),
			body: z.string().optional(),
		},
		annotations: { readOnlyHint: false, openWorldHint: true },
	},
	async ({ url: href, max_sats, method, body }) => {
		const url = new URL(href);
		if (!manifests.has(url.origin)) await discover(url.origin).catch(() => undefined);
		const service = serviceFor(url);
		const key = `${url.origin} ${service}`;
		const call = (authorization?: string) =>
			fetch(url, { method, body, headers: authorization ? { authorization } : {}, signal: AbortSignal.timeout(15_000) });

		if (tokens[key]) {
			const res = await call(tokens[key]);
			if (res.status !== 401 && res.status !== 402)
				return json({ status: res.status, payment: { amount_sat: 0, reused_paid_token: true }, body: await readBody(res) });
			delete tokens[key];
			saveTokens();
		}

		const first = await call();
		if (first.status !== 402) return json({ status: first.status, payment: null, body: await readBody(first) });
		const challenge = parseChallenge(first.headers.get("www-authenticate"));
		if (!challenge) return json({ status: 402, paid: false, error: "402 response without an L402 challenge" });

		const invoice = JSON.parse(await lncli("decodepayreq", challenge.invoice));
		const base = {
			ts: new Date().toISOString(),
			url: url.href,
			service,
			amount_sat: Math.ceil(Number(invoice.num_msat) / 1000),
			fee_sat: 0,
			payment_hash: invoice.payment_hash as string,
		};
		const stop = (outcome: "declined" | "refused", reason: string, approval: Receipt["approval"] = "none") => {
			record({ ...base, approval, outcome, reason });
			return json({ status: 402, paid: false, outcome, reason, price_sats: base.amount_sat });
		};

		const expectedNode = manifests.get(url.origin)?.provider?.node_pubkey;
		if (expectedNode && invoice.destination !== expectedNode)
			return stop("refused", "invoice pays a different node than the provider's manifest names");

		// ponytail: check-then-pay isn't locked, so two concurrent calls could both fit the budget; reserve spend under a lock if agents run calls in parallel.
		const spent = spentToday(readLedger());
		const decision = decide(base.amount_sat, max_sats, spent, policy);
		if (decision.kind === "refuse") return stop("refused", decision.reason);
		if (decision.kind === "ask") {
			const denied = await askHuman(
				`Approve ${base.amount_sat} sats for ${method} ${url.pathname} (${service})? ` +
					`${decision.reason}. Spent today: ${spent} of ${policy.dailyBudgetSats} sats.`,
			);
			if (denied) return stop("declined", denied, "human");
		}

		const out = await lncli("payinvoice", "--force", "--json", `--fee_limit=${FEE_LIMIT_SATS}`, challenge.invoice);
		const status = [...out.matchAll(/"status":\s*"(\w+)"/g)].at(-1)?.[1];
		const preimage = out.match(/"payment_preimage":\s*"([0-9a-f]{64})"/)?.[1];
		if (status !== "SUCCEEDED" || !preimage) throw new Error(`payment did not succeed (status ${status ?? "unknown"})`);
		if (createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex") !== base.payment_hash)
			throw new Error("preimage does not match the invoice's payment hash");
		const fee = Number([...out.matchAll(/"fee_sat":\s*"(\d+)"/g)].at(-1)?.[1] ?? 0);
		const approval = decision.kind === "ask" ? "human" : "auto";
		record({ ...base, fee_sat: fee, preimage, approval, outcome: "paid" });
		tokens[key] = `L402 ${challenge.macaroon}:${preimage}`;
		saveTokens();

		const res = await call(tokens[key]);
		return json({
			status: res.status,
			payment: {
				amount_sat: base.amount_sat,
				fee_sat: fee,
				approval,
				payment_hash: base.payment_hash,
				spent_today_sat: spent + base.amount_sat + fee,
				daily_budget_sat: policy.dailyBudgetSats,
			},
			body: await readBody(res),
		});
	},
);

server.registerTool(
	"l402_wallet",
	{
		title: "Wallet and spending",
		description: "Show the spending policy, today's spend, remaining daily budget, channel balance, and recent receipts.",
		annotations: { readOnlyHint: true },
	},
	async () => {
		const ledger = readLedger();
		const spent = spentToday(ledger);
		const balance = JSON.parse(await lncli("channelbalance"));
		return json({
			policy: { auto_approve_sats: policy.autoApproveSats, daily_budget_sats: policy.dailyBudgetSats, fee_limit_sats: FEE_LIMIT_SATS },
			spent_today_sat: spent,
			remaining_today_sat: Math.max(0, policy.dailyBudgetSats - spent),
			channel_balance_sat: Number(balance.local_balance?.sat ?? 0),
			recent_receipts: ledger.slice(-8).map(({ preimage, ...r }) => r),
		});
	},
);

await server.connect(new StdioServerTransport());
