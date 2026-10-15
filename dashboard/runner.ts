import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "node:path";
import { Store } from "../agent/store";

type ActiveRun = { client: Client; done: Promise<void>; approval?: (approve: boolean) => void };

export class RequestRunner {
	private active = new Map<string, ActiveRun>();
	constructor(readonly store: Store, readonly stateDir: string, readonly env: Record<string, string> = process.env as Record<string, string>) {}
	isActive(id: string) { return this.active.has(id); }
	answer(id: string, approvalId: string, approve: boolean) {
		const task = this.store.task(id);
		const active = this.active.get(id);
		if (task.status !== "awaiting_approval" || task.approval?.id !== approvalId || !active?.approval)
			throw new Error("Approval expired; resume the request to request a new quote");
		this.store.updateTask(id, t => { t.approval!.decision = approve ? "approved" : "declined"; t.status = "running"; });
		active.approval(approve);
	}
	stop(id: string) {
		this.store.updateTask(id, t => {
			if (t.status === "complete") throw new Error("Request is already complete");
			t.status = "stopped";
			if (t.approval?.decision === "pending") t.approval.decision = "expired";
		});
		this.active.get(id)?.approval?.(false);
	}
	async run(id: string) {
		if (this.active.has(id)) throw new Error("Request is already active");
		const task = this.store.updateTask(id, t => {
			if (!t.resourcePath || t.status === "complete") throw new Error("Request cannot run");
			t.status = "running"; delete t.error;
			if (t.approval?.decision === "pending") t.approval.decision = "expired";
		});
		const started = performance.now();
		const client = new Client({ name: "l402-resource-viewer", version: "1" }, { capabilities: { elicitation: {} } });
		let finished!: () => void;
		const done = new Promise<void>(resolve => { finished = resolve; });
		const active: ActiveRun = { client, done };
		this.active.set(id, active);
		client.setRequestHandler(ElicitRequestSchema, async req => {
			if (this.store.task(id).status === "stopped") return { action: "decline" };
			this.store.updateTask(id, t => { t.status = "awaiting_approval"; t.approval = {
				id: crypto.randomUUID(), message: req.params.message, decision: "pending",
			}; });
			const approve = await new Promise<boolean>(resolve => {
				const timer = setTimeout(() => resolve(false), 120_000);
				active.approval = value => { clearTimeout(timer); resolve(value); };
			});
			delete active.approval;
			this.store.updateTask(id, t => {
				if (t.approval?.decision === "pending") t.approval.decision = "expired";
				if (t.status === "awaiting_approval") t.status = "running";
			});
			return { action: "accept", content: { approve } };
		});

		try {
			await client.connect(new StdioClientTransport({ command: process.execPath,
				args: [resolve(import.meta.dir, "../agent/server.ts")], stderr: "ignore",
				env: { ...this.env, L402_STATE_DIR: this.stateDir, L402_TASK_ID: id } }));
			const url = task.provider + task.resourcePath;
			const fetchStarted = performance.now();
			const result = await client.callTool({ name: "l402_fetch", arguments: {
				url, max_sats: Math.max(1, task.budgetSat), method: "GET",
			} }, undefined, { timeout: 240_000 });
			this.store.event(id, "l402_fetch", performance.now() - fetchStarted);
			const content = result.content?.[0];
			if (result.isError || content?.type !== "text") throw new Error("Payment service could not complete this request; inspect payment records before retrying");
			const response = JSON.parse(content.text);
			const received = response.status >= 200 && response.status < 300 && (response.resource_delivered === true || response.payment === null);
			this.store.updateTask(id, t => {
				t.delivery = { status: received ? "received" : "unavailable", paymentHash: response.payment?.payment_hash ?? response.payment_hash,
					reused: response.payment?.reused_paid_token === true,
					reason: received ? undefined : "No response delivered. Check payment and approval records before resuming." };
			});
			if (!received) {
				this.store.event(id, "delivery_unavailable");
				throw new Error(response.outcome === "declined" ? "Purchase was not approved" : "Resource unavailable; payment may still be reserved or settled");
			}
			this.store.event(id, "delivery_received");
			this.store.updateTask(id, t => { t.response = response.body; if (t.status !== "stopped") t.status = "complete"; });
		} catch (e) {
			this.store.updateTask(id, t => { if (t.status !== "stopped") t.status = "blocked";
				t.error = e instanceof Error ? e.message : "Request interrupted"; });
		} finally {
			this.store.event(id, "run_finished", performance.now() - started);
			try { await client.close(); } finally { this.active.delete(id); finished(); }
		}
	}
	async close() {
		for (const [id, a] of this.active) {
			if (this.store.task(id).status !== "complete") this.stop(id);
			await a.client.close(); await a.done;
		}
	}
}
