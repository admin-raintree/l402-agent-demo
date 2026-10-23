// MCP server that gives an agent a Lightning wallet (lnd or Wavelength) with a spending policy.
// It discovers L402 services, pays their challenges, reuses paid tokens, asks a
// human (MCP elicitation) above a threshold, and keeps a receipt for every decision.
import { assessResponse, qualitySchema } from "./quality";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { decide, isMainnetInvoice, parseChallenge, type Receipt } from "./policy";
import { PaymentFailed, walletFromEnv } from "./wallet";
import { Store, type Purchase } from "./store";
import { credentialExpiry, periodAt, periodKey, periodStart, subscriptionState, type Subscription } from "./subscription";

const ROOT = resolve(import.meta.dir, "..");
const DEMO = process.env.L402_DEMO_DIR ?? resolve(ROOT, ".demo");
const STATE = process.env.L402_STATE_DIR ?? resolve(DEMO, "agent");
const FEE_LIMIT_SATS = 10;
// Mainnet is untested; real-money invoices are refused unless explicitly allowed.
const ALLOW_MAINNET = process.env.L402_ALLOW_MAINNET === "1";
const policy = {
	autoApproveSats: Number(process.env.L402_AUTO_APPROVE_SATS ?? 100),
	dailyBudgetSats: Number(process.env.L402_DAILY_BUDGET_SATS ?? 5000),
};
if (![policy.autoApproveSats, policy.dailyBudgetSats].every(n => Number.isSafeInteger(n) && n >= 0))
	throw new Error("spending limits must be nonnegative safe integers");
const store = new Store(STATE);

const manifestSchema = z.object({
	provider: z.object({ name: z.string().max(200).optional(), node_pubkey: z.string().regex(/^[0-9a-f]{66}$/i).optional() }).optional(),
	services: z.array(z.object({ name: z.string().min(1).max(200), description: z.string().max(2000).optional(),
		resources: z.array(z.object({ path: z.string().startsWith("/").max(1000), method: z.string().optional(),
			pricing: z.object({ model: z.string(), price_msat: z.number().int().nonnegative().safe().optional() }) })).max(100)
	})).max(100),
});
type Manifest = z.infer<typeof manifestSchema>;
const manifests = new Map<string, Manifest>();
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

const wallet = walletFromEnv(ROOT, DEMO);

async function reconcile() {
	for (const p of store.unresolved()) {
		if (p.wallet !== wallet.name) continue;
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
	const res = await fetch(`${origin}/.well-known/l402.json`, { signal: AbortSignal.timeout(5000), redirect: "error" });
	if (!res.ok) throw new Error(`no L402 manifest at ${origin} (HTTP ${res.status})`);
	const manifest = manifestSchema.parse(await readBody(res));
	manifests.set(origin, manifest);
	return manifest;
}

// Without a manifest, use the name the ledger recorded for this path so a discovery outage never
// changes the key a held credential is stored under.
const serviceFor = (url: URL) =>
	manifests
		.get(url.origin)
		?.services.find((s) => s.resources.some((r) => url.pathname === r.path || url.pathname.startsWith(r.path + "/")))?.name ??
		store.knownService(url.origin, url.pathname) ?? url.pathname;

async function readBody(res: Response): Promise<unknown> {
	const reader = res.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > 64 * 1024) throw new Error("Provider response exceeds 64 KiB");
			chunks.push(value);
		}
	} finally { await reader.cancel(); }
	const text = Buffer.concat(chunks).toString("utf8");
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
	}, { timeout: 150_000 });
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
					url: `${origin}${r.path}`,
					price_sats: r.pricing.model === "fixed" ? (r.pricing.price_msat ?? 0) / 1000 : r.pricing.model,
					description: s.description,
				})),
			),
		});
	},
);

server.registerTool("l402_task_create", {
	title: "Create a task budget",
	description: "Create a fixed lifetime spending cap, including fees. Pass its task_id to every fetch in the task. Does not reserve funds or authorize payments; daily and human-approval limits still apply.",
	inputSchema: { name: z.string().trim().min(1).max(200), budget_sats: z.number().int().positive().safe() },
	annotations: { readOnlyHint: false, openWorldHint: false },
}, async ({ name, budget_sats }) => {
	const task = { id: randomUUID(), name, budget_sats, created_at: new Date().toISOString() };
	store.createTask(task);
	return json({ task_id: task.id, task: store.taskSummary(task.id) });
});

