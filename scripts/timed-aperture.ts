// A second Aperture on port 8702 in front of the same seller. Only the hashprice service gets a
// `timeout`, so its credentials carry a `hashprice_valid_until` caveat and expire.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const TIMED_API = "http://127.0.0.1:8702";

export async function startTimedAperture(root: string, demo: string, timeoutSeconds: number) {
	const base = join(demo, "aperture-sub");
	mkdirSync(base, { recursive: true });
	writeFileSync(join(demo, "aperture-sub.yaml"), `listenaddr: "127.0.0.1:8702"
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
  tlspath: "${demo}/seller/tls.cert"
  macdir: "${demo}/seller/data/chain/bitcoin/regtest"
services:
  - name: "catalog"
    hostregexp: '.*'
    pathregexp: '^/\\.well-known/.*$'
    address: "127.0.0.1:${process.env.L402_SELLER_PORT ?? 8701}"
    protocol: http
    price: 0
    authwhitelistpaths: ['^/\\.well-known/.*$']
  - name: "hashprice"
    hostregexp: '.*'
    pathregexp: '^/v1/hashprice.*$'
    address: "127.0.0.1:${process.env.L402_SELLER_PORT ?? 8701}"
    protocol: http
    price: 10
    timeout: ${timeoutSeconds}
`);
	const aperture = Bun.spawn([resolve(root, ".bin/aperture"), `--configfile=${join(demo, "aperture-sub.yaml")}`, `--basedir=${base}`],
		{ stdout: Bun.file(join(demo, "logs/aperture-sub.log")), stderr: "inherit" });
	writeFileSync(join(demo, "aperture-sub.pid"), String(aperture.pid)); // down.sh stops it if the caller dies
	const stop = async () => {
		aperture.kill();
		await aperture.exited;
		rmSync(join(demo, "aperture-sub.pid"), { force: true });
	};
	for (let i = 0; ; i++) {
		if ((await fetch(`${TIMED_API}/.well-known/l402.json`).catch(() => undefined))?.ok) break;
		if (i > 120) {
			await stop();
			throw new Error("second Aperture did not start; see logs/aperture-sub.log");
		}
		await Bun.sleep(250);
	}
	return stop;
}
