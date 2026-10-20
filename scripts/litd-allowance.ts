// litd account allowance check against a running `scripts/verify-litd.sh` network. Payments go
// straight to lnd with an account-restricted macaroon, bypassing the MCP policy entirely, so
// only litd's account interceptor stands between the macaroon and the channel.
// Macaroons and preimages stay in files or memory and are never printed.
import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DEMO = process.env.L402_DEMO_DIR;
if (!DEMO) throw new Error("L402_DEMO_DIR is required; run scripts/verify-litd.sh");
const BIN = resolve(ROOT, ".bin");
const ACCOUNT_MAC = `${DEMO}/account.macaroon`;
const ALLOWANCE = 100;

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
// Account-restricted payer, through litd's proxy port or directly against lnd's own RPC port.
const endpoints = {
	litd: ["--rpcserver=127.0.0.1:8443", `--tlscertpath=${DEMO}/lit/tls.cert`],
	lnd: ["--rpcserver=127.0.0.1:10019", `--tlscertpath=${DEMO}/buyer/tls.cert`],
};
const accountPay = (via: keyof typeof endpoints, invoice: string, feeLimit: number) =>
	run([`${BIN}/lncli`, "--network=regtest", ...endpoints[via], `--macaroonpath=${ACCOUNT_MAC}`,
		"payinvoice", "--force", "--json", `--fee_limit=${feeLimit}`, invoice]);

type Account = { id: string; current_balance: string; payments?: Record<string, { state?: string; status?: string; full_amount_msat?: string; full_amount?: string }> };
async function account(id: string): Promise<Account> {
	const { accounts } = await litcli("accounts", "list") as { accounts: Account[] };
	const a = accounts.find(a => a.id === id);
	assert(a, "account disappeared");
	return a;
}
const balance = async (id: string) => Number((await account(id)).current_balance);
const invoiceState = async (hash: string) => (await seller("lookupinvoice", hash)) as { state: string; amt_paid_sat: string };
async function buyerPayment(hash: string) {
	const { payments } = await buyerAdmin("listpayments", "--include_incomplete", "--max_payments=1000") as { payments: { payment_hash: string; status: string; value_sat: string; fee_sat: string }[] };
	return payments.find(p => p.payment_hash === hash);
}
const insufficient = (r: Run) => r.code !== 0 && /account balance insufficient/.test(r.err + r.out);
const step = (s: string) => console.log(`\n${s}`);
const results: Record<string, unknown> = {};

step(`1. Create a ${ALLOWANCE}-sat account (macaroon saved to the state directory, not printed)`);
const created = await litcli("accounts", "create", String(ALLOWANCE), "--save_to", ACCOUNT_MAC) as { account: Account };
const id = created.account.id;
assert.equal(await balance(id), ALLOWANCE);
console.log(`  account ${id}: ${ALLOWANCE} sats`);

async function rejectDirect(label: string, amount: number, feeLimit: number, via: keyof typeof endpoints) {
	const before = await balance(id);
	const inv = await seller("addinvoice", `--amt=${amount}`, `--memo=litd-${label}`) as { r_hash: string; payment_request: string };
	const r = await accountPay(via, inv.payment_request, feeLimit);
	const state = await invoiceState(inv.r_hash);
	const after = await balance(id);
	const sent = await buyerPayment(inv.r_hash);
	assert(insufficient(r), `${label}: expected an account rejection, got exit ${r.code}: ${(r.err || r.out).slice(0, 200)}`);
	assert.equal(state.state, "OPEN", `${label}: seller invoice changed state`);
	assert.equal(Number(state.amt_paid_sat), 0);
	assert.equal(after, before, `${label}: account balance changed`);
	assert.equal(sent, undefined, `${label}: lnd recorded a payment attempt`);
	await seller("cancelinvoice", inv.r_hash);
	results[label] = { amount_sat: amount, fee_limit_sat: feeLimit, endpoint: via, rejected: true,
		error: (r.err.match(/desc = (.*)/)?.[1] ?? r.err).trim(), seller_invoice: state.state, balance_before: before, balance_after: after };
	console.log(`  rejected: ${results[label] && (results[label] as { error: string }).error}`);
	console.log(`  seller invoice ${state.state}, account ${before} -> ${after} sats, no buyer payment record`);
}

step("2. Pay a 101-sat invoice directly through litd with the account macaroon (fee limit 0)");
await rejectDirect("over_principal_litd", 101, 0, "litd");

step("3. Same 101-sat attempt against lnd's own RPC port, skipping litd's proxy");
await rejectDirect("over_principal_lnd_port", 101, 0, "lnd");

