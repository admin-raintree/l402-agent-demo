import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "l402-mcp-"));
	let sends = 0;
	let resourceCalls = 0;
	let prepares = 0;
	let price = 20;
	let responseStatus = 200;
	let responseBody = "resource";
	let failResource = false;
	let invalidProof = false;
	let dropResponse = false;
	let blockSend = false;
	let pending = false;
	let blockLookup = false;
	let lookupStarted = false;
	let rail = "SEND_RAIL_LIGHTNING";
	let invoice = "invoice";
	let sendStarted: (() => void) | undefined;
	let releaseSend: (() => void) | undefined;
	const proof = "11".repeat(32);
	const hash = createHash("sha256").update(Buffer.from(proof, "hex")).digest("hex");
	const entries: Record<string, unknown>[] = [];
	const gateway = Bun.serve({ port: 0, async fetch(req) {
		const path = new URL(req.url).pathname;
		if (path === "/.well-known/l402.json") return Response.json({ services: [{ name: "data", resources: [{ path: "/data", pricing: { model: "fixed", price_msat: price * 1000 } }] }] });
		if (path === "/data") {
			resourceCalls++;
			if (req.headers.get("authorization") === `L402 macaroon:${proof}`) {
				if (failResource) return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1" } });
				return new Response(responseBody, { status: responseStatus });
			}
			return new Response("pay", { status: 402, headers: { "www-authenticate": `L402 macaroon="macaroon", invoice="${invoice}"` } });
		}
		if (path.endsWith("/prepare-send")) { prepares++; return Response.json({ send_intent_id: "intent", amount_sat: String(price), payment_hash: hash, rail }); }
		if (path.endsWith("/send")) {
			sends++;
			entries.push({ id: hash, status: pending ? "ENTRY_STATUS_PENDING" : "ENTRY_STATUS_COMPLETE", fee_sat: "3", progress: { payment_hash: hash, preimage: invalidProof ? "22".repeat(32) : proof } });
			sendStarted?.();
			if (blockSend) await new Promise<void>(resolve => { releaseSend = resolve; });
			if (dropResponse) return new Response("response lost", { status: 503 });
			return Response.json({});
		}
		if (path.endsWith("/list")) {
			lookupStarted = true;
			if (blockLookup) return new Response("unavailable", { status: 503 });
			return Response.json({ activity: { entries } });
		}
		if (path.endsWith("/balance")) return Response.json({ confirmed_sat: "1000" });
		return new Response("missing", { status: 404 });
	} });
	const clients: { client: Client; transport: StdioClientTransport }[] = [];
	async function connect(answer: "approve" | "decline" | "cancel" | "unsupported" | "disconnect" = "approve", budget = 100, auto = 100, extraEnv: Record<string, string> = {}) {
		const client = new Client({ name: "fault-test", version: "0" }, { capabilities: answer === "unsupported" ? {} : { elicitation: {} } });
		const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(import.meta.dir, "server.ts")], stderr: "pipe", env: {
			...process.env as Record<string, string>, L402_STATE_DIR: dir, L402_WALLET: "wavelength", WAVELENGTH_URL: gateway.url.toString().replace(/\/$/, ""),
			L402_DAILY_BUDGET_SATS: String(budget), L402_AUTO_APPROVE_SATS: String(auto), ...extraEnv,
		} });
		if (answer !== "unsupported") client.setRequestHandler(ElicitRequestSchema, async () => {
			if (answer === "disconnect") { process.kill(transport.pid!, "SIGKILL"); throw new Error("client disconnected"); }
			return answer === "cancel" ? { action: "cancel" } : { action: "accept", content: { approve: answer === "approve" } };
		});
		await client.connect(transport);
		clients.push({ client, transport });
		return { client, transport, async call(name = "l402_fetch", args: Record<string, unknown> = { url: new URL("data", gateway.url).href, max_sats: 100 }) {
			const r = await client.callTool({ name, arguments: name === "l402_wallet" ? {} : args });
			if (r.isError) throw new Error((r.content as { text: string }[])[0].text);
			return JSON.parse((r.content as { text: string }[])[0].text);
		} };
	}
	return { connect, entries, hash, url: new URL("data", gateway.url).href,
		get resourceCalls() { return resourceCalls; }, get prepares() { return prepares; }, get sends() { return sends; }, get lookupStarted() { return lookupStarted; },
		set responseBody(v: string) { responseBody = v; }, set failResource(v: boolean) { failResource = v; },
		set price(v: number) { price = v; }, set responseStatus(v: number) { responseStatus = v; }, set invalidProof(v: boolean) { invalidProof = v; },
		set dropResponse(v: boolean) { dropResponse = v; }, set blockSend(v: boolean) { blockSend = v; }, set blockLookup(v: boolean) { blockLookup = v; },
		set pending(v: boolean) { pending = v; }, set rail(v: string) { rail = v; }, set invoice(v: string) { invoice = v; },
		onSend: () => new Promise<void>(resolve => { sendStarted = resolve; }),
		async close() { releaseSend?.(); for (const c of clients) await c.client.close(); gateway.stop(true); rmSync(dir, { recursive: true, force: true }); } };
}

