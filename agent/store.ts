import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { decide, type Policy, type Receipt, spentToday } from "./policy";
import type { Task } from "./request";
import { periodAt, periodKey, subscriptionState, type Subscription } from "./subscription";
import type { Paid, Quote } from "./wallet";

export type Purchase = Receipt & { key: string; macaroon: string; quote: Quote; fee_limit_sat: number;
	/** Set when a standing approval, not a prompt, authorized this purchase. */
	subscription?: { id: string; period: number } };

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
			CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL, duration_ms REAL);
			CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY);
			CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS renewals (subscription_id TEXT NOT NULL, period INTEGER NOT NULL, payment_hash TEXT NOT NULL,
				PRIMARY KEY (subscription_id, period));`);
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
	forKey(key: string): Purchase | undefined {
		return this.purchases().find(p => p.key === key && p.outcome !== "failed");
	}
	token(key: string): string | undefined {
		return (this.db.query("SELECT value FROM tokens WHERE key=?").get(key) as { value: string } | null)?.value;
	}
	task(id: string): Task {
		const row = this.db.query("SELECT data FROM tasks WHERE id=?").get(id) as { data: string } | null;
		if (!row) throw new Error("Unknown request");
		return JSON.parse(row.data);
	}
	tasks(): Task[] {
		return (this.db.query("SELECT data FROM tasks ORDER BY rowid DESC").all() as { data: string }[]).map(r => JSON.parse(r.data));
	}
	createTask(task: Task) {
		this.db.query("INSERT INTO tasks VALUES (?, ?)").run(task.id, JSON.stringify(task));
		this.event(task.id, "created");
	}
	updateTask(id: string, update: (task: Task) => void) {
		return this.db.transaction(() => {
			const task = this.task(id);
			const previous = task.status;
			update(task);
			this.db.query("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(task), id);
			if (task.status !== previous) this.event(id, task.status);
			return task;
		}).immediate();
	}
	event(id: string, kind: string, durationMs?: number) {
		this.db.query("INSERT INTO events(task_id, ts, kind, duration_ms) VALUES (?, ?, ?, ?)")
			.run(id, new Date().toISOString(), kind, durationMs ?? null);
	}
	events(id: string) {
		return this.db.query("SELECT ts, kind, duration_ms FROM events WHERE task_id=? ORDER BY id").all(id);
	}
	taskSpent(id: string) {
		return this.ledger().filter(r => r.task_id === id && (r.outcome === "paid" || r.outcome === "pending"))
			.reduce((n, r) => n + r.amount_sat + r.fee_sat, 0);
	}
	checkTask(id: string, href: string, amount = 0, fee = 0) {
		const task = this.task(id);
		if (task.status !== "running") throw new Error("Task is not running; no new purchases allowed");
		if (!task.resourcePath || href !== task.provider + task.resourcePath) throw new Error("Resource is outside the approved task plan");
		if (this.taskSpent(id) + amount + fee > task.budgetSat) throw new Error("Purchase exceeds the remaining task budget");
		return task;
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
	periodSpent(id: string, period: number) {
		return this.purchases().filter(p => p.subscription?.id === id && p.subscription.period === period &&
			(p.outcome === "paid" || p.outcome === "pending")).reduce((n, p) => n + p.amount_sat + p.fee_sat, 0);
	}
	private checkSubscription(p: Purchase, now: Date) {
		if (!p.subscription) return;
		if (p.task_id) throw new Error("request-bound purchases cannot use a subscription");
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
			if (p.task_id) {
				const task = this.checkTask(p.task_id, p.url, p.amount_sat, p.fee_limit_sat);
				if (p.amount_sat + p.fee_limit_sat > task.autoApproveSat && p.approval !== "human") throw new Error("human approval required for task");
			}
			const ledger = this.ledger();
			if (ledger.some(r => (r.outcome === "paid" || r.outcome === "pending") &&
				(r.payment_hash === p.payment_hash || `${new URL(r.url).origin} ${r.service}` === p.key)))
				throw new Error("previous payment exists for this service; automatic repayment blocked");
			const d = decide(p.amount_sat, maxSats, spentToday(ledger, now), policy, p.fee_limit_sat);
			if (d.kind === "refuse") throw new Error(d.reason);
			if (d.kind === "ask" && p.approval !== "human" && !p.subscription) throw new Error("human approval required");
			this.checkSubscription(p, now);
			p.ts = now.toISOString();
			p.outcome = "pending";
			p.fee_sat = p.fee_limit_sat;
			const id = this.record(p);
			this.db.query("INSERT INTO purchases VALUES (?, ?, ?, ?)").run(p.payment_hash, p.key, id, JSON.stringify(p));
			if (p.task_id) this.event(p.task_id, "payment_reserved");
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
			if (p.task_id) this.event(p.task_id, `payment_${p.outcome}`);
			this.db.query("UPDATE receipts SET data=? WHERE id=?").run(JSON.stringify(this.receipt(p)), row.receipt_id);
		}).immediate();
	}
	close() { this.db.close(); }
}
