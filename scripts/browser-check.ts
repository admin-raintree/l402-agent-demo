import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../dashboard/server";
import { providerFixture } from "../tests/provider";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const dir = mkdtempSync(join(tmpdir(), "l402-browser-"));
const fixture = providerFixture();
const app = startDashboard({ port: 0, stateDir: join(dir, "state"), env: fixture.env });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors: string[] = [];
page.on("pageerror", (e: Error) => errors.push(e.message));
async function waitText(text: string) { await page.getByText(text, { exact: true }).waitFor(); }
try {
	await page.goto(app.server.url.href);
	assert.equal(await page.getByLabel("Request budget (sats)").inputValue(), "100");
 const budgetBounds = await page.getByLabel("Request budget (sats)").boundingBox();
 const approvalBounds = await page.getByLabel("Auto-approval limit (sats)").boundingBox();
 assert(approvalBounds.y > budgetBounds.y, "Spending controls stack in the setup sidebar");
 await waitText("5,000 sats");
 assert.equal(await page.locator("#daily-spent").textContent(), "0 sats");
 await page.getByLabel("Resource path").fill("/v1/hashprice");
	await page.getByLabel("Auto-approval limit (sats)").fill("0");
	await page.getByRole("button", { name: "Create request" }).click();
 await waitText("Ready to fetch");
 const originalId=await page.locator(".task").getAttribute("data-task");
 const flow = page.getByRole("region", { name: "Request flow", exact: true });
 assert.equal(await flow.getAttribute("data-request-id"), originalId);
 assert.equal(await flow.locator("li").count(), 4);
 assert.match(await flow.innerText(), /Ready to start/);
 assert.equal(await page.locator("table").count(), 0, "Hide the payment table until a receipt exists");
 const technical = page.locator("details").filter({ has: page.locator("summary", { hasText: "Technical details" }) });
 assert.equal(await technical.evaluate((el: HTMLDetailsElement) => el.open), false);
 await technical.locator("summary").focus();
 await page.keyboard.press("Enter");
 assert.equal(await technical.locator("li").count(), 1);
 await page.getByRole("button", { name: "Refresh", exact: true }).click();
 assert.equal(await technical.evaluate((el: HTMLDetailsElement) => el.open), true);
 await page.getByText("Technical details", { exact: true }).click();
 await page.screenshot({ path: join(dir, "desktop-ready.png"), fullPage: true });
	await page.getByRole("button", { name: "Start request" }).click();
	await page.getByRole("button", { name: "Decline payment" }).waitFor();
 assert.match(await flow.innerText(), /Review the payment/);
	await page.getByRole("button", { name: "Decline payment" }).click();
	await waitText("blocked"); assert.equal(fixture.state.sends, 0);
	await page.getByRole("button", { name: "Resume and reconcile" }).click();
	await page.getByRole("button", { name: "Approve payment" }).waitFor();
	await page.getByRole("button", { name: "Stop request" }).click();
	await waitText("stopped"); assert.equal(fixture.state.sends, 0);
	await page.getByRole("button", { name: "Resume and reconcile" }).click();
	const approve = page.getByRole("button", { name: "Approve payment" });
	await approve.waitFor();
	await approve.focus();
	await page.waitForTimeout(1700);
	assert.equal(await approve.evaluate((el: HTMLElement) => el === document.activeElement), true, "Polling must preserve keyboard focus");
	await page.screenshot({ path: join(dir, "desktop-approval.png"), fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "No horizontal overflow on mobile");
	await page.evaluate(() => new Promise<void>(resolve => { window.scrollTo(0, 0); requestAnimationFrame(() => requestAnimationFrame(() => resolve())); }));
 await page.screenshot({ path: join(dir, "mobile-top.png") });
	await approve.scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(dir, "mobile-approval.png") });
	await approve.focus(); await page.keyboard.press("Enter");
	await waitText("complete"); assert.equal(fixture.state.sends, 1);
 assert.match(await flow.innerText(), /Response received/);
 assert.equal(await flow.locator('li[data-state="done"]').count(), 4);
 await waitText("4,977 sats");
 assert.equal(await page.locator("#daily-spent").textContent(), "23 sats");
 assert.equal(await page.locator("table").count(), 1);
 const payments = page.locator("details").filter({ has: page.locator("summary", { hasText: "Payment records" }) });
 assert.equal(await payments.locator("li").count(), 0, "Event timings are separate from payment records");
 await payments.locator("summary").click();
 assert(await payments.locator("tbody tr").count() > 0);
 assert.equal(await technical.evaluate((el: HTMLDetailsElement) => el.open), false);
	await page.getByRole("heading", { name: "Response", exact: true }).waitFor();
	assert((await page.locator("pre").innerText()).includes("hashprice_usd_per_ph_day"), "Display the provider response");
	assert.equal(await page.locator("[role=status]").count(), 1);
	assert.equal(await page.locator("h1").count(), 1);
	const violations = await page.evaluate(() => {
		const issues: string[] = [];
		if (document.documentElement.lang !== "en") issues.push("Missing document language");
		for (const element of document.querySelectorAll<HTMLInputElement>("input,select,textarea")) {
			if (!element.labels?.length && !element.getAttribute("aria-label")) issues.push(`Unnamed field ${element.id}`);
		}
		for (const element of document.querySelectorAll("button,a,summary")) {
			if (!(element.textContent?.trim() || element.getAttribute("aria-label"))) issues.push("Unnamed action");
		}
		for (const th of document.querySelectorAll("th")) if (!th.hasAttribute("scope")) issues.push("Table header without scope");
		return issues;
	});
	assert.deepEqual(violations, []);
	await page.setViewportSize({ width: 1440, height: 1050 });
	await page.screenshot({ path: join(dir, "desktop-result.png"), fullPage: true });
 const resource = "/v1/" + "long-resource-name-".repeat(8);
 await page.getByLabel("Resource path").fill(resource);
 await page.getByLabel("Request budget (sats)").fill("1100");
 await page.getByRole("button", { name: "Create request", exact: true }).click();
 const savedRequest = page.locator(".task").filter({ has: page.getByRole("heading", { name: resource, exact: true }) });
 await savedRequest.waitFor();
 await page.getByLabel("Request budget (sats)").fill("100");
 await page.getByRole("button", { name: "Refresh", exact: true }).click();
 assert.match(await savedRequest.locator(".remaining").innerText(), /1100/);
 assert.equal(await page.locator(".task").count(), 1, "One request occupies both panes");
 assert.equal(await page.locator("#selected-request option").count(), 2);
 const secondId=await savedRequest.getAttribute("data-task");
 assert.equal(await flow.getAttribute("data-request-id"), secondId);
 assert.match(await flow.innerText(), /Ready to start/);
 await page.getByRole("combobox", { name: "Request", exact: true }).selectOption(originalId);
 await page.getByRole("button", { name: "Refresh", exact: true }).click();
 assert.equal(await page.locator("#selected-request").inputValue(), originalId);
 assert.equal(await flow.getAttribute("data-request-id"), originalId);
 assert.match(await flow.innerText(), /Response received/);
 await page.getByRole("combobox", { name: "Request", exact: true }).selectOption(secondId);
 assert.equal(await flow.getAttribute("data-request-id"), secondId);
 assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Multiple requests fit the desktop workspace");
 await page.screenshot({ path: join(dir, "desktop-multiple.png"), fullPage: true });
 await page.setViewportSize({ width: 320, height: 740 });
 assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Long resource paths fit narrow screens");
 assert.equal(fixture.state.sends, 1, "Creating another request sends no payment");
 await page.setViewportSize({ width: 1440, height: 1050 });
 await page.getByLabel("Resource path").fill("/v1/hashprice");
 await page.getByLabel("Request budget (sats)").fill("0");
 await page.getByRole("button", { name: "Create request", exact: true }).click();
 await page.getByRole("button", { name: "Start request", exact: true }).click();
 await waitText("complete");
 assert.equal(fixture.state.sends, 1, "Reusing a credential sends no additional payment");
 assert.match(await flow.innerText(), /saved credential was reused/);
 assert.equal(await flow.locator('li[data-state="skipped"]').count(), 2);
 assert.match(await flow.innerText(), /No new payment was sent/);
 assert.match(await flow.innerText(), /Response received/);
 assert.equal(await page.locator("table").count(), 0, "Reused request has no new payment receipt");
 const edgeCases = await page.evaluate(() => {
  const base = { id: 'preview', status: 'running', receipts: [], active: true };
  const cases = [
   { ...base, receipts: [{ outcome: 'pending' }] },
   { ...base, receipts: [{ outcome: 'paid', proof_of_payment: false }] },
   { ...base, approval: { decision: 'approved' } },
   { ...base, status: 'complete', active: false, delivery: { status: 'received' } },
   { ...base, status: 'blocked', active: false, receipts: [{ outcome: 'failed' }] },
  ];
  return cases.map(t => {
   const view = new DOMParser().parseFromString(journey(t), 'text/html');
   return { title: view.querySelector('.journey-next h3').textContent,
    current: view.querySelector('[aria-current="step"] .journey-number')?.textContent,
    skipped: view.querySelectorAll('[data-state="skipped"]').length };
  });
 });
 assert.deepEqual(edgeCases, [
  { title: 'Resolving payment', current: '3', skipped: 0 },
  { title: 'Payment recorded; proof unavailable', current: '3', skipped: 0 },
  { title: 'Approval recorded', current: '3', skipped: 0 },
  { title: 'Response received', current: undefined, skipped: 2 },
  { title: 'Payment failed', current: '3', skipped: 0 },
 ]);
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ passed: true, checks: ["100-sat default", "ready state", "empty payment table hidden", "separate technical details", "daily spending totals", "guided four-step flow", "completed steps", "reuse skips approval and payment", "request selection preserved", "multiple requests", "saved budget preserved", "320px long-path layout", "create", "decline", "stop", "resume", "keyboard approval", "focus preservation", "mobile overflow", "labels", "table semantics", "live status", "response display", "no browser errors"], screenshots: dir }, null, 2));
} finally { await browser.close(); await app.close(); fixture.server.stop(true); }