test("MCP concurrent clients share reservations and pay once", async () => {
	const f = await setup();
	try {
		const [a, b] = await Promise.all([f.connect(), f.connect()]);
		const results = await Promise.all([a.call(), b.call()]);
		expect(f.sends).toBe(1);
		expect(results.some(r => r.resource_delivered)).toBe(true);
		const wallet = await a.call("l402_wallet");
		expect(wallet.spent_today_sat).toBe(23);
		expect(JSON.stringify(wallet)).not.toContain("macaroon");
		expect(wallet.reserved_sat).toBe(0);
	} finally { await f.close(); }
});

test("lost send response reconciles without paying again", async () => {
	const f = await setup();
	try {
		f.dropResponse = true;
		const a = await f.connect();
		expect((await a.call()).resource_delivered).toBe(true);
		expect((await a.call()).payment.reused_paid_token).toBe(true);
		expect(f.sends).toBe(1);
	} finally { await f.close(); }
});

for (const stage of ["after-send", "during-lookup", "after-settlement"] as const) test(`SIGKILL ${stage}: restart recovers proof and never resends`, async () => {
	const f = await setup();
	try {
		const a = await f.connect();
		if (stage === "after-settlement") await a.call();
		else {
			f.blockSend = stage === "after-send";
			f.blockLookup = stage === "during-lookup";
			const sent = f.onSend();
			const call = a.call().catch(() => undefined);
			await sent;
			if (stage === "during-lookup") {
				for (let i = 0; i < 100 && !f.lookupStarted; i++) await Bun.sleep(5);
				expect(f.lookupStarted).toBe(true);
			}
			process.kill(a.transport.pid!, "SIGKILL");
			await call;
		}
		if (stage === "after-settlement") process.kill(a.transport.pid!, "SIGKILL");
		f.blockLookup = false;
		const b = await f.connect();
		expect((await b.call()).resource_delivered).toBe(true);
		expect(f.sends).toBe(1);
		expect((await b.call("l402_wallet")).spent_today_sat).toBe(23);
	} finally { await f.close(); }
});

for (const answer of ["decline", "cancel", "unsupported", "disconnect"] as const) test(`${answer} approval sends nothing`, async () => {
	const f = await setup();
	try {
		const a = await f.connect(answer, 100, 10);
		if (answer === "disconnect") await expect(a.call()).rejects.toThrow();
		else expect((await a.call()).outcome).toBe("declined");
		expect(f.sends).toBe(0);
	} finally { await f.close(); }
});

test("uncertain wallet outcome stays reserved after restart", async () => {
	const f = await setup();
	try {
		f.pending = true; f.dropResponse = true;
		const a = await f.connect();
		expect((await a.call()).outcome).toBe("pending");
		await a.client.close();
		f.entries.length = 0;
		const b = await f.connect();
		expect((await b.call()).outcome).toBe("pending");
		expect((await b.call("l402_wallet")).reserved_sat).toBe(30);
		expect(f.sends).toBe(1);
	} finally { await f.close(); }
});

for (const failure of ["invalid-proof", "withheld-resource", "over-budget", "wrong-rail"] as const) test(`hostile provider: ${failure}`, async () => {
	const f = await setup();
	try {
		f.invalidProof = failure === "invalid-proof";
		f.responseStatus = failure === "withheld-resource" ? 402 : 200;
		f.price = failure === "over-budget" ? 95 : 20;
		f.rail = failure === "wrong-rail" ? "SEND_RAIL_IN_ARK" : "SEND_RAIL_LIGHTNING";
		const a = await f.connect();
		if (failure === "wrong-rail") await expect(a.call()).rejects.toThrow("Lightning settlement rail");
		else {
			const first = await a.call(); const second = await a.call();
			if (failure === "over-budget") expect(first.outcome).toBe("refused");
			else { expect(first.resource_delivered).toBe(false); expect(second.resource_delivered).toBe(false); }
		}
		expect(f.sends).toBe(failure === "over-budget" || failure === "wrong-rail" ? 0 : 1);
	} finally { await f.close(); }
});

