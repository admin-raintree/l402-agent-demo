import { resolve } from "node:path";
import { Store } from "../agent/store";
import { spentToday } from "../agent/policy";
import { taskInput, type Task } from "../agent/request";
import { RequestRunner } from "./runner";

export function startDashboard(options: { stateDir?: string; port?: number; env?: Record<string, string> } = {}) {
	const env = options.env ?? process.env as Record<string, string>;
	const stateDir = options.stateDir ?? env.L402_STATE_DIR ?? resolve(env.L402_DEMO_DIR ?? resolve(import.meta.dir, "../.demo"), "agent");
	const providerUrl = new URL(env.L402_PROVIDER_URL ?? "http://127.0.0.1:8700");
	if (!["http:", "https:"].includes(providerUrl.protocol) || providerUrl.username || providerUrl.password) throw new Error("Invalid configured provider");
	const provider = providerUrl.origin;
	const dailyBudget = Number(env.L402_DAILY_BUDGET_SATS ?? 5000);
	const autoLimit = Number(env.L402_AUTO_APPROVE_SATS ?? 100);
	if (![dailyBudget, autoLimit].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Invalid operator policy");
	const store = new Store(stateDir);
	const ownerKey = `dashboard:${process.pid}`;
	let ownsState = false;
	try {
		store.db.transaction(() => {
			for (const row of store.db.query("SELECT key FROM metadata WHERE key LIKE 'dashboard:%'").all() as { key: string }[]) {
				let live = true;
				try { process.kill(Number(row.key.split(":")[1]), 0); }
				catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") live = false; }
				if (live) throw new Error("A dashboard already owns this state directory");
				store.db.query("DELETE FROM metadata WHERE key=?").run(row.key);
			}
			store.db.query("INSERT INTO metadata VALUES (?)").run(ownerKey);
		}).immediate();
		ownsState = true;
		const runner = new RequestRunner(store, stateDir, env);
		for (const task of store.tasks()) if (["running", "awaiting_approval"].includes(task.status)) store.updateTask(task.id, t => {
			t.status = "interrupted"; t.error = "Server restarted. Resume to reconcile payments before any new purchase.";
			if (t.approval?.decision === "pending") t.approval.decision = "expired";
		});
		const view = (t: Task) => ({ ...t, committedSat: store.taskSpent(t.id), active: runner.isActive(t.id),
			receipts: store.ledger().filter(r => r.task_id === t.id), events: store.events(t.id) });
		const server = Bun.serve({
			hostname: "127.0.0.1", port: options.port ?? Number(env.PORT ?? 8787), maxRequestBodySize: 16_384,
			async fetch(req) {
				const url = new URL(req.url);
				const origin = `http://127.0.0.1:${server.port}`;
				if (req.headers.get("host") !== `127.0.0.1:${server.port}`) return new Response("Invalid host", { status: 403 });
				const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff",
					"content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
				const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
				try {
					if (req.method === "GET") {
						if (url.pathname === "/api/tasks") return json({ tasks: store.tasks().map(view), provider,
							policy: { dailyBudget, autoLimit }, committedToday: spentToday(store.ledger()) });
						const file = { "/": "index.html", "/app.js": "app.js", "/style.css": "style.css" }[url.pathname];
						if (file) return new Response(Bun.file(resolve(import.meta.dir, "../web", file)), { headers });
						return json({ error: "Not found" }, 404);
					}
					if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
					if (req.headers.get("origin") !== origin || !req.headers.get("content-type")?.startsWith("application/json"))
						return json({ error: "Same-origin JSON request required" }, 403);
					if (url.pathname === "/api/tasks") {
						const input = taskInput.parse(await req.json());
						if (input.autoApproveSat > autoLimit || input.budgetSat > dailyBudget) return json({ error: "Request limits exceed the operator policy" }, 400);
						const task: Task = { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString(), provider,
							status: "ready" };
						store.createTask(task); return json(view(task), 201);
					}
					const match = url.pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})\/(run|stop|approval)$/);
					if (!match) return json({ error: "Not found" }, 404);
					const [, id, action] = match;
					const task = store.task(id);
					if (!task.resourcePath) return json({ error: "Archived records are read-only" }, 409);
					if (action === "run") {
						if (runner.isActive(id) || task.status === "complete") return json({ error: "Request is active or complete" }, 409);
						void runner.run(id).catch(() => store.event(id, "runner_error"));
					}
					if (action === "stop") runner.stop(id);
					if (action === "approval") {
						const body = await req.json();
						if (typeof body.approve !== "boolean" || typeof body.id !== "string") return json({ error: "Invalid approval" }, 400);
						runner.answer(id, body.id, body.approve);
					}
					return json(view(store.task(id)));
				} catch { return json({ error: "Request rejected. Check the inputs and current request status." }, 400); }
			},
		});
		return { server, store, runner, async close() {
			server.stop(true);
			try { await runner.close(); }
			finally {
				store.db.query("DELETE FROM metadata WHERE key=?").run(ownerKey);
				store.close();
			}
		} };
	} catch (error) {
		if (ownsState) store.db.query("DELETE FROM metadata WHERE key=?").run(ownerKey);
		store.close();
		throw error;
	}
}
if (import.meta.main) {
	const app = startDashboard();
	console.log(`L402 resource viewer: http://127.0.0.1:${app.server.port}`);
}
