import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { decide, type Policy, type Receipt, spentToday } from "./policy";
import type { Paid, Quote } from "./wallet";

export type Purchase = Receipt & { key: string; macaroon: string; quote: Quote; fee_limit_sat: number };

export class Store {
	readonly db: Database;
	constructor(dir: string) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		this.db = new Database(join(dir, "payments.sqlite"));
		chmodSync(join(dir, "payments.sqlite"), 0o600);
		this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
			CREATE TABLE IF NOT EXISTS receipts (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS purchases (hash TEXT PRIMARY KEY, key TEXT NOT NULL, receipt_id INTEGER NOT NULL, data TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS tokens (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY);`);
		this.db.transaction(() => {
			if (this.db.query("SELECT key FROM metadata WHERE key='imported'").get()) return;
			const ledger = join(dir, "receipts.jsonl");
			if (existsSync(ledger)) {
				for (const line of readFileSync(ledger, "utf8").split("\n").filter(Boolean)) {
					const r = JSON.parse(line) as Receipt;
					// Old ambiguous receipts cannot be reconciled without their original challenge.
					if (r.outcome === "paid" && r.reason?.includes("pending")) { r.outcome = "pending"; r.fee_sat = Math.max(r.fee_sat, 10); }
					this.record(r);
				}
			}
			const tokens = join(dir, "tokens.json");
			if (existsSync(tokens)) for (const [key, value] of Object.entries(JSON.parse(readFileSync(tokens, "utf8"))))
				this.db.query("INSERT INTO tokens VALUES (?, ?)").run(key, String(value));
			this.db.query("INSERT INTO metadata VALUES ('imported')").run();
		}).immediate();
	}
	record(r: Receipt) {
		return this.db.query("INSERT INTO receipts(data) VALUES (?)").run(JSON.stringify(this.receipt(r))).lastInsertRowid;
	}
	private receipt(r: Receipt): Receipt {
		return { ts: r.ts, url: r.url, service: r.service, amount_sat: r.amount_sat, fee_sat: r.fee_sat,
			payment_hash: r.payment_hash, approval: r.approval, outcome: r.outcome, wallet: r.wallet,
			proof_of_payment: r.proof_of_payment, reason: r.reason };
	}
	ledger(): Receipt[] {
		return (this.db.query("SELECT data FROM receipts ORDER BY id").all() as { data: string }[]).map(r => JSON.parse(r.data));
	}
	purchases(): Purchase[] {
		return (this.db.query("SELECT data FROM purchases").all() as { data: string }[]).map(r => JSON.parse(r.data));
	}
	forKey(key: string): Purchase | undefined {
		return this.purchases().find(p => p.key === key && p.outcome !== "failed");
	}
	token(key: string): string | undefined {
		return (this.db.query("SELECT value FROM tokens WHERE key=?").get(key) as { value: string } | null)?.value;
	}
	reserve(p: Purchase, maxSats: number, policy: Policy, now = new Date()): void {
		this.db.transaction(() => {
			if (this.forKey(p.key) || this.db.query("SELECT hash FROM purchases WHERE hash=?").get(p.payment_hash))
				throw new Error("purchase already recorded; reconcile it before retrying");
			const ledger = this.ledger();
			if (ledger.some(r => (r.outcome === "paid" || r.outcome === "pending") &&
				(r.payment_hash === p.payment_hash || `${new URL(r.url).origin} ${r.service}` === p.key)))
				throw new Error("previous payment exists for this service; automatic repayment blocked");
			const d = decide(p.amount_sat, maxSats, spentToday(ledger, now), policy, p.fee_limit_sat);
			if (d.kind === "refuse") throw new Error(d.reason);
			if (d.kind === "ask" && p.approval !== "human") throw new Error("human approval required");
			p.ts = now.toISOString();
			p.outcome = "pending";
			p.fee_sat = p.fee_limit_sat;
			const id = this.record(p);
			this.db.query("INSERT INTO purchases VALUES (?, ?, ?, ?)").run(p.payment_hash, p.key, id, JSON.stringify(p));
		}).immediate();
	}
	finish(hash: string, result: Paid | "failed", now = new Date()): void {
		this.db.transaction(() => {
			const row = this.db.query("SELECT data, receipt_id FROM purchases WHERE hash=?").get(hash) as { data: string; receipt_id: number };
			if (!row) throw new Error("unknown payment");
			const p: Purchase = JSON.parse(row.data);
			if (p.outcome !== "pending" && !(p.outcome === "paid" && !p.proof_of_payment && result !== "failed")) return;
			if (result === "failed") {
				p.outcome = "failed";
				p.fee_sat = 0;
			} else {
				if (!Number.isSafeInteger(result.feeSat) || result.feeSat < 0) throw new Error("invalid settlement fee; reservation retained");
				if (p.outcome === "pending") p.ts = now.toISOString();
				p.outcome = "paid";
				p.fee_sat = result.feeSat;
				const proof = result.preimage;
				p.proof_of_payment = !!proof && /^[0-9a-f]{64}$/i.test(proof) &&
					createHash("sha256").update(Buffer.from(proof, "hex")).digest("hex") === hash;
				if (p.proof_of_payment) {
					p.preimage = proof;
					delete p.reason;
					this.db.query("INSERT OR REPLACE INTO tokens VALUES (?, ?)").run(p.key, `L402 ${p.macaroon}:${proof}`);
				} else p.reason = "payment settled without valid L402 proof; automatic repayment blocked";
				if (result.feeSat > p.fee_limit_sat) p.reason = "wallet exceeded the authorized fee limit";
			}
			this.db.query("UPDATE purchases SET data=? WHERE hash=?").run(JSON.stringify(p), hash);
			this.db.query("UPDATE receipts SET data=? WHERE id=?").run(JSON.stringify(this.receipt(p)), row.receipt_id);
		}).immediate();
	}
	close() { this.db.close(); }
}
