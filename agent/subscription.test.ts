import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Store, type Purchase } from "./store";
import { spentToday } from "./policy";
import { credentialExpiry, macaroonCaveats, periodAt, periodKey, subscriptionState, type Subscription } from "./subscription";

const start = new Date("2026-10-01T00:00:00Z");
const day = 86_400_000;
const at = (days: number) => new Date(start.getTime() + days * day);
const policy = { autoApproveSats: 0, dailyBudgetSats: 1000 };
const sub: Subscription = { id: "sub", origin: "https://provider.test", service: "report", nodePubkey: "02" + "aa".repeat(32),
	capSat: 60, periodSeconds: 30 * 86_400, periods: 3, startsAt: start.toISOString(), createdAt: start.toISOString(), status: "active" };
const proofFor = (n: number) => n.toString(16).padStart(64, "0");
const hashFor = (n: number) => createHash("sha256").update(Buffer.from(proofFor(n), "hex")).digest("hex");
function renewal(n: number, period: number, amount = 50, over: Partial<Purchase> = {}): Purchase {
	return { ts: start.toISOString(), url: "https://provider.test/v1/report", service: "report", key: periodKey(sub, period), macaroon: "secret",
		wallet: "lnd", amount_sat: amount, fee_sat: 0, payment_hash: hashFor(n), approval: "standing", outcome: "pending",
		quote: { paymentHash: hashFor(n), amountSat: amount, destination: sub.nodePubkey }, fee_limit_sat: 10,
		subscription: { id: "sub", period }, ...over };
}
function fixture(run: (store: Store, dir: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "l402-sub-"));
	const store = new Store(dir);
	store.createSubscription(sub);
	try { run(store, dir); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

/** Version-2 binary macaroon with first-party caveats, in the layout Aperture mints. */
function macaroon(id: string, caveats: string[]): string {
	const varint = (n: number) => { const out = []; while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n >>>= 7; } out.push(n); return Buffer.from(out); };
	const field = (type: number, value: Buffer) => Buffer.concat([Buffer.from([type]), varint(value.length), value]);
	const eos = Buffer.from([0]);
	return Buffer.concat([Buffer.from([2]), field(1, Buffer.from("lsat")), field(2, Buffer.from(id)), eos,
		...caveats.flatMap(c => [field(2, Buffer.from(c)), eos]), eos, field(6, Buffer.alloc(32))]).toString("base64");
}

test("periods run from the approval, not the seller's credential", () => {
	expect(periodAt(sub, at(-1))).toBeUndefined();
	expect(periodAt(sub, at(0))).toBe(0);
	expect(periodAt(sub, at(29.99))).toBe(0);
	expect(periodAt(sub, at(30))).toBe(1);
	expect(periodAt(sub, at(90))).toBeUndefined();
	expect([at(-1), at(45), at(90)].map(d => subscriptionState(sub, d))).toEqual(["scheduled", "active", "expired"]);
	expect(subscriptionState({ ...sub, status: "cancelled" }, at(45))).toBe("cancelled");
});

test("reads the earliest valid_until caveat and fails closed on malformed macaroons", () => {
	const m = macaroon("x".repeat(200), ["services=report:0", "report_valid_until=1790000000", "report_valid_until=1780000000"]);
	expect(macaroonCaveats(m)).toEqual(["services=report:0", "report_valid_until=1790000000", "report_valid_until=1780000000"]);
	expect(credentialExpiry(`L402 ${m}:${proofFor(1)}`)).toBe(1780000000);
	expect(credentialExpiry(`L402 ${macaroon("id", ["services=report:0"])}:${proofFor(1)}`)).toBeUndefined();
	for (const bad of ["", "AQ==", m.slice(0, 20), "not base64!"]) expect(credentialExpiry(`L402 ${bad}:${proofFor(1)}`)).toBeUndefined();
});

test("standing approval replaces the prompt but not the cap, fees, or daily budget", () => fixture(store => {
	expect(() => store.reserve({ ...renewal(1, 0), approval: "human", subscription: undefined, key: "plain" }, 100, policy, at(1))).not.toThrow();
	store.finish(hashFor(1), "failed", at(1));
	expect(() => store.reserve(renewal(2, 0, 51), 100, policy, at(1))).toThrow("60-sat cap for period 0");
	expect(() => store.reserve(renewal(2, 0), 100, { ...policy, dailyBudgetSats: 59 }, at(1))).toThrow("daily budget");
	expect(() => store.reserve({ ...renewal(2, 0), subscription: undefined, key: "plain" }, 100, policy, at(1))).toThrow("requires a subscription");
	store.reserve(renewal(2, 0), 100, policy, at(1));
	expect(store.periodSpent("sub", 0)).toBe(60);
	store.finish(hashFor(2), { feeSat: 2, preimage: proofFor(2) }, at(1));
	expect(store.periodSpent("sub", 0)).toBe(52);
	expect(store.ledger().at(-1)).toMatchObject({ approval: "standing", subscription_id: "sub", outcome: "paid", fee_sat: 2 });
	expect(store.subscriptionToken(sub)).toEqual({ token: `L402 secret:${proofFor(2)}`, period: 0 });
}));

