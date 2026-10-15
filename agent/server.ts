// MCP server that gives an agent a Lightning wallet (lnd or Wavelength) with a spending policy.
// It discovers L402 services, pays their challenges, reuses paid tokens, asks a
// human (MCP elicitation) above a threshold, and keeps a receipt for every decision.
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { decide, parseChallenge, type Receipt, spentToday } from "./policy";
import { PaymentFailed, walletFromEnv } from "./wallet";
import { Store, type Purchase } from "./store";

const ROOT = resolve(import.meta.dir, "..");
const DEMO = resolve(ROOT, ".demo");
const STATE = process.env.L402_STATE_DIR ?? resolve(DEMO, "agent");
const FEE_LIMIT_SATS = 10;
const policy = {
	autoApproveSats: Number(process.env.L402_AUTO_APPROVE_SATS ?? 100),
	dailyBudgetSats: Number(process.env.L402_DAILY_BUDGET_SATS ?? 5000),
};
if (![policy.autoApproveSats, policy.dailyBudgetSats].every(n => Number.isSafeInteger(n) && n >= 0))
	throw new Error("spending limits must be nonnegative safe integers");
const store = new Store(STATE);

type Manifest = {
	provider?: { name?: string; node_pubkey?: string };
	services: {
		name: string;
		description?: string;
		resources: { path?: string; method?: string; pricing: { model: string; price_msat?: number } }[];
	}[];
};
const manifests = new Map<string, Manifest>();
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

const wallet = walletFromEnv(ROOT, DEMO);

async function reconcile() {
	for (const p of store.purchases()) {
		if ((p.outcome !== "pending" && !(p.outcome === "paid" && !p.proof_of_payment)) || p.wallet !== wallet.name) continue;
		try {
			const status = await wallet.lookup(p.quote);
			if (status.state === "paid") store.finish(p.payment_hash, status.result);
			if (status.state === "failed" && p.outcome === "pending") store.finish(p.payment_hash, "failed");
		} catch { /* Keep the reservation when the wallet cannot provide a definitive outcome. */ }
	}
}

function paymentState(p: Purchase) {
	return json({ status: 402, paid: p.outcome === "pending" ? null : p.outcome === "paid", outcome: p.outcome,
		proof_of_payment: p.proof_of_payment ?? false, resource_delivered: false, payment_hash: p.payment_hash,
		reason: p.reason ?? (p.outcome === "pending" ? "payment unresolved; funds remain reserved and automatic retry is blocked" : "wallet confirmed payment failure") });
}

