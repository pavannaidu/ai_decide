import { expect, test as base, type Page, type Request, type Response } from '@playwright/test';
import { ALERT_ROUTES } from '../shared/alerts';
import type { AlertDecisionRequest, AlertGameRun, AlertGameStep, AlertRoute } from '../shared/alerts';

interface TriageInput {
  alertId: string;
  requestId: string;
  route?: AlertRoute;
}

const test = base.extend<{ alertPage: Page }>({
  alertPage: async ({ page, request }, use) => {
    const createdShifts = new Set<string>();
    page.on('request', (outgoing) => {
      if (outgoing.method() !== 'POST' || new URL(outgoing.url()).pathname !== '/api/alert-games') return;
      const input = outgoing.postDataJSON() as { requestId?: string };
      if (input.requestId) createdShifts.add(input.requestId);
    });
    try {
      await use(page);
    } finally {
      if (!page.isClosed()) await page.close();
      for (const id of createdShifts) {
        const paused = await request.post(`/api/alert-games/${id}/clock`, {
          data: { running: false },
          timeout: 10_000,
        });
        if (paused.status() === 404) continue;
        expect(paused.ok(), `Cleanup must pause only the test-created shift ${id}`).toBe(true);
        expect(((await paused.json()) as AlertGameRun).snapshot.running).toBe(false);
      }
    }
  },
});

test.use({ storageState: { cookies: [], origins: [] } });

function matchesResponse(response: Response, pathname: string, method = 'GET') {
  return new URL(response.url()).pathname === pathname && response.request().method() === method;
}

function trackTriages(page: Page) {
  const requests: TriageInput[] = [];
  page.on('request', (outgoing) => {
    if (outgoing.method() === 'POST' && /^\/api\/alert-games\/[^/]+\/triage$/.test(new URL(outgoing.url()).pathname)) {
      requests.push(outgoing.postDataJSON() as TriageInput);
    }
  });
  return requests;
}

async function openFreshShift(page: Page) {
  const created = page.waitForResponse((response) => matchesResponse(response, '/api/alert-games', 'POST'));
  await page.goto('/');
  const response = await created;
  expect(response.ok(), 'The root game must create a real Lakebase-backed shift').toBe(true);
  const run = (await response.json()) as AlertGameRun;
  await expect(page.getByRole('heading', { name: 'Device Alert Dispatch', exact: true })).toBeVisible();
  await expect(page.getByLabel('Choose demo', { exact: true })).toHaveValue('alerts');
  await expect(page.locator('.ag-fleet-badge')).toHaveText('12 devices');
  await expect(page.getByRole('button', { name: 'Start shift', exact: true })).toBeEnabled();
  expect(await page.evaluate<string | null>('localStorage.getItem("deviceops-alert-game-v1")')).toBe(run.id);
  return run;
}

async function changeClock(page: Page, id: string, running: boolean) {
  const changed = page.waitForResponse((response) => matchesResponse(response, `/api/alert-games/${id}/clock`, 'POST'));
  await page.getByRole('button', { name: running ? 'Start shift' : 'Pause', exact: true }).click();
  const response = await changed;
  expect(response.ok()).toBe(true);
  const run = (await response.json()) as AlertGameRun;
  expect(run.snapshot.running).toBe(running);
  await expect(page.locator('.ag-clock-top')).toContainText(running ? 'Shift live' : 'Shift paused');
  return run;
}

