import { z } from "zod";

const sats = z.number().int().min(0).max(1_000_000);
export const taskInput = z.object({
 resourcePath: z.string().min(1).max(2048).refine(path => {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\#\s]/.test(path)) return false;
  const url = new URL(path, "https://provider.invalid");
  return url.origin === "https://provider.invalid" && url.pathname + url.search === path;
 }, "Use an absolute resource path without fragments or traversal"),
 budgetSat: sats,
 autoApproveSat: sats,
}).strict();
export type TaskInput = z.infer<typeof taskInput>;
// Keep the stored task IDs and table names so existing payment references remain intact.
export type Task = Omit<TaskInput, "resourcePath"> & {
 resourcePath?: string;
 id: string; createdAt: string; provider: string;
 status: "ready" | "running" | "awaiting_approval" | "interrupted" | "stopped" | "blocked" | "complete";
 response?: unknown;
 approval?: { id: string; message: string; decision: "pending" | "approved" | "declined" | "expired" };
 delivery?: { status: "received" | "invalid" | "unavailable"; paymentHash?: string; reused: boolean; reason?: string };
 error?: string;
};
