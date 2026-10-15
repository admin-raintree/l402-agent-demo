import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startDashboard } from "../dashboard/server";
import { lndWallet } from "../agent/wallet";

const dir = mkdtempSync(join(tmpdir(), "resource-regtest-"));
const app = startDashboard({ stateDir: dir, port: 0, env: { ...process.env as Record<string, string>, L402_WALLET: "lnd" } });
const api = async (path: string, body?: unknown) => {
	const r = await fetch(new URL(path, app.server.url), body === undefined ? {} : { method: "POST",
		headers: { origin: app.server.url.origin, "content-type": "application/json" }, body: JSON.stringify(body) });
	assert(r.ok, `HTTP ${r.status}`); return r.json();
};
try {
	const t = await api("/api/tasks", { resourcePath: "/v1/report", budgetSat: 1100, autoApproveSat: 100 });
	await api(`/api/tasks/${t.id}/run`, {});
	const deadline = Date.now() + 90_000;
	let approved = false;
	while (app.runner.isActive(t.id)) {
		assert(Date.now() < deadline, "Request timed out");
		const current = app.store.task(t.id);
		if (current.approval?.decision === "pending") {
			assert.equal(approved, false); approved = true;
			await api(`/api/tasks/${t.id}/approval`, { id: current.approval.id, approve: true });
		}
		await Bun.sleep(25);
	}
	const result = app.store.task(t.id);
	assert.equal(result.status, "complete", result.error); assert.equal(result.delivery?.status, "received"); assert(approved);
	assert(result.response && typeof result.response === "object", "Provider response was not retained");
	const receipts = app.store.ledger().filter(r => r.task_id === t.id && r.outcome === "paid");
	assert.equal(receipts.length, 1); assert.equal(receipts[0].amount_sat, 1000); assert.equal(receipts[0].approval, "human");
	const root = resolve(import.meta.dir, "..");
	const demo = process.env.L402_DEMO_DIR ?? resolve(root, ".demo");
	const wallet = lndWallet(root, demo);
	const status = await wallet.lookup({ paymentHash: receipts[0].payment_hash, amountSat: 1000 });
	assert(status.state === "paid"); assert.equal(status.result.feeSat, receipts[0].fee_sat);
	const p = Bun.spawn([resolve(root, ".bin/lncli"), `--lnddir=${demo}/seller`, "--network=regtest",
		"--rpcserver=127.0.0.1:10020", "lookupinvoice", receipts[0].payment_hash], { stdout: "pipe", stderr: "pipe" });
	const invoice = JSON.parse(await new Response(p.stdout).text()); assert.equal(await p.exited, 0);
	assert.equal(invoice.state, "SETTLED"); assert.equal(Number(invoice.amt_paid_sat), 1000);
	const timings = app.store.events(t.id);
	console.log(JSON.stringify({ passed: true, task: t.id, state: dir, committedSat: app.store.taskSpent(t.id),
		checks: ["human approval", "real regtest settlement", "buyer/seller reconciliation", "delivered report"], timings }, null, 2));
} finally { await app.close(); }