server.registerTool("l402_task", {
	title: "Task spending and receipts",
	description: "Show a task's lifetime settled cost, unresolved reservations, remaining budget, receipts, and response quality assessments. Reconciles pending payments.",
	inputSchema: { task_id: z.string().uuid() },
	annotations: { readOnlyHint: true },
}, async ({ task_id }) => {
	store.task(task_id);
	await reconcile();
	return json(store.taskSummary(task_id));
});

server.registerTool("l402_preview", {
	title: "Preview purchases without paying",
	description: "Estimate a plan from fresh discovery manifests and saved credentials. Only fetches discovery documents; never calls resource endpoints, prepares invoices, pays, prompts, or reserves funds. Estimates are advisory, not approval or a guaranteed quote. Unknown prices need an execution-time invoice check.",
	inputSchema: {
		task_id: z.string().uuid().optional(),
		purchases: z.array(z.object({ url: z.string().url(), method: z.enum(["GET", "POST"]).default("GET"),
			max_sats: z.number().int().positive().safe() })).min(1).max(100),
	},
	annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ task_id, purchases }) => {
	const task = task_id ? store.taskSummary(task_id) : undefined;
	const dailyRemaining = Math.max(0, policy.dailyBudgetSats - store.spentToday());
	const discovered = new Map<string, Manifest | undefined>();
	const items = [];
	for (const item of purchases) {
		const url = new URL(item.url);
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid provider URL");
		if (!discovered.has(url.origin)) discovered.set(url.origin, await discover(url.origin).catch(() => undefined));
		const manifest = discovered.get(url.origin);
		const service = manifest?.services.find(s => s.resources.some(r => url.pathname === r.path || url.pathname.startsWith(r.path + "/")));
		const resource = service?.resources.find(r => (url.pathname === r.path || url.pathname.startsWith(r.path + "/")) && (r.method ?? "GET").toUpperCase() === item.method);
		const serviceName = service?.name ?? store.knownService(url.origin, url.pathname) ?? url.pathname;
		const key = `${url.origin} ${serviceName}`;
		const held = store.serviceCredential(url.origin, serviceName)?.token ?? store.token(key) ?? store.token(`${url.origin} ${url.pathname}`);
		const expiry = held ? credentialExpiry(held) : undefined;
		const reusable = !!held && (expiry === undefined || expiry * 1000 > Date.now());
		const price = resource?.pricing.model === "fixed" && resource.pricing.price_msat !== undefined
			? Math.ceil(resource.pricing.price_msat / 1000) : undefined;
		const estimate = reusable ? 0 : price === undefined ? null : price + FEE_LIMIT_SATS;
		const existing = store.forKey(key);
		const sub = store.subscriptionFor(url.origin, serviceName);
		const decision = !reusable && price !== undefined ? decide(price, item.max_sats,
			policy.dailyBudgetSats - dailyRemaining, policy, FEE_LIMIT_SATS) : undefined;
		items.push({ ...item, service: serviceName, advertised_price_sat: price ?? null,
			credential_reuse_possible: reusable, estimated_max_cost_sat: estimate,
			fee_reserve_sat: reusable ? 0 : FEE_LIMIT_SATS,
			policy_decision: decision?.kind ?? "requires_execution_check",
			reason: decision && "reason" in decision ? decision.reason : undefined,
			task_refusal: estimate === null ? undefined : store.checkTask(task_id, estimate),
			existing_payment_outcome: existing?.outcome, subscription_id: sub?.id,
			note: sub ? "Subscription state, period allowance and credential rejection require execution-time checks." :
				reusable ? "Reuse costs zero if the provider accepts the saved credential." :
				existing ? "Existing payment must be resolved; automatic repayment is blocked." : undefined });
	}
	const knownTotal = items.reduce((sum, item) => sum + (item.estimated_max_cost_sat ?? 0), 0);
	const complete = items.every(item => item.estimated_max_cost_sat !== null);
	return json({ task_id, advisory: true, reserves_funds: false, items,
		known_estimated_max_total_sat: knownTotal, has_unknown_costs: !complete,
		daily_remaining_sat: dailyRemaining, task_remaining_sat: task?.remaining_sat,
		estimate_fits_budgets: complete ? knownTotal <= Math.min(dailyRemaining, task?.remaining_sat ?? Infinity) : null,
		note: "Includes maximum routing fees per purchase. Repeated services are counted separately unless a credential is already saved. Actual invoices, approvals, subscriptions and budgets are checked again when fetching." });
});

