// Subscription through a litd account, against a running `scripts/verify-litd.sh` network.
// The MCP wallet pays with an account macaroon sized to cap × periods, which expires when the
// subscription ends. Then payments the application would allow, from a second state directory
// and from lncli directly, show that the account still caps spending without the app's policy.
// Macaroons and preimages stay in files or memory and are never printed.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { lndWallet, PaymentFailed } from "../agent/wallet";
import { startTimedAperture, TIMED_API } from "./timed-aperture";

const ROOT = resolve(import.meta.dir, "..");
const DEMO = process.env.L402_DEMO_DIR;
if (!DEMO) throw new Error("L402_DEMO_DIR is required; run scripts/verify-litd.sh");
const BIN = resolve(ROOT, ".bin");
const ACCOUNT_MAC = `${DEMO}/sub-account.macaroon`;
const LITD_ENV = { L402_LND_RPCSERVER: "127.0.0.1:8443", L402_LND_TLSCERT: `${DEMO}/lit/tls.cert`, L402_LND_MACAROON: ACCOUNT_MAC };
const TIMEOUT_SECONDS = 4, PERIOD_SECONDS = 12, PERIODS = 2, CAP = 20; // cap = 10-sat price + 10-sat maximum fee
const ALLOWANCE = CAP * PERIODS;
const step = (s: string) => console.log(`\n${s}`);

type Run = { code: number; out: string; err: string };
async function run(args: string[]): Promise<Run> {
	const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, out, err };
}
async function ok(args: string[]) {
	const r = await run(args);
	if (r.code !== 0) throw new Error(`${args[0].split("/").at(-1)} ${args.find(a => !a.startsWith("-") && a !== args[0])} failed: ${r.err.trim() || r.out.trim()}`);
	// litcli appends a plain-text line after its JSON when it saves a macaroon.
	return JSON.parse(r.out.slice(r.out.indexOf("{"), r.out.lastIndexOf("}") + 1));
}
const lncli = (lnddir: string, port: number) => [`${BIN}/lncli`, `--lnddir=${DEMO}/${lnddir}`, "--network=regtest", `--rpcserver=127.0.0.1:${port}`];
const seller = (...a: string[]) => ok([...lncli("seller", 10020), ...a]);
const buyerAdmin = (...a: string[]) => ok([...lncli("buyer", 10019), ...a]);
const litcli = (...a: string[]) => ok([`${BIN}/litcli`, "--network=regtest", "--rpcserver=127.0.0.1:8443",
	`--tlscertpath=${DEMO}/lit/tls.cert`, `--macaroonpath=${DEMO}/lit/regtest/lit.macaroon`, ...a]);
// Account macaroon straight to lnd's own RPC port: no MCP server, no SQLite policy, no litd proxy.
const directPay = (invoice: string, feeLimit: number) => run([`${BIN}/lncli`, "--network=regtest", "--rpcserver=127.0.0.1:10019",
	`--tlscertpath=${DEMO}/buyer/tls.cert`, `--macaroonpath=${ACCOUNT_MAC}`, "payinvoice", "--force", "--json", `--fee_limit=${feeLimit}`, invoice]);
const rpcError = (r: Run) => (r.err.match(/desc = (.*)/)?.[1] ?? r.err).trim();

type Account = { id: string; current_balance: string; expiration_date: string };
const balance = async (id: string) => {
	const { accounts } = await litcli("accounts", "list") as { accounts: Account[] };
	return Number(accounts.find(a => a.id === id)!.current_balance);
};
const invoiceState = async (hash: string) => (await seller("lookupinvoice", hash)) as { state: string; amt_paid_sat: string };
async function buyerPayment(hash: string) {
	const { payments } = await buyerAdmin("listpayments", "--include_incomplete", "--max_payments=1000") as { payments: { payment_hash: string; status: string; value_sat: string; fee_sat: string }[] };
	return payments.find(p => p.payment_hash === hash);
}

async function mcp(name: string, env: Record<string, string>) {
	const client = new Client({ name, version: "0" }, { capabilities: { elicitation: {} } });
	let prompts = 0;
	client.setRequestHandler(ElicitRequestSchema, async req => {
		prompts++;
		console.log(`  [human] approves: ${req.params.message}`);
		return { action: "accept", content: { approve: true } };
	});
	await client.connect(new StdioClientTransport({ command: "bun", args: [resolve(ROOT, "agent/server.ts")], env: {
		...process.env as Record<string, string>, ...LITD_ENV, L402_STATE_DIR: mkdtempSync(join(tmpdir(), `l402-${name}-`)), ...env,
	} }));
	const call = async (tool: string, args: Record<string, unknown>) => {
		const r = await client.callTool({ name: tool, arguments: args });
		const text = (r.content as { text: string }[])[0].text;
		assert(!r.isError, `${tool} failed: ${text}`);
		return JSON.parse(text);
	};
	return { client, call, prompts: () => prompts };
}

