// Render the short README overview and check both walkthrough modes.
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const docs = resolve(import.meta.dir, "../docs");
const assets = join(docs, "assets");
mkdirSync(assets, { recursive: true });
const frames = mkdtempSync(join(tmpdir(), "l402-flow-"));
const fps = 15;
async function encode(name: string, start: number, count: number) {
 const encoder = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-framerate", String(fps),
  "-start_number", String(start), "-i", join(frames, "%04d.png"), "-filter_complex",
  `trim=end_frame=${count},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`,
  "-loop", "-1", join(assets, `${name}.gif`)], { stdout: "inherit", stderr: "inherit" });
 assert.equal(await encoder.exited, 0, `${name} encoding failed`);
}
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
try {
 const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
 const errors: string[] = [];
 page.on("pageerror", (error: Error) => errors.push(error.message));
 const walkthrough = pathToFileURL(join(docs, "payment-flow.html")).href;
 for (const chapter of [1, 6, 7, 11]) {
  await page.goto(`${walkthrough}#details-${chapter}`);
  assert.equal(await page.locator('#number').textContent(), String(chapter).padStart(2, '0'));
  assert.equal(await page.locator('.timeline button').count(), 12);
  assert.equal(await page.evaluate(() => frame), 0);
 }
 await page.goto(`${walkthrough}#details-999`);
 assert.equal(await page.locator('#number').textContent(), '01');
 await page.goto(`${walkthrough}#overview-1`);
 assert.equal(await page.locator(".brand").innerText(), "Raintree Technology");
 assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), "light");
 await page.getByRole("button", { name: "Play walkthrough", exact: true }).click();
 await page.waitForTimeout(300);
 await page.getByRole("button", { name: "Pause", exact: true }).click();
 const paused = await page.evaluate(() => position);
 await page.waitForTimeout(100);
 assert.equal(await page.evaluate(() => position), paused);
 await page.getByRole("button", { name: "Technical walkthrough", exact: true }).click();
 assert.equal(await page.locator(".timeline button").count(), 12);
 await page.getByRole("button", { name: "12. Reuse", exact: true }).click();
 assert.equal(await page.locator("#settled").textContent(), "23");
 await page.getByRole("button", { name: "7. Reserve", exact: true }).click();
 assert.equal(await page.locator("#reserved").textContent(), "30");
 assert.match(await page.locator("#transport").textContent(), /local file access, not HTTP/);
 for (let i = 0; i < 3; i++) {
  await page.getByRole("button", { name: "Play walkthrough", exact: true }).click();
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  assert.equal(await page.evaluate(() => frame), 0);
 }
 await page.emulateMedia({ reducedMotion: "reduce" });
 await page.getByRole("button", { name: "Next chapter", exact: true }).focus();
 await page.keyboard.press("Enter");
 assert.equal(await page.locator("#number").textContent(), "02");
 assert.equal(await page.evaluate(() => frame), 0);
 assert.equal(await page.locator(".packet").isVisible(), false);
 await page.setViewportSize({ width: 390, height: 844 });
 assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
 await page.setViewportSize({ width: 1200, height: 800 });
 await page.emulateMedia({ reducedMotion: "no-preference" });
 for (const mode of ["overview", "details"]) {
  await page.evaluate(value => setMode(value), mode);
  const count = await page.evaluate(() => chapters().length);
  for (let index = 0; index < count; index++) {
   for (const phase of [.1, .5, .9]) {
    await page.evaluate(({index,phase}) => renderAt((index + phase) * chapterDuration()), {index,phase});
    const amounts = await page.locator('#available, #reserved, #settled').allTextContents();
    assert.equal(amounts.reduce((sum: number, value: string) => sum + Number(value), 0), 100);
    assert.equal(await page.locator('.timeline [aria-current="step"]').count(), 1);
    assert.equal(await page.locator('.panel').count(), 2);
    const issues = await page.evaluate(() => {
     const problems: string[] = [];
     const label = byId('message').getBoundingClientRect();
     for (const panel of document.querySelectorAll('.panel')) {
      const bounds = panel.getBoundingClientRect();
      if (label.top < bounds.bottom && label.bottom > bounds.top && label.left < bounds.right && label.right > bounds.left) problems.push('Message overlaps a panel');
      for (const text of panel.querySelectorAll('text')) {
       const box = text.getBoundingClientRect();
       if (box.right > bounds.right - 10) problems.push('Panel text overflows: ' + text.textContent);
      }
     }
     return problems;
    });
    assert.deepEqual(issues, [], `${mode} chapter ${index + 1}`);
   }
  }
 }
 await page.evaluate(() => {setMode('details');document.body.classList.add('capture')});
 for (let index = 0; index < 12; index++) {
  await page.evaluate(i => renderAt((i + .9) * chapterDuration()), index);
  assert(await page.evaluate(() => byId('guard').getBoundingClientRect().bottom <= innerHeight), `Step ${index + 1} clips the explanation`);
  const name = `payment-step-${String(index + 1).padStart(2, '0')}`;
  await page.screenshot({ path: join(assets, `${name}.png`) });
  const duration = await page.evaluate(() => chapterDuration());
  const count = duration / 1000 * fps;
  for (let frame = 0; frame < count; frame++) {
   await page.evaluate(ms => renderAt(ms), index * duration + frame * 1000 / fps);
   await page.screenshot({ path: join(frames, `${String(frame).padStart(4, "0")}.png`) });
  }
  await encode(name, 0, count);
  console.log(`Rendered step ${index + 1}/12`);
 }
 await page.evaluate(() => {
  setMode('overview');document.body.classList.add("capture", "still");
  byId('number').textContent='L402';byId('title').textContent='A controlled purchase in four steps.';
  byId('subtitle').textContent='Request → approval → payment → response';
 });
 await page.screenshot({ path: join(assets, "payment-flow.png"), fullPage: true });
 await page.evaluate(() => {document.body.classList.remove("still");current=-1;renderAt(0)});
 assert(await page.evaluate(() => byId('guard').getBoundingClientRect().bottom <= innerHeight), 'Capture clips the explanation');
 const totalMs = await page.evaluate(() => chapters().length * chapterDuration());
 assert.equal(totalMs, 20_000);
 for (let index = 0; index < totalMs / 1000 * fps; index++) {
  await page.evaluate(ms => renderAt(ms), index * 1000 / fps);
  await page.screenshot({ path: join(frames, `${String(index).padStart(4, "0")}.png`) });
 }
 assert.deepEqual(errors, []);
 for (const [name, start, count] of [
  ['payment-flow', 0, 300], ['payment-request', 0, 75], ['payment-approval', 75, 75],
  ['payment-settlement', 150, 75], ['payment-response', 225, 75],
 ] as const) {
  await encode(name, start, count);
 }
 console.log("Rendered 12 eight-second step animations and stills, four 5-second clips and the 20-second overview. Both modes passed chapter-link, playback, restart, keyboard, reduced-motion, allowance, message-overlap, text-fit, mobile-overflow, and browser-error checks.");
} finally {
 await browser.close();
 rmSync(frames, { recursive: true, force: true });
}