server.registerTool(
	"l402_fetch",
	{
		title: "Fetch a paid resource",
		description:
			"Make an HTTP request, paying any L402 Lightning challenge from the agent wallet and reusing a paid token when one exists. " +
			`Payments up to ${policy.autoApproveSats} sats are automatic; larger ones ask the human; anything over max_sats or the ` +
			`${policy.dailyBudgetSats}-sat daily budget is refused. All limits include maximum routing fees. Set max_sats to the most this one call may cost. ` +
			"Pass task_id to enforce a persistent task budget and attribute its receipts. With an l402_subscribe approval for the service, an expired credential renews once per period without asking.",
		inputSchema: {
			url: z.string().url(),
			max_sats: z.number().int().positive().safe().describe("Most this call may spend, in sats"),
			task_id: z.string().uuid().optional(),
			method: z.enum(["GET", "POST"]).default("GET"),
			body: z.string().optional(),
			quality: qualitySchema.optional().describe("Required JSON fields and/or freshness checks; failures never authorize repayment"),
		},
		annotations: { readOnlyHint: false, openWorldHint: true },
	},
	async ({ url: href, max_sats, method, body, task_id, quality }) => serialized(async () => {
		if (task_id) store.task(task_id);
		const url = new URL(href);
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid provider URL");
		if (!manifests.has(url.origin)) await discover(url.origin).catch(() => undefined);
		const service = serviceFor(url);
		let key = `${url.origin} ${service}`;
		// A one-off purchase made while discovery was down is keyed by the pathname instead.
		const pathKey = `${url.origin} ${url.pathname}`;
		await reconcile();
		const call = (authorization?: string) =>
			fetch(url, { method, body, redirect: "error", headers: authorization ? { authorization } : {}, signal: AbortSignal.timeout(15_000) });
		// Record each authenticated attempt separately: reused access may yield different data.
		const assess = (responseBody: unknown, status: number | null, payment: Record<string, unknown> | null, unavailable = false) => {
			const result = assessResponse(responseBody, status, quality, new Date(), unavailable);
			if (payment) {
				const id = randomUUID();
				store.recordResponse({ id, task_id, url: url.href, method, http_status: status,
					payment_hash: typeof payment.payment_hash === "string" ? payment.payment_hash : undefined,
					reused_paid_token: payment.reused_paid_token === true,
					resource_delivered: !unavailable && status !== null && status >= 200 && status < 300, quality: result });
				return { quality: result, response_check_id: id };
			}
			return { quality: result };
		};
		const unavailable = (payment: Record<string, unknown>, status: number | null = null) =>
			json({ paid: true, proof_of_payment: true, resource_delivered: false, payment,
				...assess(undefined, status, payment, true),
				reason: "resource response unavailable; delivery is unknown; automatic repayment blocked" });
		const respond = async (res: Response, payment: Record<string, unknown> | null) => {
			let responseBody: unknown;
			try { responseBody = await readBody(res); }
			catch {
				if (payment) return unavailable(payment, res.status);
				return json({ status: res.status, payment: null, resource_delivered: false, ...assess(undefined, res.status, null, true) });
			}
			return json({ status: res.status, ...(payment ? { paid: true, proof_of_payment: true } : {}),
				resource_delivered: res.ok, payment, body: responseBody, ...assess(responseBody, res.status, payment),
				...(!res.ok && payment ? { reason: "paid credential did not deliver the resource; automatic repayment blocked" } : {}) });
		};
		const deliver = async (authorization: string, payment: Record<string, unknown>) => {
			let res: Response;
			try { res = await call(authorization); }
			catch { return unavailable(payment); }
			return respond(res, payment);
		};
		const sub = store.subscriptionFor(url.origin, service);
		let first: Response | undefined;
		let standing: { sub: Subscription; period: number } | undefined;
		if (sub) {
			const now = new Date();
			const held = store.serviceCredential(sub.origin, sub.service);
			// Try the newest subscription credential, then one bought without a subscription; only when
			// every held credential has provably lapsed may a renewal pay.
			const plain = [key, pathKey].find(k => store.token(k));
			const candidates = [
				...(held ? [{ token: held.token, payment_hash: store.forKey(periodKey(store.subscription(held.subscriptionId), held.period))?.payment_hash,
					subscription_id: held.subscriptionId, period: held.period }] : []),
				...(plain ? [{ token: store.token(plain)!, payment_hash: store.forKey(plain)?.payment_hash, subscription_id: null, period: null }] : []),
			];
			for (const { token, ...ids } of candidates) {
				const validUntil = credentialExpiry(token);
				const reuse = { amount_sat: 0, reused_paid_token: true, ...ids,
					valid_until: validUntil ? new Date(validUntil * 1000).toISOString() : null };
				let res: Response;
				try { res = await call(token); }
				catch { return unavailable(reuse); }
				if (res.status !== 402) return respond(res, reuse);
				const rejected = assess(undefined, res.status, reuse);
				// Only a lapse the credential itself proves can trigger a renewal; an early 402 is a rejection.
				if (validUntil === undefined || now.getTime() < validUntil * 1000)
					return json({ status: 402, paid: true, resource_delivered: false, payment: reuse, ...rejected,
						reason: "subscription credential rejected before its expiry; automatic repayment blocked" });
				first = res;
			}
			// A payment still in flight may deliver a credential; never pay for the service alongside it.
			const unresolved = store.pendingFor(url.origin, [service, url.pathname]);
			if (unresolved) return paymentState(unresolved);
			const state = subscriptionState(sub, now);
			if (state !== "active")
				return json({ status: 402, paid: false, outcome: "refused", subscription_id: sub.id,
					reason: `subscription ${state}; no renewal${state === "scheduled" ? "" : ". Use l402_subscribe to approve a new subscription"}` });
			const period = periodAt(sub, now)!;
			key = periodKey(sub, period);
			const existing = store.forKey(key);
			if (existing?.outcome === "paid" && held?.subscriptionId === sub.id && held.period === period)
				return json({ status: 402, paid: false, outcome: "refused", subscription_id: sub.id,
					reason: `already renewed for period ${period}; the next renewal can start at ${periodStart(sub, period + 1).toISOString()}` });
			if (existing) return paymentState(existing);
			standing = { sub, period };
		} else {
			const heldKey = [key, pathKey].find(k => store.token(k));
			if (heldKey) return deliver(store.token(heldKey)!, { amount_sat: 0, reused_paid_token: true, payment_hash: store.forKey(heldKey)?.payment_hash });
			const existing = store.forKey(key) ?? store.forKey(pathKey);
			if (existing) return paymentState(existing);
		}

		first ??= await call();
		if (first.status !== 402) return respond(first, null);
		const challenge = parseChallenge(first.headers.get("www-authenticate"));
		if (!challenge) return json({ status: 402, paid: false, error: "402 response without an L402 challenge" });
		if (isMainnetInvoice(challenge.invoice) && !ALLOW_MAINNET)
			return json({ status: 402, paid: false, outcome: "refused",
				reason: "mainnet invoice refused: this wallet is tested only on test networks (set L402_ALLOW_MAINNET=1 to override)" });
		const quote = await wallet.quote(challenge.invoice, FEE_LIMIT_SATS);
		if (!/^[0-9a-f]{64}$/.test(quote.paymentHash)) throw new Error("wallet returned an invalid payment hash");
		const base = { ts: new Date().toISOString(), task_id, url: url.href, service, wallet: wallet.name,
			amount_sat: quote.amountSat, fee_sat: 0, payment_hash: quote.paymentHash };
		const stop = (outcome: "declined" | "refused", reason: string, approval: Receipt["approval"] = "none") => {
			store.record({ ...base, approval, outcome, reason, subscription_id: standing?.sub.id });
			return json({ status: 402, paid: false, outcome, reason, price_sats: base.amount_sat });
		};
		const expectedNode = standing?.sub.nodePubkey ?? manifests.get(url.origin)?.provider?.node_pubkey;
		if (expectedNode && quote.destination && quote.destination !== expectedNode)
			return stop("refused", "invoice pays a different node than the provider's manifest names");
		const maxSats = standing ? Math.min(max_sats, standing.sub.capSat) : max_sats;
		const spent = store.spentToday();
		const decision = decide(base.amount_sat, maxSats, spent, policy, FEE_LIMIT_SATS);
		if (decision.kind === "refuse") return stop("refused", decision.reason);
		const taskRefusal = store.checkTask(task_id, base.amount_sat + FEE_LIMIT_SATS);
		if (taskRefusal) return stop("refused", taskRefusal);
		if (decision.kind === "ask" && !standing) {
			let denied: string | undefined;
			try {
				denied = await askHuman(`Pay ${base.amount_sat} sats plus up to ${FEE_LIMIT_SATS} sats in fees for ${method} ${url.href} (${service})? ` +
					`That is above your ${policy.autoApproveSats}-sat auto-approval limit. ${Math.max(0, policy.dailyBudgetSats - spent).toLocaleString("en-US")} sats remain in today's budget.`);
			} catch { denied = "approval unavailable or disconnected"; }
			if (denied) return stop("declined", denied, "human");
		}
		const purchase: Purchase = { ...base, approval: standing ? "standing" : decision.kind === "ask" ? "human" : "auto", outcome: "pending",
			key, macaroon: challenge.macaroon, quote, fee_limit_sat: FEE_LIMIT_SATS,
			...(standing ? { subscription: { id: standing.sub.id, period: standing.period } } : {}) };
		try { store.reserve(purchase, maxSats, policy); }
		catch (e) { return stop("refused", e instanceof Error ? e.message : "reservation failed"); }
		try {
			const result = await wallet.pay(challenge.invoice, quote, FEE_LIMIT_SATS);
			store.finish(quote.paymentHash, result);
		} catch (e) {
			if (e instanceof PaymentFailed) store.finish(quote.paymentHash, "failed");
			// Transport failures may follow a successful send; only wallet evidence can release the reservation.
			await reconcile();
		}
		const settled = store.purchase(quote.paymentHash)!;
		const credential = store.token(key);
		if (!credential) return paymentState(settled);
		return deliver(credential, { task_id, wallet: wallet.name, amount_sat: settled.amount_sat, fee_sat: settled.fee_sat,
			approval: settled.approval, payment_hash: settled.payment_hash,
			...(standing ? { subscription_id: standing.sub.id, period: standing.period,
				valid_until: (v => v ? new Date(v * 1000).toISOString() : null)(credentialExpiry(credential)) } : {}),
			spent_today_sat: store.spentToday(), daily_budget_sat: policy.dailyBudgetSats });
	}),
);

