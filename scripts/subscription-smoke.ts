// Subscription check against a running `scripts/up.sh` network. Starts a second Aperture whose
// hashprice service has a short `timeout`, confirms the minted macaroon carries the expiry
// caveat, then drives the MCP server through one standing approval and its renewals.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseChallenge } from "../agent/policy";
import { macaroonCaveats } from "../agent/subscription";
import { lndWallet } from "../agent/wallet";

const ROOT = resolve(import.meta.dir, "..");
const DEMO = process.env.L402_DEMO_DIR ?? resolve(ROOT, ".demo");
const API = "http://127.0.0.1:8702";
const TIMEOUT_SECONDS = 4;
const PERIOD_SECONDS = 12;
const step = (s: string) => console.log(`\n${s}`);

// A second Aperture in front of the same seller; only the subscribed service gets a timeout.
const base = join(DEMO, "aperture-sub");
mkdirSync(base, { recursive: true });
writeFileSync(join(DEMO, "aperture-sub.yaml"), `listenaddr: "127.0.0.1:8702"
insecure: true
autocert: false
debuglevel: "info"
strictverify: true
dbbackend: "sqlite"
sqlite:
  databasefilename: "${base}/aperture.db"
authenticator:
  network: "regtest"
  lndhost: "127.0.0.1:10020"
  tlspath: "${DEMO}/seller/tls.cert"
  macdir: "${DEMO}/seller/data/chain/bitcoin/regtest"
services:
  - name: "catalog"
    hostregexp: '.*'
    pathregexp: '^/\\.well-known/.*$'
    address: "127.0.0.1:8701"
    protocol: http
    price: 0
    authwhitelistpaths: ['^/\\.well-known/.*$']
  - name: "hashprice"
    hostregexp: '.*'
    pathregexp: '^/v1/hashprice.*$'
    address: "127.0.0.1:8701"
    protocol: http
    price: 10
    timeout: ${TIMEOUT_SECONDS}
`);
const aperture = Bun.spawn([resolve(ROOT, ".bin/aperture"), `--configfile=${join(DEMO, "aperture-sub.yaml")}`, `--basedir=${base}`],
	{ stdout: Bun.file(join(DEMO, "logs/aperture-sub.log")), stderr: "inherit" });