test("task preview is non-paying, aggregates costs, and fetch attributes actual receipts", async () => {
	const f = await setup();
	try {
		const a = await f.connect();
		const { task_id } = await a.call("l402_task_create", { name: "Report", budget_sats: 35 });
		const item = { url: f.url, max_sats: 100 };
		const preview = await a.call("l402_preview", { task_id, purchases: [item, { ...item, method: "POST" }] });
		expect(preview.items[0].estimated_max_cost_sat).toBe(30);
		expect(preview.items[1].estimated_max_cost_sat).toBeNull();
		expect(preview.has_unknown_costs).toBe(true);
		expect(preview.estimate_fits_budgets).toBeNull();
		const repeated = await a.call("l402_preview", { task_id, purchases: [item, item] });
		expect(repeated.known_estimated_max_total_sat).toBe(60);
		expect(repeated.estimate_fits_budgets).toBe(false);
		expect(f.sends).toBe(0);
		expect(f.prepares).toBe(0);
		expect(f.resourceCalls).toBe(0);
		expect((await a.call("l402_task", { task_id })).receipts).toHaveLength(0);
		expect((await a.call("l402_fetch", { ...item, task_id })).resource_delivered).toBe(true);
		const task = await a.call("l402_task", { task_id });
		expect(task.settled_sat).toBe(23);
		expect(task.remaining_sat).toBe(12);
		expect(task.receipts[0].task_id).toBe(task_id);
		expect((await a.call("l402_wallet")).recent_receipts[0].task_id).toBe(task_id);
		const reuse = await a.call("l402_preview", { task_id, purchases: [item] });
		expect(reuse.items[0].credential_reuse_possible).toBe(true);
		expect(reuse.known_estimated_max_total_sat).toBe(0);
		await a.call("l402_fetch", { ...item, task_id });
		expect(f.sends).toBe(1);
		expect((await a.call("l402_task", { task_id })).receipts).toHaveLength(1);
	} finally { await f.close(); }
});

test("task cap refuses invoice plus fee reserve even when daily policy permits it", async () => {
	const f = await setup();
	try {
		const a = await f.connect();
		const { task_id } = await a.call("l402_task_create", { name: "Small report", budget_sats: 29 });
		const result = await a.call("l402_fetch", { url: f.url, max_sats: 100, task_id });
		expect(result.outcome).toBe("refused");
		expect(result.reason).toContain("task budget");
		expect(f.sends).toBe(0);
		const task = await a.call("l402_task", { task_id });
		expect(task.remaining_sat).toBe(29);
		expect(task.receipts[0].outcome).toBe("refused");
	} finally { await f.close(); }
});

