import { expect, test } from '@playwright/test';
import type { DecisionAnswers, DecisionRequest, RunView } from '../shared/types';

test('puts the story and AI_DECIDE exchange on the main screen', async ({ page }) => {
  await page.goto('/?demo=lab');
  await expect(page.locator('html')).toHaveClass('light');
  await expect(page.getByLabel('Choose demo', { exact: true })).toHaveValue('lab');
  await expect(page.getByRole('heading', { name: 'What should the lab do next?', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Request', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Response', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask AI_DECIDE', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Shared reagent issue', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(
    page.getByRole('heading', { name: 'Two machines fail the same quality check.', exact: true })
  ).toBeVisible();
  await expect(page.locator('.run-state')).toHaveText('Turn 0 · paused');
  await expect(page.locator('.machine-button')).toHaveCount(12);
  await expect(page.locator('.reagent-canister')).toHaveCount(3);
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await page.evaluate('document.documentElement.scrollHeight <= window.innerHeight')).toBe(true);
});

test('shows the exact sent request and real response for one choice question', async ({ page }) => {
  await page.goto('/?demo=lab');
  await expect(
    page.getByRole('heading', { name: 'Two machines fail the same quality check.', exact: true })
  ).toBeVisible();
  const request = page.getByLabel('Exact AI_DECIDE request JSON', { exact: true });
  const preview = JSON.parse((await request.textContent())!) as DecisionRequest;
  expect(Object.keys(preview.questions)).toEqual(['next_action']);
  const completed = page.waitForResponse(
    (response) => response.url().endsWith('/tick') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Ask AI_DECIDE', exact: true }).click();
  const updated = (await (await completed).json()) as RunView;
  const response = page.getByLabel('Exact AI_DECIDE response JSON', { exact: true });
  await expect(response).toBeVisible();
  expect(JSON.parse((await request.textContent())!)).toEqual(preview);
  const raw = JSON.parse((await response.textContent())!) as { response: { answers: DecisionAnswers } };
  expect(
    Object.prototype.hasOwnProperty.call(
      preview.questions.next_action.criteria,
      raw.response.answers.next_action.choice
    )
  ).toBe(true);
  expect(JSON.parse((await response.textContent())!)).toEqual(updated.latestStep?.rawResponse);
  await expect(page.locator('.machine-button[data-affected="true"]')).toHaveCount(
    updated.latestStep!.outcome.affectedIds.length
  );
  await expect(page.locator('.lab-count')).toHaveText(
    `${updated.snapshot.healthyCount}/${updated.snapshot.devices.length} ready`
  );
  await expect(page.locator('.simulation-result')).toBeVisible();
  const originalResponse = await response.textContent();
  let newDecisions = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/tick')) newDecisions += 1;
  });
  await page.reload();
  await expect(response).toHaveText(originalResponse!);
  expect(JSON.parse((await request.textContent())!)).toEqual(preview);
  expect(newDecisions).toBe(0);
  if (process.env.DEMO_SCREENSHOT_PATH) {
    await page.screenshot({
      path: process.env.DEMO_SCREENSHOT_PATH,
      type: 'jpeg',
      quality: 90,
      fullPage: true,
    });
  }
});

test('keeps the lab and API exchange side by side on desktop and usable on narrow screens', async ({ page }) => {
  await page.goto('/?demo=lab');
  await expect(page.locator('.machine-button')).toHaveCount(12);
  for (const width of [390, 619, 621, 995, 1005, 1800]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
    const lab = await page.locator('.lab-column').boundingBox();
    const exchange = await page.locator('.decision-column').boundingBox();
    if (width > 1000) {
      expect(exchange!.x).toBeGreaterThanOrEqual(lab!.x + lab!.width);
      expect(Math.abs(exchange!.y - lab!.y)).toBeLessThan(2);
    } else {
      expect(exchange!.y).toBeGreaterThanOrEqual(lab!.y + lab!.height);
    }
  }
});

test('inspecting a machine changes only the details, not the AI request', async ({ page }) => {
  await page.goto('/?demo=lab');
  const request = page.getByLabel('Exact AI_DECIDE request JSON', { exact: true });
  await expect(request).toBeVisible();
  const originalRequest = await request.textContent();
  await page.getByRole('button', { name: /^Inspect AN-02:/ }).click();
  const details = page.getByLabel('Selected machine details', { exact: true });
  await expect(details).toContainText('AN-02');
  await expect(details).toContainText('RG-215');
  await expect(details).toContainText('passed');
  await expect(request).toHaveText(originalRequest!);
  await expect(page.locator('.run-state')).toHaveText('Turn 0 · paused');
});
