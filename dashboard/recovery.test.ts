import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { providerFixture } from "../tests/provider";
import { Store } from "../agent/store";

for (const stage of ["approval", "pending", "delivered"] as const) test(`dashboard SIGKILL at ${stage} preserves task and payment history`, async () => {
	const dir = mkdtempSync(join(tmpdir(), "request-crash-"));
	const f = providerFixture();
	const children: ReturnType<typeof Bun.spawn>[] = [];
	const start = async () => {
		const p = Bun.spawn([process.execPath, resolve(import.meta.dir, "server.ts")], { stdout: "pipe", stderr: "pipe",
			env: { ...f.env, L402_STATE_DIR: dir, PORT: "0" } });
		children.push(p);
		const reader = (p.stdout as ReadableStream).getReader();
		const first = await reader.read(); reader.releaseLock();
		const url = new TextDecoder().decode(first.value).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
		if (!url) throw new Error("Dashboard did not start");
		return { p, async api(path: string, body?: unknown) {
			const r = await fetch(url + path, body === undefined ? {} : { method: "POST", headers: { origin: url, "content-type": "application/json" }, body: JSON.stringify(body) });
			expect(r.ok).toBe(true); return r.json();
		} };
	};
	const store = new Store(dir);
	const wait = async (predicate: () => boolean) => {
		for (let i=0;i<400;i++) { if(predicate())return; await Bun.sleep(10); }
		throw new Error("Recovery stage not reached");
	};
	try {
		const a = await start();
		f.state.pending = stage === "pending";
		const task = await a.api("/api/tasks", { resourcePath: "/v1/hashprice", budgetSat: 100, autoApproveSat: stage === "approval" ? 0 : 100 });
		await a.api(`/api/tasks/${task.id}/run`, {});
		await wait(() => store.task(task.id).status === (stage === "approval" ? "awaiting_approval" : stage === "pending" ? "blocked" : "complete"));
		const oldApproval = store.task(task.id).approval?.id;
		a.p.kill("SIGKILL"); await a.p.exited;
		if (stage === "pending") f.entries[0].status = "ENTRY_STATUS_COMPLETE";
		const b = await start();
		if (stage === "delivered") {
			expect(store.task(task.id).status).toBe("complete"); expect(store.task(task.id).response).toMatchObject({ hashprice_usd_per_ph_day: 50 });
		} else {
			if (stage === "approval") { expect(store.task(task.id).status).toBe("interrupted"); expect(store.task(task.id).approval?.decision).toBe("expired"); }
			await b.api(`/api/tasks/${task.id}/run`, {});
			if (stage === "approval") {
				await wait(() => store.task(task.id).status === "awaiting_approval");
				const approval = store.task(task.id).approval!; expect(approval.id).not.toBe(oldApproval);
				await b.api(`/api/tasks/${task.id}/approval`, { id: approval.id, approve: true });
			}
			await wait(() => store.task(task.id).status === "complete");
		}
		expect(f.state.sends).toBe(1); expect(store.taskSpent(task.id)).toBe(23);
		expect(store.ledger().filter(r=>r.outcome==='paid')).toHaveLength(1);
	} finally {
		for (const p of children) if (p.exitCode === null) { p.kill("SIGKILL"); await p.exited; }
		store.close(); f.server.stop(true); rmSync(dir, {recursive:true,force:true});
	}
}, 15_000);