function describeSubscription(sub: Subscription, now = new Date()) {
	const period = periodAt(sub, now);
	const held = store.subscriptionToken(sub);
	const validUntil = held && credentialExpiry(held.token);
	return { id: sub.id, origin: sub.origin, service: sub.service, node_pubkey: sub.nodePubkey ?? null,
		cap_sats_per_period: sub.capSat, period_seconds: sub.periodSeconds, periods: sub.periods,
		starts_at: sub.startsAt, ends_at: periodStart(sub, sub.periods).toISOString(), state: subscriptionState(sub, now),
		current_period: period ?? null, current_period_spent_sat: period === undefined ? 0 : store.periodSpent(sub.id, period),
		credential_period: held?.period ?? null, credential_valid_until: validUntil ? new Date(validUntil * 1000).toISOString() : null,
		cancelled_at: sub.cancelledAt ?? null };
}

server.registerTool(
	"l402_subscribe",
	{
		title: "Approve a subscription",
		description:
			"Ask the human once for a standing approval: up to cap_sats_per_period (including maximum routing fees) per period " +
			"to one provider's service, for a fixed number of periods. Later l402_fetch calls renew an expired credential within " +
			"that approval without prompting. At most one renewal is paid per period; the daily budget still applies.",
		inputSchema: {
			url: z.string().url().describe("A resource URL on the provider; its service is subscribed"),
			cap_sats_per_period: z.number().int().positive().describe("Most one period may cost, including maximum fees"),
			periods: z.number().int().min(1).max(120).describe("Number of periods the approval covers"),
			period_seconds: z.number().int().min(1).max(31_536_000).default(2_592_000).describe("Period length; defaults to 30 days"),
		},
		annotations: { readOnlyHint: false, openWorldHint: true },
	},
	async ({ url: href, cap_sats_per_period, periods, period_seconds }) => serialized(async () => {
		const url = new URL(href);
		const manifest = await discover(url.origin);
		const service = serviceFor(url);
		const resource = manifest.services.find(s => s.name === service)?.resources
			.find(r => url.pathname === r.path || url.pathname.startsWith(r.path + "/"));
		if (!resource) throw new Error("the provider's manifest does not list this resource");
		const existing = store.subscriptionFor(url.origin, service);
		if (existing && ["active", "scheduled"].includes(subscriptionState(existing, new Date())))
			throw new Error(`subscription ${existing.id} already covers this service; cancel it first`);
		if (cap_sats_per_period > policy.dailyBudgetSats)
			throw new Error(`a ${cap_sats_per_period}-sat renewal could never fit the ${policy.dailyBudgetSats}-sat daily budget`);
		const price = resource.pricing.model === "fixed" && resource.pricing.price_msat !== undefined ? Math.ceil(resource.pricing.price_msat / 1000) : undefined;
		if (price !== undefined && price + FEE_LIMIT_SATS > cap_sats_per_period)
			throw new Error(`advertised price ${price} sats plus ${FEE_LIMIT_SATS} sats maximum fees exceeds the cap`);
		const every = period_seconds % 86_400 ? `${period_seconds} seconds` : `${period_seconds / 86_400} days`;
		let denied: string | undefined;
		try {
			denied = await askHuman(`Approve a subscription to ${service} at ${url.origin}: up to ${cap_sats_per_period} sats (including fees) ` +
				`every ${every} for ${periods} periods, at most ${cap_sats_per_period * periods} sats in total? ` +
				`Advertised price: ${price ?? "unknown"} sats. Renewals will not ask again; you can cancel at any time.`);
		} catch { denied = "approval unavailable or disconnected"; }
		if (denied) return json({ subscribed: false, reason: denied });
		const now = new Date();
		const sub: Subscription = { id: randomUUID(), origin: url.origin, service, nodePubkey: manifest.provider?.node_pubkey,
			capSat: cap_sats_per_period, periodSeconds: period_seconds, periods, startsAt: now.toISOString(), createdAt: now.toISOString(), status: "active" };
		store.createSubscription(sub);
		return json({ subscribed: true, subscription: describeSubscription(sub, now) });
	}),
);