step("4. A 95-sat invoice with a 10-sat fee limit: principal fits, principal plus maximum fee does not");
await rejectDirect("over_with_fee_limit", 95, 10, "litd");

const N = 5, AMOUNT = 30, FEE_LIMIT = 10;
step(`5. ${N} concurrent ${AMOUNT}-sat payments with ${FEE_LIMIT}-sat fee limits (${N * (AMOUNT + FEE_LIMIT)} sats committed > ${ALLOWANCE})`);
// Hold invoices keep accepted payments in flight, so every request is judged while the others are outstanding.
const holds = await Promise.all(Array.from({ length: N }, async (_, i) => {
	const preimage = randomBytes(32);
	const hash = createHash("sha256").update(preimage).digest("hex");
	const inv = await seller("addholdinvoice", hash, `--amt=${AMOUNT}`, `--memo=litd-concurrent-${i}`) as { payment_request: string };
	return { i, preimage, hash, invoice: inv.payment_request };
}));
const before = await balance(id);
const started = holds.map(h => ({ ...h, result: accountPay("litd", h.invoice, FEE_LIMIT) }));
const settledEarly = new Map<number, Run>();
for (const s of started) s.result.then(r => settledEarly.set(s.i, r));
let states: string[] = [];
for (let t = 0; t < 120; t++) {
	states = await Promise.all(holds.map(async h => (await invoiceState(h.hash)).state));
	const accepted = states.filter(s => s === "ACCEPTED").length;
	if (accepted + settledEarly.size === N) break;
	await Bun.sleep(250);
}
const acceptedHolds = holds.filter((_, i) => states[i] === "ACCEPTED");
const rejectedRuns = [...settledEarly.values()];
const inflight = await account(id);
console.log(`  in flight: ${acceptedHolds.length} accepted by the seller, ${rejectedRuns.length} returned early`);
assert.equal(acceptedHolds.length + rejectedRuns.length, N, "some payments neither reached the seller nor returned");
assert(rejectedRuns.every(insufficient), "an early-returning payment failed for a reason other than the account balance");
assert(acceptedHolds.length * (AMOUNT + FEE_LIMIT) <= before, "in-flight commitments exceed the allowance");
assert.equal(states.filter(s => s === "SETTLED").length, 0);

for (const h of acceptedHolds) await seller("settleinvoice", h.preimage.toString("hex"));
const runs = await Promise.all(started.map(s => s.result));
await Bun.sleep(1000); // let litd process the payment updates
const finalStates = await Promise.all(holds.map(async h => invoiceState(h.hash)));
const buyerRecords = await Promise.all(holds.map(h => buyerPayment(h.hash)));
const succeeded = buyerRecords.filter(p => p?.status === "SUCCEEDED");
const spent = succeeded.reduce((n, p) => n + Number(p!.value_sat) + Number(p!.fee_sat), 0);
const after = await balance(id);
assert.equal(runs.filter(r => r.code === 0).length, acceptedHolds.length);
assert.equal(succeeded.length, acceptedHolds.length);
assert.equal(finalStates.filter(s => s.state === "SETTLED").length, acceptedHolds.length);
assert(spent <= ALLOWANCE, "settled spending exceeds the allowance");
assert.equal(after, before - spent, "account debit does not match buyer payment records");
for (const h of holds.filter((_, i) => finalStates[i].state === "OPEN")) await seller("cancelinvoice", h.hash);
results.concurrent = {
	payments: N, amount_sat: AMOUNT, fee_limit_sat: FEE_LIMIT, requested_commitment_sat: N * (AMOUNT + FEE_LIMIT),
	accepted_in_flight: acceptedHolds.length, rejected_insufficient: rejectedRuns.length,
	in_flight_account_payments: Object.values(inflight.payments ?? {}).length,
	settled: succeeded.length, settled_spend_sat: spent, balance_before: before, balance_after: after,
	seller_states: finalStates.map(s => s.state),
};
console.log(`  settled ${succeeded.length} x ${AMOUNT} sats (fees ${spent - succeeded.length * AMOUNT}); account ${before} -> ${after} sats`);
console.log(`  seller invoices: ${finalStates.map(s => s.state).join(", ")} (open ones then canceled)`);

step(`6. Remaining ${after} sats: a ${after - FEE_LIMIT + 1}-sat payment with a ${FEE_LIMIT}-sat fee limit is refused`);
await rejectDirect("remaining_balance", after - FEE_LIMIT + 1, FEE_LIMIT, "litd");

console.log("\nlitd allowance check passed.");
console.log(JSON.stringify({ passed: true, account: id, allowance_sat: ALLOWANCE, results }, null, 2));