const stopAperture = await startTimedAperture(ROOT, DEMO, TIMEOUT_SECONDS);
const clients: Client[] = [];
const results: Record<string, unknown> = {};
try {
	const expiresAt = Math.floor(Date.now() / 1000) + PERIODS * PERIOD_SECONDS + 10;
	step(`1. Create a ${ALLOWANCE}-sat account (cap ${CAP} × ${PERIODS} periods) expiring at ${new Date(expiresAt * 1000).toISOString()}`);
	const created = await litcli("accounts", "create", String(ALLOWANCE), "--expiration_date", String(expiresAt),
		"--label", "subscription-smoke", "--save_to", ACCOUNT_MAC) as { account: Account };
	const id = created.account.id;
	assert.equal(await balance(id), ALLOWANCE);
	assert.equal(Number(created.account.expiration_date), expiresAt);
	console.log(`  account ${id}; macaroon saved to the state directory, not printed`);

	step("2. The account macaroon covers every lncli call the lnd wallet makes");
	const account = lndWallet(ROOT, DEMO, LITD_ENV);
	const virtual = await account.balanceSat();
	const channel = Number((await buyerAdmin("channelbalance")).local_balance.sat);
	assert.equal(virtual, ALLOWANCE, "channelbalance through the account is not the account balance");
	assert(channel > 1_000_000);
	const probe = await seller("addinvoice", "--amt=10", "--memo=litd-sub-probe") as { r_hash: string; payment_request: string };
	const quote = await account.quote(probe.payment_request, 10);
	assert.equal(quote.amountSat, 10);
	assert.equal(quote.paymentHash, probe.r_hash);
	assert.deepEqual(await account.lookup(quote), { state: "unknown" });
	await seller("cancelinvoice", probe.r_hash);
	console.log(`  channelbalance: ${virtual} sats (the account's virtual balance; the real channel holds ${channel})`);
	console.log("  decodepayreq: amount, hash and payee returned; listpayments: no record for an unpaid hash");
	results.coverage = { channelbalance_sat: virtual, real_channel_sat: channel, decodepayreq: true, listpayments: true };

	step(`3. Subscribe through the account: ${CAP} sats per ${PERIOD_SECONDS}s period for ${PERIODS} periods, auto-approval 0`);
	const a = await mcp("litd-sub-a", { L402_AUTO_APPROVE_SATS: "0", L402_DAILY_BUDGET_SATS: "1000" });
	clients.push(a.client);
	const url = `${TIMED_API}/v1/hashprice`;
	const { subscription } = await a.call("l402_subscribe", { url, cap_sats_per_period: CAP, periods: PERIODS, period_seconds: PERIOD_SECONDS });
	const periodEnd = (k: number) => Date.parse(subscription.starts_at) + (k + 1) * PERIOD_SECONDS * 1000;
	assert(periodEnd(PERIODS - 1) <= expiresAt * 1000, "account expires before the subscription ends");
	const first = await a.call("l402_fetch", { url, max_sats: 100 });
	assert.equal(first.status, 200);
	assert.equal(first.payment.period, 0);
	await Bun.sleep(Math.max(0, periodEnd(0) - Date.now()) + 500);
	const renewed = await a.call("l402_fetch", { url, max_sats: 100 });
	assert.equal(renewed.status, 200);
	assert.equal(renewed.payment.period, 1);
	assert.equal(renewed.payment.approval, "standing");
	assert.equal(a.prompts(), 1);
	const paid = [first.payment, renewed.payment];
	const spent = paid.reduce((n, p) => n + p.amount_sat + p.fee_sat, 0);
	const wallet = await a.call("l402_wallet", {});
	const afterSub = await balance(id);
	assert.equal(afterSub, ALLOWANCE - spent, "account debit does not match the MCP receipts");
	assert.equal(wallet.balance_sat, afterSub, "l402_wallet balance is not the account balance");
	console.log(`  periods 0 and 1 paid ${paid.map(p => `${p.amount_sat} + ${p.fee_sat}`).join(" and ")} sats with 1 prompt`);
	console.log(`  account ${ALLOWANCE} -> ${afterSub} sats; l402_wallet reports balance_sat ${wallet.balance_sat}`);
	results.subscription = { periods_paid: paid.length, prompts: a.prompts(), receipts_sat: spent, account_before: ALLOWANCE, account_after: afterSub, l402_wallet_balance_sat: wallet.balance_sat };

	step("4. Bypass the subscription: a second MCP state directory auto-approves a 50-sat purchase");
	const b = await mcp("litd-sub-b", { L402_AUTO_APPROVE_SATS: "100", L402_DAILY_BUDGET_SATS: "1000" });
	clients.push(b.client);
	const extra = await b.call("l402_fetch", { url: "http://127.0.0.1:8700/v1/breakeven", max_sats: 100 });
	assert.equal(b.prompts(), 0, "the second state directory asked for approval");
	assert.notEqual(extra.status, 200, "the bypass purchase was delivered");
	assert.equal(extra.outcome, "failed", "litd's pre-send refusal was not recorded as a failed payment");
	const extraInvoice = await invoiceState(extra.payment_hash);
	assert.equal(extraInvoice.state, "OPEN");
	assert.equal(Number(extraInvoice.amt_paid_sat), 0);
	assert.equal(await buyerPayment(extra.payment_hash), undefined, "lnd recorded a payment attempt");
	assert.equal(await balance(id), afterSub);
	const bWallet = await b.call("l402_wallet", {});
	assert.equal(bWallet.reserved_sat, 0, "the refused purchase left a reservation");
	// The server does not surface the wallet's error, so repeat its wallet call to show litd's reason.
	const same = await seller("addinvoice", "--amt=50", "--memo=litd-sub-wallet") as { r_hash: string; payment_request: string };
	const walletFailure = await account.pay(same.payment_request, await account.quote(same.payment_request, 10), 10).then(() => undefined, (e: Error) => e);
	assert(walletFailure instanceof PaymentFailed, `expected PaymentFailed, got ${walletFailure}`);
	const walletErr = walletFailure.message;
	assert.match(walletErr, /account balance insufficient/);
	assert.equal((await invoiceState(same.r_hash)).state, "OPEN");
	await seller("cancelinvoice", same.r_hash);
	console.log(`  app policy: auto-approved, no prompt; MCP result outcome "${extra.outcome}": ${extra.reason}`);
	console.log(`  seller invoice ${extraInvoice.state}, no buyer payment record, account still ${afterSub} sats; app reserved ${bWallet.reserved_sat} sats`);
	console.log(`  the same wallet call on a fresh 50-sat invoice: ${walletErr}`);
	results.second_state_dir = { amount_sat: 50, app_decision: "auto", prompts: b.prompts(), mcp_outcome: extra.outcome,
		mcp_reason: extra.reason, app_reserved_sat: bWallet.reserved_sat, seller_invoice: extraInvoice.state,
		wallet_error: walletErr, account_after: await balance(id) };

	step(`5. Pay directly on lnd's RPC port with the account macaroon: 11 sats, 10-sat fee limit (21 > ${afterSub})`);
	const over = await seller("addinvoice", "--amt=11", "--memo=litd-sub-direct") as { r_hash: string; payment_request: string };
	const overRun = await directPay(over.payment_request, 10);
	assert(overRun.code !== 0 && /account balance insufficient/.test(overRun.err), `expected an account rejection: ${rpcError(overRun)}`);
	assert.equal((await invoiceState(over.r_hash)).state, "OPEN");
	assert.equal(await balance(id), afterSub);
	await seller("cancelinvoice", over.r_hash);
	console.log(`  rejected: ${rpcError(overRun)}; seller invoice OPEN; account ${afterSub} sats`);
	results.direct_over_balance = { amount_sat: 11, fee_limit_sat: 10, error: rpcError(overRun) };

	step(`6. After the account expires, a 5-sat payment that fits the remaining ${afterSub} sats is refused`);
	await Bun.sleep(Math.max(0, expiresAt * 1000 - Date.now()) + 1500);
	const late = await seller("addinvoice", "--amt=5", "--memo=litd-sub-expired") as { r_hash: string; payment_request: string };
	const lateRun = await directPay(late.payment_request, 0);
	assert(lateRun.code !== 0 && /has expired/.test(lateRun.err), `expected an expiry rejection: ${rpcError(lateRun)}`);
	assert.equal((await invoiceState(late.r_hash)).state, "OPEN");
	await seller("cancelinvoice", late.r_hash);
	const balanceErr = await account.balanceSat().then(() => "", e => String(e.message));
	assert.match(balanceErr, /has expired/, "channelbalance still answered after expiry");
	console.log(`  rejected: ${rpcError(lateRun)}; the wallet's channelbalance now fails the same way`);
	results.direct_after_expiry = { amount_sat: 5, error: rpcError(lateRun), channelbalance_error: /has expired/.test(balanceErr) };

	step("7. Reconcile: account debit, MCP receipts, buyer payments, and seller invoices agree");
	for (const p of paid) {
		const record = await buyerPayment(p.payment_hash);
		assert.equal(record?.status, "SUCCEEDED");
		assert.equal(Number(record!.value_sat), p.amount_sat);
		assert.equal(Number(record!.fee_sat), p.fee_sat);
		const status = await lndWallet(ROOT, DEMO).lookup({ paymentHash: p.payment_hash, amountSat: p.amount_sat });
		assert(status.state === "paid");
		assert.equal(createHash("sha256").update(Buffer.from(status.result.preimage!, "hex")).digest("hex"), p.payment_hash);
		const inv = await invoiceState(p.payment_hash);
		assert.equal(inv.state, "SETTLED");
		assert.equal(Number(inv.amt_paid_sat), p.amount_sat);
	}
	const final = await balance(id);
	assert.equal(final, ALLOWANCE - spent);
	console.log(`  2 settled payments, ${spent} sats with fees; account ${ALLOWANCE} -> ${final}; nothing else left the account`);
	results.final_balance_sat = final;

	console.log("\nlitd subscription smoke test passed.");
	console.log(JSON.stringify({ passed: true, account: id, allowance_sat: ALLOWANCE, expires_at: new Date(expiresAt * 1000).toISOString(), results }, null, 2));
} finally {
	for (const c of clients) await c.close();
	await stopAperture();
}