test("one renewal per period; pending blocks it and a confirmed failure frees it", () => fixture((store, dir) => {
	store.reserve(renewal(1, 0, 10), 100, policy, at(1));
	expect(() => store.reserve(renewal(2, 0, 10), 100, policy, at(2))).toThrow("already recorded");
	// The renewals key is the database-level backstop for any path that skips the purchase-key check.
	expect(() => store.db.query("INSERT INTO renewals VALUES ('sub', 0, 'other')").run()).toThrow("UNIQUE");
	const reopened = new Store(dir);
	try {
		expect(() => reopened.reserve(renewal(2, 0, 10), 100, policy, at(2))).toThrow("already recorded");
		expect(spentToday(reopened.ledger(), at(40))).toBe(20); // unresolved reservations count on every day
		reopened.finish(hashFor(1), "failed", at(2));
		reopened.reserve(renewal(2, 0, 10), 100, policy, at(2));
		reopened.finish(hashFor(2), { feeSat: 0, preimage: proofFor(2) }, at(2));
		expect(() => reopened.reserve(renewal(3, 0, 10), 100, policy, at(29))).toThrow("already recorded");
		reopened.reserve(renewal(3, 1, 10), 100, policy, at(31));
		expect(reopened.periodSpent("sub", 0)).toBe(10);
		expect(reopened.periodSpent("sub", 1)).toBe(20);
	} finally { reopened.close(); }
}));

test("renewals must match the subscription's provider, service, node, period, and key", () => fixture(store => {
	const cases: [Partial<Purchase>, string][] = [
		[{ url: "https://evil.test/v1/report" }, "different provider"],
		[{ service: "hashprice" }, "different provider or service"],
		[{ quote: { paymentHash: hashFor(1), amountSat: 50, destination: "03" + "bb".repeat(32) } }, "different node"],
		[{ subscription: { id: "sub", period: 1 }, key: periodKey(sub, 1) }, "outside the current subscription period"],
		[{ key: "https://provider.test report" }, "does not match"],
		[{ approval: "auto" }, "does not match"],
		[{ subscription: { id: "missing", period: 0 } }, "Unknown subscription"],
	];
	for (const [over, error] of cases) expect(() => store.reserve(renewal(1, 0, 50, over), 100, policy, at(1))).toThrow(error);
	expect(store.ledger()).toHaveLength(0);
	expect(store.db.query("SELECT COUNT(*) AS n FROM renewals").get()).toEqual({ n: 0 });
}));

test("cancellation and expiry stop renewals; paid history survives", () => fixture(store => {
	store.reserve(renewal(1, 0), 100, policy, at(1));
	store.finish(hashFor(1), { feeSat: 0, preimage: proofFor(1) }, at(1));
	expect(() => store.reserve(renewal(2, 3), 100, policy, at(91))).toThrow("subscription expired");
	store.cancelSubscription("sub", at(10));
	store.cancelSubscription("sub", at(20));
	expect(store.subscription("sub")).toMatchObject({ status: "cancelled", cancelledAt: at(10).toISOString() });
	expect(() => store.reserve(renewal(2, 1), 100, policy, at(31))).toThrow("subscription cancelled");
	expect(store.subscriptionToken(store.subscription("sub"))?.period).toBe(0);
	expect(store.subscriptionFor(sub.origin, sub.service)?.id).toBe("sub");
}));

