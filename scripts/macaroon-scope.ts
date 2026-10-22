// Check that the agent's credentials can pay but not administer the buyer node, against a running
// `scripts/up.sh` network. The baked macaroon must list exactly scripts/agent-permissions.txt, and
// both it and the litd account macaroon must be refused node-administration calls on a live node.
// The smoke tests prove the same credentials are sufficient to pay.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DEMO = process.env.L402_DEMO_DIR;
if (!DEMO) throw new Error("L402_DEMO_DIR is required; run scripts/verify-local.sh");
const BIN = resolve(ROOT, ".bin");

async function run(args: string[]) {
	const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, text: (err || out).trim() };
}

const expected = readFileSync(resolve(ROOT, "scripts/agent-permissions.txt"), "utf8").split("\n").filter(Boolean).sort();
const printed = await run([`${BIN}/lncli`, "printmacaroon", "--macaroon_file", `${DEMO}/agent-pay.macaroon`]);
assert.equal(printed.code, 0, printed.text);
assert.deepEqual([...JSON.parse(printed.text).permissions].sort(), expected, "agent-pay.macaroon permissions drifted");
console.log(`agent-pay.macaroon lists exactly ${expected.length} RPCs`);

const credentials = {
	"agent-pay.macaroon via lnd": ["--rpcserver=127.0.0.1:10019", `--tlscertpath=${DEMO}/buyer/tls.cert`, `--macaroonpath=${DEMO}/agent-pay.macaroon`],
	"agent-account.macaroon via litd": ["--rpcserver=127.0.0.1:8443", `--tlscertpath=${DEMO}/lit/tls.cert`, `--macaroonpath=${DEMO}/agent-account.macaroon`],
	"agent-account.macaroon via lnd": ["--rpcserver=127.0.0.1:10019", `--tlscertpath=${DEMO}/buyer/tls.cert`, `--macaroonpath=${DEMO}/agent-account.macaroon`],
};
const adminCalls = [
	["deletepayments", "--all", "--include_non_failed"],
	["updatechanpolicy", "--base_fee_msat=9999", "--fee_rate_ppm=5000", "--time_lock_delta=80"],
	["sendcoins", "--addr=bcrt1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqdku202", "--amt=1000", "--force"],
];
const DENIED = /permission denied|not supported with restricted account macaroons/;
for (const [name, connection] of Object.entries(credentials)) {
	for (const call of adminCalls) {
		const r = await run([`${BIN}/lncli`, "--network=regtest", ...connection, ...call]);
		assert(r.code !== 0 && DENIED.test(r.text), `${name} was not refused ${call[0]}: exit ${r.code}: ${r.text.slice(0, 200)}`);
	}
	console.log(`${name}: refused ${adminCalls.map(c => c[0]).join(", ")}`);
}
