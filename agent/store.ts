import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { decide, type Policy, type Receipt } from "./policy";
import { periodAt, periodKey, subscriptionState, type Subscription } from "./subscription";
import type { ResponseCheck } from "./quality";
import type { Paid, Quote } from "./wallet";

export type Purchase = Receipt & { key: string; macaroon: string; quote: Quote; fee_limit_sat: number;
	/** Set when a standing approval, not a prompt, authorized this purchase. */
	subscription?: { id: string; period: number } };

export type TaskBudget = { id: string; name: string; budget_sats: number; created_at: string };

export class Store {
	readonly db: Database;
	constructor(dir: string) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		const dbPath = join(dir, "payments.sqlite");
		this.db = new Database(dbPath);
		chmodSync(dbPath, 0o600);
		this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
			CREATE TABLE IF NOT EXISTS receipts (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS purchases (hash TEXT PRIMARY KEY, key TEXT NOT NULL, receipt_id INTEGER NOT NULL, data TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS tokens (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY);
			CREATE TABLE IF NOT EXISTS response_checks (id TEXT PRIMARY KEY, task_id TEXT, payment_hash TEXT, data TEXT NOT NULL);
			CREATE INDEX IF NOT EXISTS response_checks_task ON response_checks(task_id);
			CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS renewals (subscription_id TEXT NOT NULL, period INTEGER NOT NULL, payment_hash TEXT NOT NULL,
				PRIMARY KEY (subscription_id, period));
			CREATE INDEX IF NOT EXISTS purchases_key ON purchases(key);
			CREATE INDEX IF NOT EXISTS purchases_outcome ON purchases(json_extract(data, '$.outcome'));
			CREATE INDEX IF NOT EXISTS purchases_subscription ON purchases(json_extract(data, '$.subscription.id'), json_extract(data, '$.subscription.period'));
			CREATE INDEX IF NOT EXISTS receipts_outcome_day ON receipts(json_extract(data, '$.outcome'), substr(json_extract(data, '$.ts'), 1, 10));
			CREATE INDEX IF NOT EXISTS receipts_task ON receipts(json_extract(data, '$.task_id'));`);
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
		return { ts: r.ts, task_id: r.task_id, url: r.url, service: r.service, amount_sat: r.amount_sat, fee_sat: r.fee_sat,
			payment_hash: r.payment_hash, approval: r.approval, subscription_id: r.subscription_id, outcome: r.outcome, wallet: r.wallet,
			proof_of_payment: r.proof_of_payment, reason: r.reason };
	}
	ledger(): Receipt[] {
		return (this.db.query("SELECT data FROM receipts ORDER BY id").all() as { data: string }[]).map(r => JSON.parse(r.data));
	}
	purchases(): Purchase[] {
		return (this.db.query("SELECT data FROM purchases").all() as { data: string }[]).map(r => JSON.parse(r.data));
	}
	purchase(hash: string): Purchase | undefined {
		const row = this.db.query("SELECT data FROM purchases WHERE hash=?").get(hash) as { data: string } | null;
		return row ? JSON.parse(row.data) : undefined;
	}
	forKey(key: string): Purchase | undefined {
		return (this.db.query("SELECT data FROM purchases WHERE key=?").all(key) as { data: string }[])
			.map(r => JSON.parse(r.data) as Purchase).find(p => p.outcome !== "failed");
	}
	/** Purchases that still need wallet evidence: pending, or settled without a valid proof. */
	unresolved(): Purchase[] {
		return (this.db.query(`SELECT data FROM purchases WHERE json_extract(data, '$.outcome') = 'pending'
			OR (json_extract(data, '$.outcome') = 'paid' AND NOT coalesce(json_extract(data, '$.proof_of_payment'), 0))`).all() as { data: string }[])
			.map(r => JSON.parse(r.data));
	}
	/** Same total as policy.spentToday(ledger, now), computed in SQLite. */
	spentToday(now = new Date()): number {
		return (this.db.query(`SELECT coalesce(sum(json_extract(data, '$.amount_sat') + json_extract(data, '$.fee_sat')), 0) AS n FROM receipts
			WHERE json_extract(data, '$.outcome') = 'pending'
				OR (json_extract(data, '$.outcome') = 'paid' AND substr(json_extract(data, '$.ts'), 1, 10) = ?)`)
			.get(now.toISOString().slice(0, 10)) as { n: number }).n;
	}
	reservedSat(): number {
		return (this.db.query(`SELECT coalesce(sum(json_extract(data, '$.amount_sat') + json_extract(data, '$.fee_sat')), 0) AS n FROM receipts
			WHERE json_extract(data, '$.outcome') = 'pending'`).get() as { n: number }).n;
	}
	recentReceipts(limit: number): Receipt[] {
		return (this.db.query("SELECT data FROM receipts ORDER BY id DESC LIMIT ?").all(limit) as { data: string }[])
			.map(r => JSON.parse(r.data)).reverse();
	}
	token(key: string): string | undefined {
		return (this.db.query("SELECT value FROM tokens WHERE key=?").get(key) as { value: string } | null)?.value;
	}
	recordResponse(check: ResponseCheck) {
		this.db.query("INSERT INTO response_checks VALUES (?, ?, ?, ?)")
			.run(check.id, check.task_id ?? null, check.payment_hash ?? null, JSON.stringify(check));
	}
	responseChecks(taskId?: string): ResponseCheck[] {
		const rows = taskId === undefined
			? this.db.query("SELECT data FROM response_checks ORDER BY rowid DESC LIMIT 8").all()
			: this.db.query("SELECT data FROM response_checks WHERE task_id=? ORDER BY rowid").all(taskId);
		return (rows as { data: string }[]).map(row => JSON.parse(row.data));
	}
	createTask(task: TaskBudget) {
		if (!Number.isSafeInteger(task.budget_sats) || task.budget_sats <= 0) throw new Error("invalid task budget");
		this.db.query("INSERT INTO tasks VALUES (?, ?)").run(task.id, JSON.stringify(task));
	}
	task(id: string): TaskBudget {
		const row = this.db.query("SELECT data FROM tasks WHERE id=?").get(id) as { data: string } | null;
		if (!row) throw new Error("Unknown task");
		return JSON.parse(row.data);
	}
	taskSummary(id: string) {
		const task = this.task(id);
		const receipts = (this.db.query("SELECT data FROM receipts WHERE json_extract(data, '$.task_id') = ? ORDER BY id").all(id) as { data: string }[])
			.map(r => JSON.parse(r.data) as Receipt);
		const cost = (outcome: Receipt["outcome"]) => receipts.filter(r => r.outcome === outcome)
			.reduce((sum, r) => sum + r.amount_sat + r.fee_sat, 0);
		const settled = cost("paid"), reserved = cost("pending");
		return { ...task, settled_sat: settled, reserved_sat: reserved,
			remaining_sat: Math.max(0, task.budget_sats - settled - reserved), receipts, response_checks: this.responseChecks(id) };
	}
	checkTask(id: string | undefined, cost: number): string | undefined {
		if (!id) return;
		const task = this.taskSummary(id);
		if (cost > task.remaining_sat) return `would exceed task budget: ${task.remaining_sat} of ${task.budget_sats} sats remain`;
	}
	createSubscription(sub: Subscription) {
		this.db.query("INSERT INTO subscriptions VALUES (?, ?)").run(sub.id, JSON.stringify(sub));
	}
	subscription(id: string): Subscription {
		const row = this.db.query("SELECT data FROM subscriptions WHERE id=?").get(id) as { data: string } | null;
		if (!row) throw new Error("Unknown subscription");
		return JSON.parse(row.data);
	}
	subscriptions(): Subscription[] {
		return (this.db.query("SELECT data FROM subscriptions ORDER BY rowid DESC").all() as { data: string }[]).map(r => JSON.parse(r.data));
	}
	/** Newest subscription for a service in any state; a cancelled one still holds a valid credential. */
	subscriptionFor(origin: string, service: string): Subscription | undefined {
		return this.subscriptions().find(s => s.origin === origin && s.service === service);
	}
	cancelSubscription(id: string, now = new Date()): Subscription {
		return this.db.transaction(() => {
			const sub = this.subscription(id);
			if (sub.status === "cancelled") return sub;
			sub.status = "cancelled";
			sub.cancelledAt = now.toISOString();
			this.db.query("UPDATE subscriptions SET data=? WHERE id=?").run(JSON.stringify(sub), id);
			return sub;
		}).immediate();
	}
	/** Newest period that holds a credential. */
	subscriptionToken(sub: Subscription): { token: string; period: number } | undefined {
		for (let k = sub.periods - 1; k >= 0; k--) {
			const token = this.token(periodKey(sub, k));
			if (token) return { token, period: k };
		}
	}
	/** Newest credential bought under any subscription to this service, so re-subscribing never pays for access already held. */
	serviceCredential(origin: string, service: string): { token: string; period: number; subscriptionId: string } | undefined {
		for (const s of this.subscriptions().filter(s => s.origin === origin && s.service === service)) {
			const held = this.subscriptionToken(s);
			if (held) return { ...held, subscriptionId: s.id };
		}
	}
	periodSpent(id: string, period: number) {
		return (this.db.query(`SELECT data FROM purchases WHERE json_extract(data, '$.subscription.id') = ?
			AND json_extract(data, '$.subscription.period') = ?`).all(id, period) as { data: string }[])
			.map(r => JSON.parse(r.data) as Purchase).filter(p => p.outcome === "paid" || p.outcome === "pending")
			.reduce((n, p) => n + p.amount_sat + p.fee_sat, 0);
	}
	private checkSubscription(p: Purchase, now: Date) {
		if (!p.subscription) return;
		const sub = this.subscription(p.subscription.id);
		const state = subscriptionState(sub, now);
		if (state !== "active") throw new Error(`subscription ${state}; renewal refused`);
		const period = p.subscription.period;
		if (periodAt(sub, now) !== period) throw new Error("renewal is outside the current subscription period");
		if (p.approval !== "standing" || p.key !== periodKey(sub, period)) throw new Error("renewal does not match its subscription");
		if (new URL(p.url).origin !== sub.origin || p.service !== sub.service) throw new Error("renewal is for a different provider or service");
		if (sub.nodePubkey && p.quote.destination && p.quote.destination !== sub.nodePubkey)
			throw new Error("renewal invoice pays a different node than the subscription names");
		const spent = this.periodSpent(sub.id, period);
		if (spent + p.amount_sat + p.fee_limit_sat > sub.capSat)
			throw new Error(`renewal would exceed the ${sub.capSat}-sat cap for period ${period}: ${spent} sats already charged or reserved`);
		if (this.db.query("SELECT payment_hash FROM renewals WHERE subscription_id=? AND period=?").get(sub.id, period))
			throw new Error(`subscription already renewed for period ${period}`);
		this.db.query("INSERT INTO renewals VALUES (?, ?, ?)").run(sub.id, period, p.payment_hash);
		p.subscription_id = sub.id;
	}
	reserve(p: Purchase, maxSats: number, policy: Policy, now = new Date()): void {
		this.db.transaction(() => {
			if (p.approval === "standing" && !p.subscription) throw new Error("standing approval requires a subscription");
			if (this.forKey(p.key) || this.db.query("SELECT hash FROM purchases WHERE hash=?").get(p.payment_hash))
				throw new Error("purchase already recorded; reconcile it before retrying");
			// Only paid and pending receipts can block a repayment; legacy imports exist only as receipts.
			const charged = (this.db.query(`SELECT data FROM receipts WHERE json_extract(data, '$.outcome') IN ('paid', 'pending')`)
				.all() as { data: string }[]).map(r => JSON.parse(r.data) as Receipt);
			if (charged.some(r =>
				(r.payment_hash === p.payment_hash || `${new URL(r.url).origin} ${r.service}` === p.key)))
				throw new Error("previous payment exists for this service; automatic repayment blocked");
			const d = decide(p.amount_sat, maxSats, this.spentToday(now), policy, p.fee_limit_sat);
			if (d.kind === "refuse") throw new Error(d.reason);
			if (d.kind === "ask" && p.approval !== "human" && !p.subscription) throw new Error("human approval required");
			const taskRefusal = this.checkTask(p.task_id, p.amount_sat + p.fee_limit_sat);
			if (taskRefusal) throw new Error(taskRefusal);
			this.checkSubscription(p, now);
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
				// A confirmed failure frees the period for a fresh invoice.
				this.db.query("DELETE FROM renewals WHERE payment_hash=?").run(hash);
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