test("independent processes cannot renew the same period twice", async () => {
	const dir = mkdtempSync(join(tmpdir(), "l402-sub-race-"));
	const store = new Store(dir);
	try {
		store.createSubscription({ ...sub, capSat: 1000 });
		const workers = Array.from({ length: 8 }, (_, i) => Bun.spawn([process.execPath, "-e", `import { Store } from ${JSON.stringify(join(import.meta.dir, "store.ts"))};
			const store = new Store(${JSON.stringify(dir)});
			try { store.reserve(${JSON.stringify(renewal(i + 1, 0, 20))}, 1000, ${JSON.stringify(policy)}, new Date(${JSON.stringify(at(1).toISOString())})); process.stdout.write("reserved"); }
			catch { process.stdout.write("refused"); } finally { store.close(); }`], { stdout: "pipe", stderr: "pipe" }));
		const results = await Promise.all(workers.map(async p => { expect(await p.exited).toBe(0); return new Response(p.stdout).text(); }));
		expect(results.filter(r => r === "reserved")).toHaveLength(1);
		expect(store.periodSpent("sub", 0)).toBe(30);
	} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

async function provider(timeoutSeconds: number) {
	const dir = mkdtempSync(join(tmpdir(), "l402-sub-mcp-"));
	const minted = new Map<string, { proof: string; validUntil: number }>();
	const entries: Record<string, unknown>[] = [];
	const state = { sends: 0, prompts: 0, reject: false };
	let invoices = 0;
	const gateway = Bun.serve({ port: 0, async fetch(req) {
		const path = new URL(req.url).pathname;
		if (path === "/.well-known/l402.json") return Response.json({ services: [{ name: "data", resources: [{ path: "/data", pricing: { model: "fixed", price_msat: 20_000 } }] }] });
		if (path === "/data") {
			const [mac, proof] = (req.headers.get("authorization") ?? "").replace("L402 ", "").split(":");
			const credential = minted.get(mac);
			if (credential && credential.proof === proof && Date.now() < credential.validUntil * 1000 && !state.reject) return new Response("resource");
			// Aperture's timeout caveat: mint time plus the service timeout, in whole Unix seconds.
			const n = ++invoices;
			const m = macaroon(`id-${n}`, ["services=data:0", `data_valid_until=${Math.floor(Date.now() / 1000) + timeoutSeconds}`]);
			minted.set(m, { proof: proofFor(n), validUntil: Number(macaroonCaveats(m)[1].split("=")[1]) });
			return new Response("pay", { status: 402, headers: { "www-authenticate": `L402 macaroon="${m}", invoice="inv-${n}"` } });
		}
		if (path.endsWith("/prepare-send")) {
			const n = Number(((await req.json()) as { invoice: string }).invoice.slice(4));
			return Response.json({ send_intent_id: `intent-${n}`, amount_sat: "20", payment_hash: hashFor(n), rail: "SEND_RAIL_LIGHTNING" });
		}
		if (path.endsWith("/send")) {
			const n = Number(((await req.json()) as { send_intent_id: string }).send_intent_id.slice(7));
			state.sends++;
			entries.push({ id: hashFor(n), status: "ENTRY_STATUS_COMPLETE", fee_sat: "1", progress: { payment_hash: hashFor(n), preimage: proofFor(n) } });
			return Response.json({});
		}
		if (path.endsWith("/list")) return Response.json({ activity: { entries } });
		if (path.endsWith("/balance")) return Response.json({ confirmed_sat: "1000" });
		return new Response("missing", { status: 404 });
	} });
	const client = new Client({ name: "subscription-test", version: "0" }, { capabilities: { elicitation: {} } });
	let approve = true;
	client.setRequestHandler(ElicitRequestSchema, async () => { state.prompts++; return { action: "accept", content: { approve } }; });
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(import.meta.dir, "server.ts")], stderr: "pipe", env: {
		...process.env as Record<string, string>, L402_STATE_DIR: dir, L402_WALLET: "wavelength", WAVELENGTH_URL: gateway.url.toString().replace(/\/$/, ""),
		L402_DAILY_BUDGET_SATS: "1000", L402_AUTO_APPROVE_SATS: "0",
	} }));
	const url = new URL("data", gateway.url).href;
	return { state, url, set approve(v: boolean) { approve = v; },
		async call(name: string, args: Record<string, unknown> = { url, max_sats: 100 }) {
			const r = await client.callTool({ name, arguments: args });
			if (r.isError) throw new Error((r.content as { text: string }[])[0].text);
			return JSON.parse((r.content as { text: string }[])[0].text);
		},
		async close() { await client.close(); gateway.stop(true); rmSync(dir, { recursive: true, force: true }); } };
}
const until = (iso: string, extraMs = 200) => Bun.sleep(Math.max(0, Date.parse(iso) - Date.now()) + extraMs);

