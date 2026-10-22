// Runs a child Bun process from the repository root, so bunfig.toml loads the TLS preload
// exactly as it does for the MCP server, against a self-signed HTTPS wallet gateway.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const dir = mkdtempSync(join(tmpdir(), "l402-tls-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const openssl = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
	"-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-subj", "/CN=127.0.0.1",
	"-addext", "subjectAltName=IP:127.0.0.1"], { stdout: "ignore", stderr: "pipe" });
if (openssl.exitCode !== 0) throw new Error(`openssl could not create a test certificate: ${openssl.stderr}`);

writeFileSync(join(dir, "probe.ts"), `import { readFileSync } from "node:fs";
import { wavelengthWallet } from ${JSON.stringify(join(ROOT, "agent/wallet.ts"))};
const cert = readFileSync(${JSON.stringify(join(dir, "cert.pem"))}, "utf8");
const key = readFileSync(${JSON.stringify(join(dir, "key.pem"))}, "utf8");
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert, key },
	fetch: () => Response.json({ confirmed_sat: "1234" }) });
const url = \`https://127.0.0.1:\${server.port}\`;
const outcome = (p: Promise<unknown>) => p.then(v => v, e => "rejected: " + e.message);
console.log(JSON.stringify({
	preloaded: String(globalThis.fetch).includes("nativeFetch"),
	withGatewayCert: await outcome(wavelengthWallet({ url, tlsCertPath: ${JSON.stringify(join(dir, "cert.pem"))} }).balanceSat()),
	withoutGatewayCert: await outcome(wavelengthWallet({ url }).balanceSat()),
}));
server.stop(true);
`);

test("a gateway's own CA is honored under the preload; other requests still use the bundle", () => {
	const child = Bun.spawnSync([process.execPath, join(dir, "probe.ts")], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
	expect(child.stderr.toString()).toBe("");
	const result = JSON.parse(child.stdout.toString());
	expect(result.preloaded).toBe(true);
	expect(result.withGatewayCert).toBe(1234);
	expect(result.withoutGatewayCert).toMatch(/^rejected: .*self[- ]signed/i);
});
