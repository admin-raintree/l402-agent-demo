// End-to-end check against a running `scripts/up.sh` network. Drives the MCP server
// as a client would, scripting the human's approval answers, and asserts each policy path.
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const ROOT = resolve(import.meta.dir, "..");
const API = "http://127.0.0.1:8700";
const answers: boolean[] = [false, true]; // first approval request: decline; second: approve

const client = new Client({ name: "smoke", version: "0" }, { capabilities: { elicitation: {} } });
client.setRequestHandler(ElicitRequestSchema, async (req) => {
	const approve = answers.shift() ?? false;
	console.log(`  [human] ${approve ? "approves" : "declines"}: ${req.params.message}`);
	return { action: "accept", content: { approve } };
});
await client.connect(
	new StdioClientTransport({
		command: "bun",
		args: [resolve(ROOT, "agent/server.ts")],
		env: {
			...(process.env as Record<string, string>),
			L402_STATE_DIR: mkdtempSync(join(tmpdir(), "l402-smoke-")),
			L402_AUTO_APPROVE_SATS: "100",
			L402_DAILY_BUDGET_SATS: "1050",
		},
	}),
);

async function call(name: string, args: Record<string, unknown> = {}) {
	const r = await client.callTool({ name, arguments: args });
	const text = (r.content as { text: string }[])[0].text;
	assert(!r.isError, `${name} failed: ${text}`);
	return JSON.parse(text);
}

const step = (s: string) => console.log(`\n${s}`);

step("1. Discover the provider's catalog");
const catalog = await call("l402_discover", { url: API });
assert.deepEqual(catalog.resources.map((r: { price_sats: number }) => r.price_sats), [10, 50, 1000]);

step("2. Buy hashprice (10 sats, under the auto-approve limit)");
const hp = await call("l402_fetch", { url: `${API}/v1/hashprice`, max_sats: 100 });
assert.equal(hp.status, 200);
assert.equal(hp.payment.amount_sat, 10);
assert.equal(hp.payment.approval, "auto");
console.log(`  hashprice $${hp.body.hashprice_usd_per_ph_day}/PH/day (${hp.body.source})`);

step("3. Call hashprice again: reuse the paid token, pay nothing");
const again = await call("l402_fetch", { url: `${API}/v1/hashprice`, max_sats: 100 });
assert.equal(again.status, 200);
assert.equal(again.payment.reused_paid_token, true);

step("4. Report costs 1000 sats but max_sats is 500: refused without asking");
const capped = await call("l402_fetch", { url: `${API}/v1/report`, max_sats: 500 });
assert.equal(capped.outcome, "refused");

step("5. Report with max_sats 2000: human is asked and declines");
const declined = await call("l402_fetch", { url: `${API}/v1/report`, max_sats: 2000 });
assert.equal(declined.outcome, "declined");

step("6. Ask again: human approves, payment goes through");
const report = await call("l402_fetch", { url: `${API}/v1/report`, max_sats: 2000 });
assert.equal(report.status, 200);
assert.equal(report.payment.approval, "human");
assert.equal(report.body.breakeven_grid.length, 12);

step("7. Break-even (50 sats) would exceed the 1050-sat daily budget: refused");
const over = await call("l402_fetch", { url: `${API}/v1/breakeven?j_per_th=17.5&usd_per_kwh=0.05`, max_sats: 100 });
assert.equal(over.outcome, "refused");
assert.match(over.reason, /daily budget/);

step("8. Wallet shows spend and receipts for every decision");
const wallet = await call("l402_wallet");
assert.equal(wallet.spent_today_sat, 1010);
assert.deepEqual(
	wallet.recent_receipts.map((r: { outcome: string }) => r.outcome),
	["paid", "refused", "declined", "paid", "refused"],
);
console.log(`  spent ${wallet.spent_today_sat} of ${wallet.policy.daily_budget_sats} sats; channel balance ${wallet.channel_balance_sat} sats`);

await client.close();
console.log("\nSmoke test passed.");