async function readRun(page: Page, id: string) {
  const response = await page.request.get(`/api/alert-games/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as AlertGameRun;
}

async function expectOutcome(page: Page, step: AlertGameStep) {
  const outcome = page.locator('.ag-outcome');
  await expect(outcome).toHaveClass(new RegExp(`\\bag-outcome--${step.outcome.kind}\\b`));
  await expect(outcome.locator('.ag-action-label code')).toHaveText(step.selectedAction);
  const result = step.outcome.kind === 'late' ? 'too late' : step.outcome.kind;
  await expect(outcome.locator('.ag-outcome-meta')).toContainText(
    result === 'too late' ? 'Too late' : `Rubric ${result}`
  );
  await expect(outcome.locator('.ag-outcome-meta')).toContainText(`${step.outcome.points} pts`);
  const details = outcome.getByRole('button', { name: /^Outcome details:/ });
  await expect(details).toHaveAttribute(
    'aria-label',
    `Outcome details: ${step.outcome.message} ${step.outcome.explanation}`
  );
  await details.hover();
  await expect(page.getByRole('tooltip')).toContainText(step.outcome.message);
  await expect(page.getByRole('tooltip')).toContainText(step.outcome.explanation);
  await details.press('Escape');
  if (step.outcome.kind === 'late') {
    await expect(outcome.locator('.ag-action-label')).toContainText('Late response · no handoff');
  } else {
    const lane = page.getByRole('region', { name: `${step.actionLabel} handoff lane`, exact: true });
    await expect(lane).toContainText(step.request.state.alert.deviceId);
    await expect(lane).toContainText(step.outcome.kind === 'match' ? 'Rubric match' : 'Rubric mismatch');
  }
}

test('opens a compact paused root game with twelve fictional MR/CT scanners', async ({ alertPage: page }) => {
  const triages = trackTriages(page);
  const run = await openFreshShift(page);
  expect(run.snapshot.running).toBe(false);
  expect(run.snapshot.elapsedMs).toBe(0);
  expect(run.snapshot.devices).toHaveLength(12);
  expect(new Set(run.snapshot.devices.map((device) => device.modality))).toEqual(new Set(['MR', 'CT']));
  await expect(page.getByRole('heading', { name: 'Incoming alerts', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Choose a queue', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI_DECIDE', exact: true })).toBeVisible();
  await expect(page.locator('.ag-fleet-badge')).toHaveText('12 devices');
  await expect(page.getByLabel(`Observed evidence for ${run.nextDecision!.alertId}`, { exact: true })).toContainText(
    run.nextDecision!.request.state.device.site
  );
  await expect(page.locator('.ag-clock-top')).toContainText('Shift paused');
  await expect(page.getByRole('progressbar', { name: 'Game time remaining', exact: true })).toHaveAttribute(
    'value',
    '60000'
  );
  await expect(page.getByRole('button', { name: 'Ask AI_DECIDE', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'AI autopilot', exact: true })).toBeDisabled();
  for (const route of ALERT_ROUTES) {
    await expect(
      page.getByRole('button', { name: new RegExp(`^Route oldest alert to ${route.label},`) })
    ).toBeDisabled();
  }
  const request = page.getByLabel('Exact AI_DECIDE request', { exact: true });
  expect(JSON.parse((await request.textContent())!) as AlertDecisionRequest).toEqual(run.nextDecision?.request);
  await expect(page.getByLabel('Exact AI_DECIDE response', { exact: true })).toHaveCount(0);
  await expect(page.getByText('A technical alert comes in. AI_DECIDE chooses the next service queue.')).toHaveCount(0);
  await expect(page.getByText('Scores assess a synthetic routing rubric—not clinical correctness.')).toHaveCount(0);
  for (const route of ALERT_ROUTES) {
    await expect(page.getByText(route.description, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `${route.label}: ${route.description}`, exact: true })).toBeVisible();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await page.evaluate('document.documentElement.scrollHeight <= window.innerHeight')).toBe(true);
  const demoPicker = page.getByLabel('Choose demo', { exact: true });
  await demoPicker.selectOption('lab');
  await expect(page).toHaveURL(/\?demo=lab$/);
  await expect(page.getByRole('heading', { name: 'What should the lab do next?', exact: true })).toBeVisible();
  await demoPicker.selectOption('alerts');
  await expect(page).not.toHaveURL(/demo=lab/);
  await expect(page.getByRole('heading', { name: 'Device Alert Dispatch', exact: true })).toBeVisible();
  expect(triages).toHaveLength(0);
});

test('starts and pauses an independent feed without routing, and inspection keeps the oldest input', async ({
  alertPage: page,
}) => {
  const triages = trackTriages(page);
  const run = await openFreshShift(page);
  const input = page.getByLabel('Exact AI_DECIDE request', { exact: true });
  const originalInput = await input.textContent();
  await changeClock(page, run.id, true);
  await expect(page.getByRole('button', { name: 'Ask AI_DECIDE', exact: true })).toBeEnabled();
  await input.focus();
  await input.press('3');
  await expect
    .poll(() => page.locator('.ag-alert-row').count(), { timeout: 10_000 })
    .toBeGreaterThan(run.snapshot.pending);
  const paused = await changeClock(page, run.id, false);
  expect(paused.snapshot.elapsedMs).toBeGreaterThanOrEqual(run.snapshot.nextArrivalMs!);
  expect(paused.snapshot.alerts.length).toBeGreaterThan(run.snapshot.alerts.length);
  expect(paused.latestStep).toBeNull();
  const laterAlert = paused.snapshot.alerts.find((alert) => alert.id !== run.nextDecision?.alertId)!;
  const laterButton = page
    .getByRole('list', { name: 'Queued technical alerts', exact: true })
    .getByRole('button')
    .filter({ hasText: laterAlert.id });
  await laterButton.focus();
  await laterButton.press('Enter');
  await expect(laterButton).toBeFocused();
  await expect(laterButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel(`Observed evidence for ${laterAlert.id}`, { exact: true })).toContainText(
    laterAlert.technicianNote
  );
  await expect(input).toHaveText(originalInput!);
  const first = await readRun(page, run.id);
  const second = await readRun(page, run.id);
  expect(second.snapshot).toEqual(first.snapshot);
  expect(second.snapshot.running).toBe(false);
  expect(second.timings.aiDecisions).toBe(0);
  expect(triages).toHaveLength(0);
});

test('records one real AI choice with exact evidence and measured latency, then replays without triaging', async ({
  alertPage: page,
}) => {
  test.setTimeout(90_000);
  const triages = trackTriages(page);
  const run = await openFreshShift(page);
  await changeClock(page, run.id, true);
  const request = page.getByLabel('Exact AI_DECIDE request', { exact: true });
  const preview = JSON.parse((await request.textContent())!) as AlertDecisionRequest;
  expect(Object.keys(preview.questions)).toEqual(['next_action']);
  expect(preview.questions.next_action.type).toBe('choice');
  expect(Object.keys(preview.questions.next_action.criteria).sort()).toEqual(
    ALERT_ROUTES.map((route) => route.id).sort()
  );
  const completed = page.waitForResponse(
    (response) => matchesResponse(response, `/api/alert-games/${run.id}/triage`, 'POST'),
    { timeout: 75_000 }
  );
  await page.getByRole('button', { name: 'Ask AI_DECIDE', exact: true }).click();
  const response = await completed;
  expect(response.ok(), 'AI triage must use the authenticated live backend, not a mock fallback').toBe(true);
  const updated = (await response.json()) as AlertGameRun;
  const step = updated.latestStep!;
  expect(step.source).toBe('ai');
  expect(step.request).toEqual(preview);
  expect(step.rawResponse).not.toBeNull();
  expect(step.answers?.next_action.choice).toBe(step.selectedAction);
  expect(ALERT_ROUTES.map((route) => route.id)).toContain(step.selectedAction);
  expect(['match', 'mismatch', 'late']).toContain(step.outcome.kind);
  expect(step.apiMs).toBeGreaterThan(0);
  expect(step.totalMs).toBeGreaterThanOrEqual(step.apiMs!);
  expect(updated.timings.aiDecisions).toBe(1);
  const rawResponse = page.getByLabel('Exact AI_DECIDE response', { exact: true });
  await expect(rawResponse).toBeVisible();
  expect(JSON.parse((await request.textContent())!) as AlertDecisionRequest).toEqual(step.request);
  expect(JSON.parse((await rawResponse.textContent())!) as unknown).toEqual(step.rawResponse);
  await expect(page.locator('.ag-transport-time')).toHaveText(`${Math.round(step.apiMs!)} ms transport`);
  await expect(page.locator('.ag-metric--latency > strong')).toHaveText(`${Math.round(step.apiMs!)} ms`);
  await expectOutcome(page, step);
  expect(triages).toHaveLength(1);
  expect(triages[0].alertId).toBe(preview.state.alert.id);
  expect(triages[0]).not.toHaveProperty('route');

  if (process.env.ALERT_GAME_SCREENSHOT_PATH) {
    await changeClock(page, run.id, false);
    await page.screenshot({
      path: process.env.ALERT_GAME_SCREENSHOT_PATH,
      type: 'jpeg',
      quality: 90,
      fullPage: true,
    });
  }

  await page.locator('.ag-history > summary').click();
  const replayed = page.waitForResponse((entry) =>
    matchesResponse(entry, `/api/alert-games/${run.id}/steps/${step.turn}`)
  );
  await page.locator('.ag-history-list').getByRole('button').first().click();
  const replayResponse = await replayed;
  expect(replayResponse.ok()).toBe(true);
  expect((await replayResponse.json()) as AlertGameStep).toEqual(step);
  await expect(page.locator('.ag-replay-banner')).toContainText('after-handoff board · no new AI call');
  expect(JSON.parse((await request.textContent())!) as AlertDecisionRequest).toEqual(step.request);
  expect(JSON.parse((await rawResponse.textContent())!) as unknown).toEqual(step.rawResponse);
  await expect(page.getByRole('button', { name: 'Ask AI_DECIDE', exact: true })).toBeDisabled();
  const saved = await readRun(page, run.id);
  expect(saved.snapshot.running).toBe(false);
  expect(saved.timings.aiDecisions).toBe(1);
  await page.getByRole('button', { name: 'Return to live · paused', exact: true }).click();
  await expect(page.locator('.ag-clock-top')).toContainText('Shift paused');
  await page.reload();
  await expect(rawResponse).toBeVisible();
  expect(JSON.parse((await request.textContent())!) as AlertDecisionRequest).toEqual(step.request);
  expect(JSON.parse((await rawResponse.textContent())!) as unknown).toEqual(step.rawResponse);
  expect(await page.evaluate<string | null>('localStorage.getItem("deviceops-alert-game-v1")')).toBe(run.id);
  await expect(page.locator('.ag-clock-top')).toContainText('Shift paused');
  expect(triages).toHaveLength(1);
});

test('records a deliberately wrong human keyboard route without inventing AI inference or latency', async ({
  alertPage: page,
}) => {
  const triages = trackTriages(page);
  const run = await openFreshShift(page);
  const preview = run.nextDecision!.request;
  expect(preview.state.alert.diagnostics).toBe('available');
  expect(preview.state.alert.remoteReview).toBe('not_started');
  await changeClock(page, run.id, true);
  const completed = page.waitForResponse((response) =>
    matchesResponse(response, `/api/alert-games/${run.id}/triage`, 'POST')
  );
  const manual = page.getByRole('button', {
    name: 'Route oldest alert to Get more information, keyboard shortcut 3',
    exact: true,
  });
  await expect(manual).toBeEnabled();
  await manual.focus();
  await manual.press('3');
  const response = await completed;
  expect(response.ok()).toBe(true);
  const updated = (await response.json()) as AlertGameRun;
  const step = updated.latestStep!;
  expect(step.source).toBe('human');
  expect(step.selectedAction).toBe('request_details');
  expect(step.request).toEqual(preview);
  expect(step.rawResponse).toBeNull();
  expect(step.answers).toBeNull();
  expect(step.apiMs).toBeNull();
  expect(step.outcome.kind).toBe('mismatch');
  expect(step.outcome.points).toBeLessThan(0);
  expect(updated.timings).toEqual({ aiDecisions: 0, apiP50: null, apiP95: null });
  await expect(page.getByText('Human route—no AI call.', { exact: true })).toBeVisible();
  await expect(page.getByText('No AI response or AI latency is invented.', { exact: true })).toBeVisible();
  const context = page.getByLabel('Recorded human routing context', { exact: true });
  expect(JSON.parse((await context.textContent())!) as AlertDecisionRequest).toEqual(preview);
  await expect(page.getByLabel('Exact AI_DECIDE response', { exact: true })).toHaveCount(0);
  await expect(page.locator('.ag-transport-time')).toHaveCount(0);
  await expect(page.locator('.ag-metric--latency > strong')).toHaveText('— ms');
  await expectOutcome(page, step);
  await changeClock(page, run.id, false);
  const savedResponse = await page.request.get(`/api/alert-games/${run.id}/steps/${step.turn}`);
  expect(savedResponse.ok()).toBe(true);
  expect((await savedResponse.json()) as AlertGameStep).toEqual(step);
  expect(triages).toHaveLength(1);
  expect(triages[0].route).toBe('request_details');
});

test('keeps the game and its real request usable across supported responsive widths', async ({ alertPage: page }) => {
  await openFreshShift(page);
  for (const width of [390, 420, 421, 619, 621, 639, 641, 939, 941, 995, 1005, 1800]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth'),
      `The document must not overflow at ${width}px`
    ).toBe(true);
    await expect(page.locator('.ag-fleet-badge')).toHaveText('12 devices');
    await expect(page.getByRole('button', { name: 'Start shift', exact: true })).toBeVisible();
    await expect(page.getByLabel('Exact AI_DECIDE request', { exact: true })).toBeVisible();
    const exchange = await page.locator('.ag-ai-column').boundingBox();
    const operations = await page.locator('.ag-operations-column').boundingBox();
    expect(exchange).not.toBeNull();
    expect(operations).not.toBeNull();
    if (width > 820) {
      expect(operations!.x).toBeGreaterThanOrEqual(exchange!.x + exchange!.width - 1);
      expect(Math.abs(operations!.y - exchange!.y)).toBeLessThan(2);
    } else {
      expect(operations!.y).toBeGreaterThanOrEqual(exchange!.y + exchange!.height - 1);
    }
  }
});

test('autopilot serially routes an alert storm and stops without overlapping inference', async ({
  alertPage: page,
}) => {
  test.setTimeout(60_000);
  await openFreshShift(page);
  const stormCreated = page.waitForResponse((response) => matchesResponse(response, '/api/alert-games', 'POST'));
  await page.getByRole('button', { name: 'Storm', exact: true }).click();
  const storm = (await (await stormCreated).json()) as AlertGameRun;
  await expect(page.getByRole('button', { name: 'Start shift', exact: true })).toBeEnabled();
  const triages = trackTriages(page);
  const inFlight = new Set<string>();
  let maximumConcurrent = 0;
  const triagePath = `/api/alert-games/${storm.id}/triage`;
  page.on('request', (outgoing) => {
    if (new URL(outgoing.url()).pathname !== triagePath) return;
    const input = outgoing.postDataJSON() as TriageInput;
    inFlight.add(input.requestId);
    maximumConcurrent = Math.max(maximumConcurrent, inFlight.size);
  });
  const finished = (outgoing: Request) => {
    if (new URL(outgoing.url()).pathname !== triagePath) return;
    const input = outgoing.postDataJSON() as TriageInput;
    inFlight.delete(input.requestId);
  };
  page.on('requestfinished', finished);
  page.on('requestfailed', finished);
  await changeClock(page, storm.id, true);
  await page.getByRole('button', { name: 'AI autopilot', exact: true }).click();
  await expect
    .poll(async () => (await readRun(page, storm.id)).timings.aiDecisions, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(3);
  await page.getByRole('button', { name: 'Stop autopilot', exact: true }).click();
  await changeClock(page, storm.id, false);
  await expect(page.locator('.ag-operation-id')).toHaveCount(0);
  expect(maximumConcurrent).toBe(1);
  expect(triages.every((input) => input.route === undefined)).toBe(true);
  const count = triages.length;
  const saved = await readRun(page, storm.id);
  expect(saved.snapshot.running).toBe(false);
  expect(saved.timings.aiDecisions).toBeGreaterThanOrEqual(3);
  const again = await readRun(page, storm.id);
  expect(again.snapshot).toEqual(saved.snapshot);
  expect(triages).toHaveLength(count);
});

test('supports focused keyboard evidence, route help, and reduced motion without handoffs', async ({
  alertPage: page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const triages = trackTriages(page);
  const run = await openFreshShift(page);
  const routeHelp = page.getByRole('button', { name: /^Remote engineer:/ });
  await routeHelp.focus();
  await expect(page.getByRole('tooltip')).toContainText(ALERT_ROUTES[0].description);
  await expect(routeHelp).toBeFocused();
  await routeHelp.press('Escape');
  const request = page.getByLabel('Exact AI_DECIDE request', { exact: true });
  await expect(request).toHaveAttribute('tabindex', '0');
  const originalRequest = await request.textContent();
  await request.focus();
  await request.press('End');
  await expect(request).toBeFocused();
  await expect
    .poll(() =>
      request.evaluate((element) =>
        'scrollTop' in element && typeof element.scrollTop === 'number' ? element.scrollTop : 0
      )
    )
    .toBeGreaterThan(0);
  const alert = run.nextDecision!.request.state.alert;
  const queueAlert = page
    .getByRole('list', { name: 'Queued technical alerts', exact: true })
    .getByRole('button')
    .first();
  await queueAlert.focus();
  await queueAlert.press('Enter');
  await expect(queueAlert).toBeFocused();
  await expect(queueAlert).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel(`Observed evidence for ${alert.id}`, { exact: true })).toContainText(alert.signal);
  await expect(request).toHaveText(originalRequest!);
  for (const property of ['animationDuration', 'transitionDuration']) {
    const durations = await page.evaluate<string>(
      `getComputedStyle(document.querySelector(".ag-alert-row[aria-pressed=true]")).${property}`
    );
    expect(Math.max(...durations.split(',').map((duration) => parseFloat(duration)))).toBeLessThanOrEqual(0.001);
  }
  expect(triages).toHaveLength(0);
  expect((await readRun(page, run.id)).latestStep).toBeNull();
});

test('keeps the feed and pause independent of a test-only failed triage and shows no fake response', async ({
  alertPage: page,
}) => {
  const run = await openFreshShift(page);
  const triagePattern = `**/api/alert-games/${run.id}/triage`;
  let releaseFailure: () => void = () => undefined;
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  await page.route(triagePattern, async (route) => {
    await failureGate;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'TEST-ONLY: triage transport unavailable' }),
    });
  });
  try {
    await changeClock(page, run.id, true);
    await page.getByRole('button', { name: 'Ask AI_DECIDE', exact: true }).click();
    await expect(page.getByText('AI_DECIDE is choosing a handoff…', { exact: true })).toBeVisible();
    await expect
      .poll(() => page.locator('.ag-alert-row').count(), { timeout: 10_000 })
      .toBeGreaterThan(run.snapshot.pending);
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
    await changeClock(page, run.id, false);
    releaseFailure();
    await expect(page.locator('.ag-error')).toContainText('TEST-ONLY: triage transport unavailable');
    await expect(page.locator('.ag-error')).toContainText('No mock response is substituted.');
    await expect(page.getByRole('button', { name: 'Retry handoff', exact: true })).toBeEnabled();
    await expect(page.getByLabel('Exact AI_DECIDE response', { exact: true })).toHaveCount(0);
    await expect(page.locator('.ag-metric--latency > strong')).toHaveText('— ms');
    await expect(page.locator('.ag-outcome')).toHaveCount(0);
    const saved = await readRun(page, run.id);
    expect(saved.snapshot.running).toBe(false);
    expect(saved.latestStep).toBeNull();
    expect(saved.timings.aiDecisions).toBe(0);
    expect(saved.snapshot.stats.routed).toBe(0);
  } finally {
    releaseFailure();
    await page.unroute(triagePattern);
  }
});
