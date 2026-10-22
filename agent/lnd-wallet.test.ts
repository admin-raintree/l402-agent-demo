// Runs the lnd backend against a fake lncli that records its arguments, to pin which node,
// certificate, and macaroon each call uses with and without the L402_LND_* overrides.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lndWallet, PaymentFailed, walletFromEnv } from "./wallet";

const root = mkdtempSync(join(tmpdir(), "l402-lncli-"));
const argsFile = join(root, "args");
mkdirSync(join(root, ".bin"));
writeFileSync(join(root, ".bin/lncli"), `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
echo '{"local_balance":{"sat":"40","msat":"40000"}}'
`);
chmodSync(join(root, ".bin/lncli"), 0o755);
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function argsOf(env: Record<string, string | undefined>) {
	expect(await lndWallet(root, "/demo", env).balanceSat()).toBe(40);
	return readFileSync(argsFile, "utf8").trimEnd().split("\n");
}
const defaults = ["--network=regtest", "--rpcserver=127.0.0.1:8443",
	"--tlscertpath=/demo/lit/tls.cert", "--macaroonpath=/demo/agent-account.macaroon", "channelbalance"];

test("without overrides, lncli goes through litd with the agent's account macaroon", async () => {
	expect(await argsOf({})).toEqual(defaults);
});

test("empty overrides keep the defaults", async () => {
	expect(await argsOf({ L402_LND_RPCSERVER: "", L402_LND_TLSCERT: "", L402_LND_MACAROON: "" })).toEqual(defaults);
});

test("overrides point lncli straight at lnd with the scoped macaroon", async () => {
	expect(await argsOf({ L402_LND_RPCSERVER: "127.0.0.1:10019", L402_LND_TLSCERT: "/demo/buyer/tls.cert",
		L402_LND_MACAROON: "/demo/agent-pay.macaroon" })).toEqual(["--network=regtest",
		"--rpcserver=127.0.0.1:10019", "--tlscertpath=/demo/buyer/tls.cert", "--macaroonpath=/demo/agent-pay.macaroon", "channelbalance"]);
});

test("each override applies on its own", async () => {
	const args = await argsOf({ L402_LND_MACAROON: "/demo/sub-account.macaroon" });
	expect(args).toEqual(defaults.map(a => a.startsWith("--macaroonpath=") ? "--macaroonpath=/demo/sub-account.macaroon" : a));
});

test("walletFromEnv passes the overrides to the lnd backend", async () => {
	const w = walletFromEnv(root, "/demo", { L402_LND_RPCSERVER: "127.0.0.1:10019" });
	expect(w.name).toBe("lnd");
	await w.balanceSat();
	expect(readFileSync(argsFile, "utf8")).toContain("--rpcserver=127.0.0.1:10019\n");
});

// A second fake lncli answers from files named after the subcommand (and listpayments' --index_offset),
// so tests can script litd's refusals and its filtered payment pages.
const scripted = mkdtempSync(join(tmpdir(), "l402-lncli-scripted-"));
mkdirSync(join(scripted, ".bin"));
writeFileSync(join(scripted, ".bin/lncli"), `#!/bin/sh
cmd=$5; offset=""
for a in "$@"; do case "$a" in --index_offset=*) offset="\${a#--index_offset=}";; esac; done
echo "$cmd $offset" >> "${scripted}/calls"
if [ -f "${scripted}/$cmd.err" ]; then cat "${scripted}/$cmd.err" >&2; exit 1; fi
cat "${scripted}/$cmd$offset.out"
`);
chmodSync(join(scripted, ".bin/lncli"), 0o755);
afterAll(() => rmSync(scripted, { recursive: true, force: true }));

function script(files: Record<string, string | object>) {
	for (const f of readdirSync(scripted)) if (f !== ".bin") rmSync(join(scripted, f));
	for (const [name, body] of Object.entries(files)) writeFileSync(join(scripted, name), typeof body === "string" ? body : JSON.stringify(body));
}
const calls = () => readFileSync(join(scripted, "calls"), "utf8").trimEnd().split("\n");
const wallet = () => lndWallet(scripted, "/demo", {});
const quote = { paymentHash: "aa".repeat(32), amountSat: 50 };
const payment = (hash: string, status: string) => ({ payment_hash: hash, status, fee_sat: "1", payment_preimage: "bb".repeat(32) });

test("litd's over-balance refusal is a confirmed payment failure", async () => {
	script({ "payinvoice.err": "[lncli] rpc error: code = Unknown desc = error validating account balance: account balance insufficient" });
	const e = await wallet().pay("lnbcrt1", quote, 10).catch(e => e);
	expect(e).toBeInstanceOf(PaymentFailed);
	expect(e.message).toContain("account balance insufficient");
});

test("litd's expiry error and other lncli errors stay unresolved", async () => {
	for (const err of ["[lncli] rpc error: code = Unknown desc = account 0123456789abcdef has expired",
		"[lncli] rpc error: code = Unavailable desc = connection error",
		// The phrase outside litd's own status, e.g. echoed in other output, is not a refusal.
		"account balance insufficient",
		"[lncli] rpc error: code = Unknown desc = payment failed: account balance insufficient elsewhere"]) {
		script({ "payinvoice.err": err });
		const e = await wallet().pay("lnbcrt1", quote, 10).catch(e => e);
		expect(e).toBeInstanceOf(Error);
		expect(e).not.toBeInstanceOf(PaymentFailed);
	}
});

test("lookup pages past litd's empty filtered pages while the offset advances", async () => {
	script({
		"listpayments0.out": { payments: [], first_index_offset: "1", last_index_offset: "100" },
		"listpayments100.out": { payments: [payment("cc".repeat(32), "SUCCEEDED")], first_index_offset: "101", last_index_offset: "200" },
		"listpayments200.out": { payments: [], first_index_offset: "201", last_index_offset: "300" },
		"listpayments300.out": { payments: [payment(quote.paymentHash, "SUCCEEDED")], first_index_offset: "350", last_index_offset: "350" },
	});
	expect(await wallet().lookup(quote)).toEqual({ state: "paid", result: { feeSat: 1, preimage: "bb".repeat(32) } });
	expect(calls()).toEqual(["listpayments 0", "listpayments 100", "listpayments 200", "listpayments 300"]);
});

test("lookup stops at lnd's empty last page", async () => {
	script({
		"listpayments0.out": { payments: [payment("cc".repeat(32), "FAILED")], first_index_offset: "1", last_index_offset: "1" },
		"listpayments1.out": { payments: [], first_index_offset: "0", last_index_offset: "0" },
	});
	expect(await wallet().lookup(quote)).toEqual({ state: "unknown" });
	expect(calls()).toEqual(["listpayments 0", "listpayments 1"]);
});

test("lookup still rejects pages whose offset does not advance", async () => {
	script({ "listpayments0.out": { payments: [payment("cc".repeat(32), "SUCCEEDED")], last_index_offset: "0" } });
	await expect(wallet().lookup(quote)).rejects.toThrow("invalid lnd payment pagination");
	script({ "listpayments0.out": { payments: [], last_index_offset: "-5" } });
	await expect(wallet().lookup(quote)).rejects.toThrow("invalid lnd payment pagination");
});
