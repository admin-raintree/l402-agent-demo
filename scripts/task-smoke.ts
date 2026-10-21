// Real MCP -> Aperture -> lnd task-budget checks on the local regtest network.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { lndWallet } from "../agent/wallet";

const ROOT = resolve(import.meta.dir, "..");
const DEMO = process.env.L402_DEMO_DIR ?? resolve(ROOT, ".demo");
const API = "http://127.0.0.1:8700";
const state = mkdtempSync(join(DEMO, "task-smoke-"));
const env = { ...process.env as Record<string, string>, L402_STATE_DIR: state, L402_WALLET: "lnd",
	L402_LND_RPCSERVER: "127.0.0.1:10019", L402_LND_TLSCERT: join(DEMO, "buyer/tls.cert"),
	L402_LND_MACAROON: join(DEMO, "agent-pay.macaroon"),
	L402_AUTO_APPROVE_SATS: "100", L402_DAILY_BUDGET_SATS: "80" };
let client: Client | undefined;
async function connect() {
	client = new Client({ name: "task-smoke", version: "0" }, { capabilities: {} });
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "agent/server.ts")], env }));
}
async function call(name: string, args: Record<string, unknown> = {}) {
	const result = await client!.callTool({ name, arguments: args });
	const text = (result.content as { text: string }[])[0].text;
	assert(!result.isError, `${name}: ${text}`);
	return JSON.parse(text);
}
async function cli(node: "buyer" | "seller", ...args: string[]) {
	const proc = Bun.spawn([join(ROOT, ".bin/lncli"), `--lnddir=${join(DEMO, node)}`, "--network=regtest",
		`--rpcserver=127.0.0.1:${node === "buyer" ? 10019 : 10020}`, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	assert.equal(exit, 0, `local ${node} lncli failed: ${stderr}`);
	return JSON.parse(stdout);
}
async function activity() {
	const payments = await cli("buyer", "listpayments", "--include_incomplete");
	const invoices = await cli("seller", "listinvoices");
	return { payments: payments.payments.length, invoices: invoices.invoices.length };
}
const step = (text: string) => console.log(`\n${text}`);

try {
	for (const node of ["buyer", "seller"] as const) {
		const info = await cli(node, "getinfo");
		assert(info.chains.some((chain: { network: string }) => chain.network === "regtest"));
	}
	await connect();
	step("Task 1. Preview two real services: 80-sat estimate, no invoices or payments");
	const { task_id } = await call("l402_task_create", { name: "Mining report", budget_sats: 80 });
	const purchases = [
		{ url: `${API}/v1/hashprice`, max_sats: 20 },
		{ url: `${API}/v1/breakeven`, max_sats: 60 },
	];
	const before = await activity();
	const preview = await call("l402_preview", { task_id, purchases });
	assert.deepEqual(preview.items.map((item: { estimated_max_cost_sat: number }) => item.estimated_max_cost_sat), [20, 60]);
	assert.equal(preview.known_estimated_max_total_sat, 80);
	assert.equal(preview.estimate_fits_budgets, true);
	assert.deepEqual(await activity(), before);
	assert.equal((await call("l402_task", { task_id })).receipts.length, 0);

	step("Task 2. A 59-sat task refuses the 50-sat invoice plus 10-sat fee reserve");
	const small = await call("l402_task_create", { name: "Too small", budget_sats: 59 });
	const denied = await call("l402_fetch", { ...purchases[1], task_id: small.task_id });
	assert.equal(denied.outcome, "refused");
	assert.match(denied.reason, /task budget/);
	assert.equal((await activity()).payments, before.payments);
	const smallState = await call("l402_task", { task_id: small.task_id });
	assert.equal(smallState.remaining_sat, 59);
	assert.equal(smallState.receipts[0].outcome, "refused");

	step("Task 3. Buy both resources; receipts charge actual fees instead of the reserve");
	const bought = [];
	for (const purchase of purchases) {
		const result = await call("l402_fetch", { ...purchase, task_id, quality: { required_fields: ["as_of", "source"] } });
		assert.equal(result.status, 200);
		assert.equal(result.resource_delivered, true);
		assert.equal(result.quality.usable, true);
		assert.equal(result.payment.task_id, task_id);
		bought.push(result.payment);
	}
	const task = await call("l402_task", { task_id });
	assert.equal(task.settled_sat, 60);
	assert.equal(task.reserved_sat, 0);
	assert.equal(task.remaining_sat, 20);
	assert.equal(task.receipts.length, 2);
	assert(task.receipts.every((receipt: { task_id: string; outcome: string }) => receipt.task_id === task_id && receipt.outcome === "paid"));
	assert.equal((await activity()).payments, before.payments + 2);

	step("Task 4. Restart MCP: task state persists and both paid credentials reuse at zero cost");
	await client!.close();
	await connect();
	assert.deepEqual(await call("l402_task", { task_id }), task);
	const afterBuy = await activity();
	const reuse = await call("l402_preview", { task_id, purchases });
	assert.equal(reuse.known_estimated_max_total_sat, 0);
	assert(reuse.items.every((item: { credential_reuse_possible: boolean }) => item.credential_reuse_possible));
	for (const purchase of purchases) {
		const result = await call("l402_fetch", { ...purchase, task_id, quality: { required_fields: ["as_of", "source"] } });
		assert.equal(result.status, 200);
		assert.equal(result.payment.reused_paid_token, true);
	}
	assert.deepEqual(await activity(), afterBuy);
	const reusedTask = await call("l402_task", { task_id });
	assert.deepEqual(reusedTask.receipts, task.receipts);
	assert.equal(reusedTask.settled_sat, task.settled_sat);
	assert.equal(reusedTask.remaining_sat, task.remaining_sat);
	assert.equal(reusedTask.response_checks.length, 4);

	step("Task 4b. Stale and missing-field responses are unusable without additional payment");
	const stale = await call("l402_fetch", { ...purchases[0], task_id,
		quality: { freshness: { field: "as_of", max_age_seconds: 0 } } });
	assert.equal(stale.resource_delivered, true);
	assert.equal(stale.quality.usable, false);
	assert.deepEqual(stale.quality.reasons, ["stale_timestamp:as_of"]);
	const missing = await call("l402_fetch", { ...purchases[0], task_id,
		quality: { required_fields: ["missing_field"] } });
	assert.equal(missing.quality.usable, false);
	assert.deepEqual(missing.quality.reasons, ["missing_required_field:missing_field"]);
	const checked = await call("l402_task", { task_id });
	assert.equal(checked.response_checks.length, 6);
	assert.deepEqual(checked.receipts, task.receipts);
	assert.equal(checked.remaining_sat, 20);
	assert.deepEqual(await activity(), afterBuy);

	step("Task 5. A larger task cannot bypass the shared daily budget");
	const large = await call("l402_task_create", { name: "Large report", budget_sats: 2000 });
	const report = { url: `${API}/v1/report`, max_sats: 2000 };
	const dailyPreview = await call("l402_preview", { task_id: large.task_id, purchases: [report] });
	assert.equal(dailyPreview.daily_remaining_sat, 20);
	assert.equal(dailyPreview.estimate_fits_budgets, false);
	const dailyRefusal = await call("l402_fetch", { ...report, task_id: large.task_id });
	assert.equal(dailyRefusal.outcome, "refused");
	assert.match(dailyRefusal.reason, /daily budget/);
	assert.equal((await activity()).payments, afterBuy.payments);
	const wallet = await call("l402_wallet");
	assert.equal(wallet.spent_today_sat, 60);
	assert.equal(wallet.reserved_sat, 0);
	assert.equal(wallet.recent_receipts.filter((r: { task_id: string }) => r.task_id === task_id).length, 2);

	step("Task 6. Independently reconcile buyer settlements, preimages, and seller invoices");
	const backend = lndWallet(ROOT, DEMO, env);
	for (const payment of bought) {
		const status = await backend.lookup({ paymentHash: payment.payment_hash, amountSat: payment.amount_sat });
		assert(status.state === "paid");
		assert.equal(status.result.feeSat, payment.fee_sat);
		assert(status.result.preimage);
		assert.equal(createHash("sha256").update(Buffer.from(status.result.preimage, "hex")).digest("hex"), payment.payment_hash);
		const invoice = await cli("seller", "lookupinvoice", payment.payment_hash);
		assert.equal(invoice.state, "SETTLED");
		assert.equal(Number(invoice.amt_paid_sat), payment.amount_sat);
	}
	console.log(`\nTask smoke passed: 80 sats estimated, 60 settled, 0 fees, 20 task/daily sats remaining. State: ${state}`);
} finally {
	await client?.close();
}