server.registerTool(
	"l402_subscriptions",
	{
		title: "List or cancel subscriptions",
		description: "List standing approvals with their current period, spend, and credential expiry. Pass cancel to stop future renewals; " +
			"a credential already paid for stays usable until it expires.",
		inputSchema: { cancel: z.string().uuid().optional().describe("Subscription id to cancel") },
		annotations: { readOnlyHint: false },
	},
	async ({ cancel }) => serialized(async () => {
		if (cancel) store.cancelSubscription(cancel);
		return json({ subscriptions: store.subscriptions().map(s => describeSubscription(s)) });
	}),
);

server.registerTool(
	"l402_wallet",
	{
		title: "Wallet and spending",
		description: "Show the wallet backend, spending policy, today's spend, remaining daily budget, balance, recent receipts, and response quality assessments.",
		annotations: { readOnlyHint: true },
	},
	async () => {
		await reconcile();
		const spent = store.spentToday();
		return json({
			policy: { auto_approve_sats: policy.autoApproveSats, daily_budget_sats: policy.dailyBudgetSats, fee_limit_sats: FEE_LIMIT_SATS },
			spent_today_sat: spent,
			remaining_today_sat: Math.max(0, policy.dailyBudgetSats - spent),
			wallet: wallet.name,
			balance_sat: await wallet.balanceSat(),
			recent_response_checks: store.responseChecks(),
			recent_receipts: store.recentReceipts(8).map(r => ({ ts: r.ts, task_id: r.task_id, url: r.url, service: r.service, amount_sat: r.amount_sat, fee_sat: r.fee_sat, payment_hash: r.payment_hash, approval: r.approval, outcome: r.outcome, reason: r.reason, proof_of_payment: r.proof_of_payment })),
			reserved_sat: store.reservedSat(),
		});
	},
);

await server.connect(new StdioServerTransport());