test("MCP subscription: one prompt, lazy renewal per period, early 402 blocked, cancellation honored", async () => {
	const f = await provider(3);
	const sub = { url: f.url, cap_sats_per_period: 31, periods: 3, period_seconds: 6 };
	try {
		const { subscription } = await f.call("l402_subscribe", sub);
		expect(f.state.prompts).toBe(1);
		const first = await f.call("l402_fetch");
		expect(first).toMatchObject({ resource_delivered: true, payment: { approval: "standing", period: 0, amount_sat: 20, fee_sat: 1 } });
		expect((await f.call("l402_fetch")).payment).toMatchObject({ reused_paid_token: true, period: 0 });
		f.state.reject = true;
		expect((await f.call("l402_fetch")).reason).toContain("rejected before its expiry");
		f.state.reject = false;
		await until(first.payment.valid_until);
		expect((await f.call("l402_fetch")).reason).toContain("already renewed for period 0");
		await until(new Date(Date.parse(subscription.starts_at) + 6000).toISOString(), 100);
		expect((await f.call("l402_fetch")).payment).toMatchObject({ approval: "standing", period: 1 });
		expect(f.state).toMatchObject({ sends: 2, prompts: 1 });
		const listed = await f.call("l402_subscriptions", { cancel: subscription.id });
		expect(listed.subscriptions[0]).toMatchObject({ state: "cancelled", current_period: 1, current_period_spent_sat: 21, credential_period: 1 });
		const reused = await f.call("l402_fetch");
		expect(reused.payment).toMatchObject({ reused_paid_token: true, period: 1 });
		await until(reused.payment.valid_until);
		expect((await f.call("l402_fetch")).reason).toMatch(/^subscription cancelled; no renewal\. Use l402_subscribe/);
		expect(f.state).toMatchObject({ sends: 2, prompts: 1 });

		// A new approval starts its own periods and pays for the lapsed credential.
		const second = (await f.call("l402_subscribe", sub)).subscription;
		const renewed = await f.call("l402_fetch");
		expect(renewed.payment).toMatchObject({ approval: "standing", subscription_id: second.id, period: 0 });
		expect(f.state).toMatchObject({ sends: 3, prompts: 2 });
		// Re-subscribing while a paid credential is still valid reuses it instead of paying again.
		await f.call("l402_subscriptions", { cancel: second.id });
		const third = (await f.call("l402_subscribe", sub)).subscription;
		const kept = await f.call("l402_fetch");
		expect(kept.payment).toMatchObject({ reused_paid_token: true, subscription_id: second.id });
		expect(f.state).toMatchObject({ sends: 3, prompts: 3 });
		expect((await f.call("l402_subscriptions", {})).subscriptions.map((s: { id: string; state: string }) => [s.id, s.state]))
			.toEqual([[third.id, "active"], [second.id, "cancelled"], [subscription.id, "cancelled"]]);
	} finally { await f.close(); }
}, 40_000);

test("MCP subscription: a declined approval or an inadequate cap creates nothing", async () => {
	const f = await provider(60);
	try {
		f.approve = false;
		expect((await f.call("l402_subscribe", { url: f.url, cap_sats_per_period: 30, periods: 2 })).subscribed).toBe(false);
		await expect(f.call("l402_subscribe", { url: f.url, cap_sats_per_period: 29, periods: 2 })).rejects.toThrow("exceeds the cap");
		await expect(f.call("l402_subscribe", { url: f.url, cap_sats_per_period: 1001, periods: 2 })).rejects.toThrow("daily budget");
		expect((await f.call("l402_subscriptions", {})).subscriptions).toEqual([]);
		expect((await f.call("l402_fetch")).outcome).toBe("declined"); // without a subscription, the normal prompt applies
		expect(f.state.sends).toBe(0);
	} finally { await f.close(); }
});

test("standing renewals also enforce lifetime task budgets without consuming a refused period", () => fixture(store => {
	store.createTask({ id: "task", name: "Report", budget_sats: 60, created_at: start.toISOString() });
	store.reserve(renewal(1, 0, 50, { task_id: "task" }), 100, policy, at(1));
	store.finish(hashFor(1), { feeSat: 2, preimage: proofFor(1) }, at(1));
	expect(store.taskSummary("task").settled_sat).toBe(52);
	expect(() => store.reserve(renewal(2, 1, 10, { task_id: "task" }), 100, policy, at(31))).toThrow("task budget");
	expect(store.periodSpent("sub", 1)).toBe(0);
	expect(store.ledger()).toHaveLength(1);
}));

test("subscription purchases, reuse and early credential rejection retain response quality history", async () => {
	const f = await provider(30);
	try {
		await f.call("l402_subscribe", { url: f.url, cap_sats_per_period: 31, periods: 2, period_seconds: 60 });
		const args = { url: f.url, max_sats: 100, quality: { required_fields: ["price"] } };
		const first = await f.call("l402_fetch", args);
		const reuse = await f.call("l402_fetch", args);
		expect(first.quality.usable).toBe(false);
		expect(reuse.quality.usable).toBe(false);
		expect(reuse.payment.payment_hash).toBe(first.payment.payment_hash);
		f.state.reject = true;
		const rejected = await f.call("l402_fetch", args);
		expect(rejected.quality.reasons).toEqual(["http_status:402"]);
		const wallet = await f.call("l402_wallet", {});
		expect(wallet.recent_response_checks).toHaveLength(3);
		expect(wallet.recent_response_checks.every((r: { payment_hash: string }) => r.payment_hash === first.payment.payment_hash)).toBe(true);
		expect(wallet.spent_today_sat).toBe(21);
		expect(f.state.sends).toBe(1);
	} finally { await f.close(); }
});