test("preview is not authorization: execution checks a changed invoice against the task cap", async () => {
	const f = await setup();
	try {
		const a = await f.connect("unsupported");
		const { task_id } = await a.call("l402_task_create", { name: "Report", budget_sats: 30 });
		const item = { url: f.url, max_sats: 100 };
		expect((await a.call("l402_preview", { task_id, purchases: [item] })).estimate_fits_budgets).toBe(true);
		f.price = 21;
		expect((await a.call("l402_fetch", { ...item, task_id })).reason).toContain("task budget");
		expect(f.sends).toBe(0);
		const updated = await a.call("l402_preview", { task_id, purchases: [item] });
		expect(updated.known_estimated_max_total_sat).toBe(31);
		expect(updated.estimate_fits_budgets).toBe(false);
		await expect(a.call("l402_fetch", { ...item, task_id: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow("Unknown task");
	} finally { await f.close(); }
});

test("paid response checks persist across restart and reuse without altering receipts or budgets", async () => {
	const f = await setup();
	try {
		const a = await f.connect();
		const { task_id } = await a.call("l402_task_create", { name: "Fresh report", budget_sats: 30 });
		const quality = { required_fields: ["market.price"], freshness: { field: "as_of", max_age_seconds: 60 } };
		const args = { url: f.url, max_sats: 100, task_id, quality };
		f.responseBody = JSON.stringify({ market: { price: 0 }, as_of: new Date().toISOString() });
		const first = await a.call("l402_fetch", args);
		expect(first.quality).toMatchObject({ status: "passed", usable: true, requirements: quality });
		expect(first.resource_delivered).toBe(true);
		const receipt = (await a.call("l402_task", { task_id })).receipts[0];
		await a.client.close();
		const b = await f.connect();
		f.responseBody = JSON.stringify({ market: {}, as_of: "2000-01-01T00:00:00Z" });
		const second = await b.call("l402_fetch", args);
		expect(second.payment.reused_paid_token).toBe(true);
		expect(second.resource_delivered).toBe(true);
		expect(second.quality).toMatchObject({ status: "failed", usable: false,
			reasons: ["missing_required_field:market.price", "stale_timestamp:as_of"] });
		const task = await b.call("l402_task", { task_id });
		expect(task.receipts).toEqual([receipt]);
		expect(task.remaining_sat).toBe(7);
		expect(task.response_checks.map((r: { quality: { status: string } }) => r.quality.status)).toEqual(["passed", "failed"]);
		expect(task.response_checks.map((r: { payment_hash: string }) => r.payment_hash)).toEqual([f.hash, f.hash]);
		expect(task.response_checks[1].id).toBe(second.response_check_id);
		expect((await b.call("l402_wallet")).recent_response_checks[0].quality.usable).toBe(false);
		const other = await b.call("l402_task_create", { name: "Reuse in another task", budget_sats: 1 });
		await b.call("l402_fetch", { ...args, task_id: other.task_id });
		const otherTask = await b.call("l402_task", { task_id: other.task_id });
		expect(otherTask.receipts).toHaveLength(0);
		expect(otherTask.remaining_sat).toBe(1);
		expect(otherTask.response_checks[0].payment_hash).toBe(f.hash);
		expect((await b.call("l402_task", { task_id })).response_checks).toHaveLength(2);
		expect(f.sends).toBe(1);
	} finally { await f.close(); }
});

for (const failure of ["malformed", "http", "oversized", "redirect"] as const) test(`paid ${failure} response is recorded as unusable without repayment`, async () => {
	const f = await setup();
	try {
		const a = await f.connect();
		f.responseBody = failure === "oversized" ? "x".repeat(65 * 1024) : "{broken";
		f.responseStatus = failure === "http" ? 503 : 200;
		f.failResource = failure === "redirect";
		const args = { url: f.url, max_sats: 100, quality: { required_fields: ["value"] } };
		for (let i = 0; i < 2; i++) {
			const result = await a.call("l402_fetch", args);
			expect(result.quality.usable).toBe(false);
		}
		const wallet = await a.call("l402_wallet");
		expect(wallet.spent_today_sat).toBe(23);
		expect(wallet.recent_receipts).toHaveLength(1);
		expect(wallet.recent_response_checks).toHaveLength(2);
		expect(wallet.recent_response_checks.every((r: { payment_hash: string }) => r.payment_hash === f.hash)).toBe(true);
		expect(f.sends).toBe(1);
	} finally { await f.close(); }
});

test("unconfigured quality remains unknown; invalid requirements send no request or payment", async () => {
	const f = await setup();
	try {
		const a = await f.connect();
		await expect(a.call("l402_fetch", { url: f.url, max_sats: 100, quality: {} })).rejects.toThrow();
		expect(f.resourceCalls).toBe(0);
		expect(f.sends).toBe(0);
		expect((await a.call()).quality).toMatchObject({ status: "not_checked", usable: null });
		expect((await a.call("l402_wallet")).recent_response_checks[0].quality.usable).toBeNull();
	} finally { await f.close(); }
});

test("mainnet invoices are refused before the wallet sees them unless explicitly allowed", async () => {
	const f = await setup();
	try {
		f.invoice = "lnbc200n1pexample";
		const a = await f.connect();
		const refused = await a.call();
		expect(refused).toMatchObject({ paid: false, outcome: "refused" });
		expect(refused.reason).toContain("mainnet invoice refused");
		expect(f.prepares).toBe(0);
		expect(f.sends).toBe(0);
		expect((await a.call("l402_wallet")).reserved_sat).toBe(0);
		const allowed = await f.connect("approve", 100, 100, { L402_ALLOW_MAINNET: "1" });
		expect((await allowed.call()).resource_delivered).toBe(true);
		expect(f.sends).toBe(1);
	} finally { await f.close(); }
});