// Serialize prompts within this process; SQLite reservations enforce the shared budget.
let lock: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
	const run = lock.then(fn, fn);
	lock = run.catch(() => undefined);
	return run;
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
			`${policy.dailyBudgetSats}-sat daily budget is refused. All limits include maximum routing fees. Set max_sats to the most this one call may cost.`,
		inputSchema: {
			url: z.string().url(),
			max_sats: z.number().int().positive().describe("Most this call may spend, in sats"),
			method: z.enum(["GET", "POST"]).default("GET"),
			body: z.string().optional(),
		},
		annotations: { readOnlyHint: false, openWorldHint: true },
	},
	async ({ url: href, max_sats, method, body }) => serialized(async () => {
		const url = new URL(href);
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid provider URL");
		if (!manifests.has(url.origin)) await discover(url.origin).catch(() => undefined);
		const service = serviceFor(url);
		const key = `${url.origin} ${service}`;
		await reconcile();
		const call = (authorization?: string) =>
			fetch(url, { method, body, redirect: "error", headers: authorization ? { authorization } : {}, signal: AbortSignal.timeout(15_000) });
		const deliver = async (authorization: string, payment: Record<string, unknown>) => {
			try {
				const res = await call(authorization);
				return json({ status: res.status, paid: true, proof_of_payment: true, resource_delivered: res.ok,
					payment, body: await readBody(res),
					...(!res.ok ? { reason: "paid credential did not deliver the resource; automatic repayment blocked" } : {}) });
			} catch {
				return json({ paid: true, proof_of_payment: true, resource_delivered: false, payment,
					reason: "resource response unavailable; delivery is unknown; automatic repayment blocked" });
			}
		};
		const token = store.token(key);
		if (token) return deliver(token, { amount_sat: 0, reused_paid_token: true });
		const existing = store.forKey(key);
		if (existing) return paymentState(existing);

		const first = await call();
		if (first.status !== 402) return json({ status: first.status, payment: null, body: await readBody(first) });
		const challenge = parseChallenge(first.headers.get("www-authenticate"));
		if (!challenge) return json({ status: 402, paid: false, error: "402 response without an L402 challenge" });
		const quote = await wallet.quote(challenge.invoice, FEE_LIMIT_SATS);
		if (!/^[0-9a-f]{64}$/.test(quote.paymentHash)) throw new Error("wallet returned an invalid payment hash");
		const base = { ts: new Date().toISOString(), url: url.href, service, wallet: wallet.name,
			amount_sat: quote.amountSat, fee_sat: 0, payment_hash: quote.paymentHash };
		const stop = (outcome: "declined" | "refused", reason: string, approval: Receipt["approval"] = "none") => {
			store.record({ ...base, approval, outcome, reason });
			return json({ status: 402, paid: false, outcome, reason, price_sats: base.amount_sat });
		};
		const expectedNode = manifests.get(url.origin)?.provider?.node_pubkey;
		if (expectedNode && quote.destination && quote.destination !== expectedNode)
			return stop("refused", "invoice pays a different node than the provider's manifest names");
		const spent = spentToday(store.ledger());
		const decision = decide(base.amount_sat, max_sats, spent, policy, FEE_LIMIT_SATS);
		if (decision.kind === "refuse") return stop("refused", decision.reason);
		if (decision.kind === "ask") {
			let denied: string | undefined;
			try {
				denied = await askHuman(`Approve ${base.amount_sat} sats plus up to ${FEE_LIMIT_SATS} sats in fees for ${method} ${url.href} (${service})? ` +
					`Remaining daily allowance: ${Math.max(0, policy.dailyBudgetSats - spent)} sats. ${decision.reason}.`);
			} catch { denied = "approval unavailable or disconnected"; }
			if (denied) return stop("declined", denied, "human");
		}
		const purchase: Purchase = { ...base, approval: decision.kind === "ask" ? "human" : "auto", outcome: "pending",
			key, macaroon: challenge.macaroon, quote, fee_limit_sat: FEE_LIMIT_SATS };
		try { store.reserve(purchase, max_sats, policy); }
		catch (e) { return stop("refused", e instanceof Error ? e.message : "reservation failed"); }
		try {
			const result = await wallet.pay(challenge.invoice, quote, FEE_LIMIT_SATS);
			store.finish(quote.paymentHash, result);
		} catch (e) {
			if (e instanceof PaymentFailed) store.finish(quote.paymentHash, "failed");
			// Transport failures may follow a successful send; only wallet evidence can release the reservation.
			await reconcile();
		}
		const settled = store.purchases().find(p => p.payment_hash === quote.paymentHash)!;
		const credential = store.token(key);
		if (!credential) return paymentState(settled);
		return deliver(credential, { wallet: wallet.name, amount_sat: settled.amount_sat, fee_sat: settled.fee_sat,
			approval: settled.approval, payment_hash: settled.payment_hash,
			spent_today_sat: spentToday(store.ledger()), daily_budget_sat: policy.dailyBudgetSats });
	}),
);

server.registerTool(
	"l402_wallet",
	{
		title: "Wallet and spending",
		description: "Show the wallet backend, spending policy, today's spend, remaining daily budget, balance, and recent receipts.",
		annotations: { readOnlyHint: true },
	},
	async () => {
		await reconcile();
		const ledger = store.ledger();
		const spent = spentToday(ledger);
		return json({
			policy: { auto_approve_sats: policy.autoApproveSats, daily_budget_sats: policy.dailyBudgetSats, fee_limit_sats: FEE_LIMIT_SATS },
			spent_today_sat: spent,
			remaining_today_sat: Math.max(0, policy.dailyBudgetSats - spent),
			wallet: wallet.name,
			balance_sat: await wallet.balanceSat(),
			recent_receipts: ledger.slice(-8).map(r => ({ ts: r.ts, url: r.url, service: r.service, amount_sat: r.amount_sat, fee_sat: r.fee_sat, payment_hash: r.payment_hash, approval: r.approval, outcome: r.outcome, reason: r.reason, proof_of_payment: r.proof_of_payment })),
			reserved_sat: ledger.filter(r => r.outcome === "pending").reduce((sum, r) => sum + r.amount_sat + r.fee_sat, 0),
		});
	},
);

await server.connect(new StdioServerTransport());
