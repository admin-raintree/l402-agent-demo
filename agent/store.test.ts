import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Purchase } from "./store";
import { decide, spentToday } from "./policy";

const now = new Date("2026-10-15T23:59:59Z");
const tomorrow = new Date("2026-10-16T00:00:01Z");
const policy = { autoApproveSats: 100, dailyBudgetSats: 100 };
const proof = "11".repeat(32);
const hash = createHash("sha256").update(Buffer.from(proof, "hex")).digest("hex");
function purchase(id = hash, amount = 20): Purchase {
	return { ts: now.toISOString(), url: "https://provider.test/data", service: id, key: id, macaroon: "secret",
		wallet: "wavelength", amount_sat: amount, fee_sat: 10, payment_hash: id, approval: "auto", outcome: "pending",
		quote: { paymentHash: id, amountSat: amount }, fee_limit_sat: 10 };
}
function fixture(run: (store: Store, dir: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "l402-store-"));
	const store = new Store(dir);
	try { run(store, dir); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("fees count toward every limit and invalid policy values fail closed", () => {
	expect(decide(95, 100, 0, policy, 10).kind).toBe("refuse");
	expect(decide(90, 200, 1, policy, 10).kind).toBe("refuse");
	expect(decide(95, 200, 0, { ...policy, dailyBudgetSats: 200 }, 10).kind).toBe("ask");
	for (const n of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
		expect(decide(10, 100, 0, { ...policy, dailyBudgetSats: n }, 10).kind).toBe("refuse");
});

test("reservation survives reopen and midnight, settlement is atomic and idempotent", () => fixture((store, dir) => {
	store.reserve(purchase(), 100, policy, now);
	const reopened = new Store(dir);
	try {
		expect(spentToday(reopened.ledger(), tomorrow)).toBe(30);
		expect(() => reopened.reserve(purchase(), 100, policy, tomorrow)).toThrow("already recorded");
		reopened.finish(hash, { feeSat: 3, preimage: proof }, tomorrow);
		reopened.finish(hash, { feeSat: 3, preimage: proof }, tomorrow);
		expect(spentToday(store.ledger(), tomorrow)).toBe(23);
		expect(store.token(hash)).toBe(`L402 secret:${proof}`);
		expect(store.ledger()).toHaveLength(1);
		expect(statSync(join(dir, "payments.sqlite")).mode & 0o777).toBe(0o600);
	} finally { reopened.close(); }
}));

test("failed payments release reservations; invalid proofs never create tokens", () => fixture(store => {
	store.reserve(purchase(), 100, policy, now);
	store.finish(hash, "failed", now);
	expect(spentToday(store.ledger(), now)).toBe(0);
	store.reserve(purchase("22".repeat(32)), 100, policy, now);
	store.finish("22".repeat(32), { feeSat: 0, preimage: proof }, now);
	expect(store.token("22".repeat(32))).toBeUndefined();
	expect(spentToday(store.ledger(), now)).toBe(20);
}));

test("legacy files import once without modification", () => {
	const dir = mkdtempSync(join(tmpdir(), "l402-legacy-"));
	try {
		writeFileSync(join(dir, "receipts.jsonl"), JSON.stringify({ ...purchase(), outcome: "paid", fee_sat: 1 }) + "\n");
		writeFileSync(join(dir, "tokens.json"), JSON.stringify({ old: "credential" }));
		const a = new Store(dir); a.close();
		const b = new Store(dir);
		expect(b.ledger()).toHaveLength(1);
		expect(b.token("old")).toBe("credential"); b.close();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("10,000 seeded fault sequences match an independent allowance model", () => fixture(store => {
	let reservations = 0;
	for (let seed = 1; seed <= 10_000; seed++) {
		store.db.exec("DELETE FROM purchases; DELETE FROM receipts; DELETE FROM tokens;");
		let random = seed;
		const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
		const model = new Map<string, { amount: number; fee: number; pending: boolean; day: string }>();
		let clock = now;
		for (let step = 0; step < 8; step++) {
			if (next() % 5 === 0) clock = tomorrow;
			const day = clock.toISOString().slice(0, 10);
			const total = () => [...model.values()].reduce((sum, p) => sum + (p.pending || p.day === day ? p.amount + p.fee : 0), 0);
			const id = `${seed}-${step}`;
			const amount = next() % 80 + 1;
			if (total() + amount + 10 <= 100) {
				store.reserve(purchase(id, amount), 100, policy, clock);
				model.set(id, { amount, fee: 10, pending: true, day });
				reservations++;
				const fault = next() % 4;
				if (fault === 0) { store.finish(id, "failed", clock); model.delete(id); }
				if (fault === 1) {
					const fee = next() % 11;
					store.finish(id, { feeSat: fee }, clock);
					model.set(id, { amount, fee, pending: false, day });
				}
				// Lost response or missing wallet record keeps the full reservation.
				if (fault >= 2) expect(() => store.reserve(purchase(id, amount), 100, policy, clock)).toThrow();
			} else expect(() => store.reserve(purchase(id, amount), 100, policy, clock)).toThrow();
			expect(spentToday(store.ledger(), clock)).toBe(total());
			expect(total()).toBeLessThanOrEqual(100);
		}
	}
	console.log(`Seeded accounting: 10000 sequences, 80000 transitions, ${reservations} reservations; seed range 1..10000`);
}), 120_000);

for (const stage of ["before-reserve", "inside-reserve", "after-reserve", "inside-settlement", "after-settlement"]) test(`process death ${stage} preserves an atomic ledger`, async () => {
	const dir = mkdtempSync(join(tmpdir(), "l402-crash-"));
	try {
		const code = `import { Store } from ${JSON.stringify(join(import.meta.dir, "store.ts"))};
		const store = new Store(${JSON.stringify(dir)});
		const stop = () => process.kill(process.pid, "SIGKILL");
		const p = ${JSON.stringify(purchase())};
		const reserve = () => store.reserve(p, 100, ${JSON.stringify(policy)}, new Date(${JSON.stringify(now.toISOString())}));
		const finish = () => store.finish(p.payment_hash, { feeSat: 3, preimage: ${JSON.stringify(proof)} }, new Date(${JSON.stringify(now.toISOString())}));
		if (${JSON.stringify(stage)} === "before-reserve") stop();
		if (${JSON.stringify(stage)} === "inside-reserve") store.db.transaction(() => { reserve(); stop(); }).immediate();
		reserve();
		if (${JSON.stringify(stage)} === "after-reserve") stop();
		if (${JSON.stringify(stage)} === "inside-settlement") store.db.transaction(() => { finish(); stop(); }).immediate();
		finish(); stop();`;
		const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
		await child.exited;
		expect(await new Response(child.stderr).text()).toBe("");
		expect(child.signalCode).toBe("SIGKILL");
		const reopened = new Store(dir);
		try {
			const absent = stage === "before-reserve" || stage === "inside-reserve";
			expect(spentToday(reopened.ledger(), now)).toBe(absent ? 0 : stage === "after-settlement" ? 23 : 30);
			expect(!!reopened.token(hash)).toBe(stage === "after-settlement");
			expect(reopened.ledger()).toHaveLength(absent ? 0 : 1);
		} finally { reopened.close(); }
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("late proof repairs access without charging the settlement again", () => fixture(store => {
	store.reserve(purchase(), 100, policy, now);
	store.finish(hash, { feeSat: 3 }, now);
	expect(store.token(hash)).toBeUndefined();
	store.finish(hash, { feeSat: 3, preimage: proof }, tomorrow);
	expect(store.token(hash)).toBe(`L402 secret:${proof}`);
	expect(spentToday(store.ledger(), now)).toBe(23);
	expect(spentToday(store.ledger(), tomorrow)).toBe(0);
}));

test("legacy pending receipts keep fee reserves across midnight and block repayment", () => {
	const dir = mkdtempSync(join(tmpdir(), "l402-legacy-pending-"));
	try {
		const original = { ...purchase(), outcome: "paid", fee_sat: 0, reason: "payment still pending after timeout" };
		writeFileSync(join(dir, "receipts.jsonl"), JSON.stringify(original) + "\n");
		const store = new Store(dir);
		try {
			expect(spentToday(store.ledger(), tomorrow)).toBe(30);
			expect(() => store.reserve(purchase(), 100, policy, tomorrow)).toThrow("previous payment exists");
		} finally { store.close(); }
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