writeFileSync(join(DEMO, "aperture-sub.pid"), String(aperture.pid)); // down.sh stops it if this script dies
let client: Client | undefined;
try {
	for (let i = 0; ; i++) {
		if ((await fetch(`${API}/.well-known/l402.json`).catch(() => undefined))?.ok) break;
		if (i > 120) throw new Error("second Aperture did not start; see logs/aperture-sub.log");
		await Bun.sleep(250);
	}

	step(`1. Aperture's timeout setting adds an expiry caveat (source claim, checked live)`);
	const caveatsAt = async (origin: string) => {
		const res = await fetch(`${origin}/v1/hashprice`);
		assert.equal(res.status, 402);
		return macaroonCaveats(parseChallenge(res.headers.get("www-authenticate"))!.macaroon);
	};
	const minted = Math.floor(Date.now() / 1000);
	const timed = await caveatsAt(API);
	const expiry = timed.map(c => c.match(/^hashprice_valid_until=(\d+)$/)?.[1]).find(Boolean);
	assert(expiry, `no hashprice_valid_until caveat in ${timed.map(c => c.split("=")[0]).join(", ")}`);
	assert(Math.abs(Number(expiry) - minted - TIMEOUT_SECONDS) <= 1, "expiry is not mint time plus the service timeout");
	const untimed = await caveatsAt("http://127.0.0.1:8700");
	assert(!untimed.some(c => c.includes("_valid_until")), "the service without a timeout still got an expiry caveat");
	console.log(`  timeout ${TIMEOUT_SECONDS}s: caveats ${timed.map(c => c.split("=")[0]).join(", ")}; valid_until = mint + ${Number(expiry) - minted}s`);
	console.log(`  no timeout: caveats ${untimed.map(c => c.split("=")[0]).join(", ")}`);

	let prompts = 0;
	client = new Client({ name: "subscription-smoke", version: "0" }, { capabilities: { elicitation: {} } });
	client.setRequestHandler(ElicitRequestSchema, async req => {
		prompts++;
		console.log(`  [human] approves: ${req.params.message}`);
		return { action: "accept", content: { approve: true } };
	});
	await client.connect(new StdioClientTransport({ command: "bun", args: [resolve(ROOT, "agent/server.ts")], env: {
		...process.env as Record<string, string>, L402_STATE_DIR: mkdtempSync(join(tmpdir(), "l402-sub-smoke-")),
		L402_AUTO_APPROVE_SATS: "0", L402_DAILY_BUDGET_SATS: "1000",
	} }));
	const call = async (name: string, args: Record<string, unknown> = { url: `${API}/v1/hashprice`, max_sats: 100 }) => {
		const r = await client!.callTool({ name, arguments: args });
		const text = (r.content as { text: string }[])[0].text;
		assert(!r.isError, `${name} failed: ${text}`);
		return JSON.parse(text);
	};
	const until = (iso: string, extraMs = 1000) => Bun.sleep(Math.max(0, Date.parse(iso) - Date.now()) + extraMs);

	step(`2. Approve once: up to 20 sats per ${PERIOD_SECONDS}s period for 3 periods (auto-approval is 0)`);
	const { subscription } = await call("l402_subscribe", { url: `${API}/v1/hashprice`, cap_sats_per_period: 20, periods: 3, period_seconds: PERIOD_SECONDS });
	assert.equal(prompts, 1);
	const periodEnd = (k: number) => Date.parse(subscription.starts_at) + (k + 1) * PERIOD_SECONDS * 1000;

	step("3. First fetch pays under the standing approval, without a prompt");
	const first = await call("l402_fetch");
	assert.equal(first.status, 200);
	assert.equal(first.payment.approval, "standing");
	assert.equal(first.payment.period, 0);
	assert.equal(first.payment.amount_sat, 10);
	assert.equal(prompts, 1);
	console.log(`  paid ${first.payment.amount_sat} + ${first.payment.fee_sat} sats; credential valid until ${first.payment.valid_until}`);

	step("4. Fetch again: reuse the credential");
	assert.equal((await call("l402_fetch")).payment.reused_paid_token, true);

	step("5. Credential expires inside period 0: Aperture answers 402, renewal refused for this period");
	await until(first.payment.valid_until);
	assert(Date.now() < periodEnd(0), "period 0 ended before the credential expired; timing assumption broken");
	const lapsed = await call("l402_fetch");
	assert.equal(lapsed.outcome, "refused");
	assert.match(lapsed.reason, /already renewed for period 0/);
	console.log(`  ${lapsed.reason}`);

	step("6. Period 1 begins: the expired credential renews without a prompt");
	await Bun.sleep(Math.max(0, periodEnd(0) - Date.now()) + 500);
	const renewed = await call("l402_fetch");
	assert.equal(renewed.status, 200);
	assert.equal(renewed.payment.period, 1);
	assert.equal(renewed.payment.approval, "standing");
	assert.equal(prompts, 1);
	console.log(`  paid ${renewed.payment.amount_sat} + ${renewed.payment.fee_sat} sats for period 1`);

	step("7. Cancel: the paid credential still works until it expires, then nothing renews");
	const listed = await call("l402_subscriptions", { cancel: subscription.id });
	assert.equal(listed.subscriptions[0].state, "cancelled");
	const reused = await call("l402_fetch");
	assert.equal(reused.payment.reused_paid_token, true);
	await until(reused.payment.valid_until);
	const stopped = await call("l402_fetch");
	assert.equal(stopped.reason, "subscription cancelled; no renewal");
	console.log(`  ${stopped.reason}`);

	step("8. Reconcile receipts with independent buyer and seller records");
	const wallet = await call("l402_wallet");
	const paid = wallet.recent_receipts.filter((r: { outcome: string }) => r.outcome === "paid");
	assert.equal(paid.length, 2);
	assert(paid.every((r: { approval: string }) => r.approval === "standing"));
	const backend = lndWallet(ROOT, DEMO);
	for (const payment of [first.payment, renewed.payment]) {
		const status = await backend.lookup({ paymentHash: payment.payment_hash, amountSat: payment.amount_sat });
		assert(status.state === "paid");
		assert.equal(status.result.feeSat, payment.fee_sat);
		assert.equal(createHash("sha256").update(Buffer.from(status.result.preimage!, "hex")).digest("hex"), payment.payment_hash);
		const lookup = Bun.spawn([resolve(ROOT, ".bin/lncli"), `--lnddir=${resolve(DEMO, "seller")}`,
			"--network=regtest", "--rpcserver=127.0.0.1:10020", "lookupinvoice", payment.payment_hash], { stdout: "pipe", stderr: "pipe" });
		const invoice = JSON.parse(await new Response(lookup.stdout).text());
		assert.equal(await lookup.exited, 0);
		assert.equal(invoice.state, "SETTLED");
		assert.equal(Number(invoice.amt_paid_sat), payment.amount_sat);
	}
	console.log(`  2 standing-approval payments, 1 prompt; buyer settlement, preimages, fees, and seller invoices agree.`);
	console.log("\nSubscription smoke test passed.");
} finally {
	await client?.close();
	aperture.kill();
	await aperture.exited;
	rmSync(join(DEMO, "aperture-sub.pid"), { force: true });
}
