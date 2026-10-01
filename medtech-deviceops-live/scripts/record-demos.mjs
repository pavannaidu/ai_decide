import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(appRoot, '..', 'docs', 'videos');
const temporaryDir = resolve(appRoot, 'test-results', 'demo-video-capture');
const baseUrl = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:8766';
const authToken = process.env.DEMO_AUTH_TOKEN;
const minimumDurationMs = 12_000;

await rm(temporaryDir, { recursive: true, force: true });
await mkdir(temporaryDir, { recursive: true });
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });

async function assertOnePage(page, label) {
  const dimensions = await page.evaluate(`({
    height: window.innerHeight,
    width: window.innerWidth,
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth
  })`);
  if (dimensions.scrollHeight > dimensions.height || dimensions.scrollWidth > dimensions.width) {
    throw new Error(`${label} does not fit the recording frame: ${JSON.stringify(dimensions)}`);
  }
}

async function record(name, path, play) {
  const context = await browser.newContext({
    colorScheme: 'light',
    extraHTTPHeaders: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
    recordVideo: { dir: temporaryDir, size: { width: 1440, height: 900 } },
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(75_000);
  const video = page.video();
  const recordingStartedAt = Date.now();
  try {
    await page.goto(new URL(path, baseUrl).toString());
    await play(page);
    await assertOnePage(page, name);
    await page.waitForTimeout(Math.max(0, minimumDurationMs - (Date.now() - recordingStartedAt)));
  } finally {
    await context.close();
  }
  if (!video) throw new Error(`Video recording did not start for ${name}.`);
  await video.saveAs(resolve(outputDir, `${name}.webm`));
}

await record('device-alert-dispatch', '/', async (page) => {
  await page
    .locator('.ag-loading-board')
    .waitFor({ state: 'hidden', timeout: 20_000 })
    .catch(() => undefined);
  const created = page.waitForResponse(
    (response) => response.url().endsWith('/api/alert-games') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'New shift', exact: true }).click();
  await created;
  await assertOnePage(page, 'device-alert-dispatch');
  await page.waitForTimeout(900);

  await page.getByRole('button', { name: /^Remote engineer:/ }).hover();
  await page.getByRole('tooltip').waitFor({ state: 'visible' });
  await page.waitForTimeout(1_000);

  const started = page.waitForResponse(
    (response) => response.url().includes('/clock') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Start shift', exact: true }).click();
  await started;

  const decided = page.waitForResponse(
    (response) => response.url().includes('/triage') && response.request().method() === 'POST',
    { timeout: 75_000 }
  );
  await page.getByRole('button', { name: 'Ask AI_DECIDE', exact: true }).click();
  const decision = await decided;
  if (!decision.ok()) throw new Error(`Device AI_DECIDE call failed with ${decision.status()}.`);

  const paused = page.waitForResponse(
    (response) => response.url().includes('/clock') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await paused;
  await assertOnePage(page, 'device-alert-dispatch result');
  await page.waitForTimeout(900);

  await page.getByRole('button', { name: /^Outcome details:/ }).hover();
  await page.getByRole('tooltip').waitFor({ state: 'visible' });
});

await record('lab-operations', '/?demo=lab', async (page) => {
  await page.locator('.story-board').waitFor({ state: 'visible', timeout: 20_000 });
  const restarted = page.waitForResponse(
    (response) => response.url().endsWith('/api/runs') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await restarted;
  await assertOnePage(page, 'lab-operations');
  await page.waitForTimeout(1_000);

  const decided = page.waitForResponse(
    (response) => response.url().endsWith('/tick') && response.request().method() === 'POST',
    { timeout: 75_000 }
  );
  await page.getByRole('button', { name: 'Ask AI_DECIDE', exact: true }).click();
  const decision = await decided;
  if (!decision.ok()) throw new Error(`Lab AI_DECIDE call failed with ${decision.status()}.`);
  await assertOnePage(page, 'lab-operations result');
});

await browser.close();
await rm(temporaryDir, { recursive: true, force: true });
console.log(`Recorded both demos in ${outputDir}`);
