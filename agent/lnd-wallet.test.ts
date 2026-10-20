// Runs the lnd backend against a fake lncli that records its arguments, to pin which node,
// certificate, and macaroon each call uses with and without the L402_LND_* overrides.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lndWallet, walletFromEnv } from "./wallet";

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
const defaults = ["--network=regtest", "--rpcserver=127.0.0.1:10019",
	"--tlscertpath=/demo/buyer/tls.cert", "--macaroonpath=/demo/agent-pay.macaroon", "channelbalance"];

test("without overrides, lncli gets the demo buyer node and pay-only macaroon", async () => {
	expect(await argsOf({})).toEqual(defaults);
});

test("empty overrides keep the defaults", async () => {
	expect(await argsOf({ L402_LND_RPCSERVER: "", L402_LND_TLSCERT: "", L402_LND_MACAROON: "" })).toEqual(defaults);
});

test("overrides point lncli at litd with an account macaroon", async () => {
	expect(await argsOf({ L402_LND_RPCSERVER: "127.0.0.1:8443", L402_LND_TLSCERT: "/demo/lit/tls.cert",
		L402_LND_MACAROON: "/demo/sub-account.macaroon" })).toEqual(["--network=regtest",
		"--rpcserver=127.0.0.1:8443", "--tlscertpath=/demo/lit/tls.cert", "--macaroonpath=/demo/sub-account.macaroon", "channelbalance"]);
});

test("each override applies on its own", async () => {
	const args = await argsOf({ L402_LND_MACAROON: "/demo/sub-account.macaroon" });
	expect(args).toEqual(defaults.map(a => a.startsWith("--macaroonpath=") ? "--macaroonpath=/demo/sub-account.macaroon" : a));
});

test("walletFromEnv passes the overrides to the lnd backend", async () => {
	const w = walletFromEnv(root, "/demo", { L402_LND_RPCSERVER: "127.0.0.1:8443" });
	expect(w.name).toBe("lnd");
	await w.balanceSat();
	expect(readFileSync(argsFile, "utf8")).toContain("--rpcserver=127.0.0.1:8443\n");
});
