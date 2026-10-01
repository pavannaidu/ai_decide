import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

const profile = process.env.DATABRICKS_CONFIG_PROFILE ?? 'FEVM';
const app = JSON.parse(
  execFileSync('databricks', ['apps', 'get', 'medtech-deviceops-live', '--profile', profile, '-o', 'json'], {
    encoding: 'utf8',
  })
);
const credential = JSON.parse(
  execFileSync('databricks', ['auth', 'token', '--profile', profile], { encoding: 'utf8' })
);
const root = new URL(app.url);
if (root.protocol !== 'https:' || !root.hostname.endsWith('.databricksapps.com')) {
  throw new Error('The FEVM app did not return a trusted Databricks Apps URL.');
}
if (!credential.access_token) throw new Error('The FEVM CLI profile needs a valid OAuth session.');
const headers = { Authorization: `Bearer ${credential.access_token}`, 'Content-Type': 'application/json' };
const created = [];

async function request(path, body, expectedStatus = 200) {
  const response = await fetch(new URL(path, root), {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  const result = await response.json();
  assert.equal(response.status, expectedStatus, `${path}: ${JSON.stringify(result)}`);
  return result;
}

async function create(mode = 'steady') {
  const requestId = randomUUID();
  const body = { seed: 42, mode, requestId };
  const run = await request('/api/alert-games', body);
  created.push(run.id);
  assert.equal(run.id, requestId);
  assert.equal(run.snapshot.running, false);
  assert.equal((await request('/api/alert-games', body)).id, run.id);
  await request('/api/alert-games', { ...body, seed: 43 }, 409);
  return run;
}

try {
  const health = await request('/api/health');
  assert.equal(health.lakebase, 'connected');
  assert.equal(health.schemaOwnedByCaller, true);
  const legacy = await request('/api/runs');
  const bootstrap = await request('/api/alert-games');
  assert.equal(bootstrap.policyVersion, 'SIM-ALERT-TRIAGE-1.0');
  let run = await create();
  await request(`/api/alert-games/${run.id}/triage`, { alertId: 'AL-001', requestId: randomUUID() }, 409);
  run = await request(`/api/alert-games/${run.id}/clock`, { running: true });
  const observations = [];
  for (const [alertId, arrivalMs] of [
    ['AL-001', 0],
    ['AL-002', 4000],
    ['AL-003', 8000],
  ]) {
    await wait(Math.max(0, arrivalMs - run.snapshot.elapsedMs + 100));
    run = await request(`/api/alert-games/${run.id}`);
    const preview = run.nextDecision;
    assert.equal(preview.alertId, alertId);
    assert.deepEqual(Object.keys(preview.request.questions), ['next_action']);
    assert.deepEqual(Object.keys(preview.request.questions.next_action.criteria), [
      'remote_review',
      'field_review',
      'request_details',
    ]);
    for (const privateKey of ['expectedRoute', 'schedule', 'explanation', 'dueAtMs']) {
      assert.equal(JSON.stringify(preview.request).includes(privateKey), false);
    }
    const input = { alertId, requestId: randomUUID() };
    run = await request(`/api/alert-games/${run.id}/triage`, input);
    const step = run.latestStep;
    assert.deepEqual(step.request, preview.request);
    assert.equal(step.source, 'ai');
    assert.equal(step.selectedAction, step.rawResponse.response.answers.next_action.choice);
    assert.ok(step.apiMs >= 0);
    const repeat = await request(`/api/alert-games/${run.id}/triage`, input);
    assert.equal(repeat.timings.aiDecisions, run.timings.aiDecisions);
    const replay = await request(`/api/alert-games/${run.id}/steps/${step.turn}`);
    assert.deepEqual(replay, step);
    await request(`/api/alert-games/${run.id}/triage`, { ...input, route: step.selectedAction }, 409);
    observations.push({ alertId, choice: step.selectedAction, apiMs: step.apiMs, rubric: step.outcome.kind });
  }
  run = await request(`/api/alert-games/${run.id}/clock`, { running: false });
  await wait(250);
  assert.equal((await request(`/api/alert-games/${run.id}`)).snapshot.elapsedMs, run.snapshot.elapsedMs);
  const first = await request(`/api/alert-games/${run.id}/steps/1`);
  assert.equal(first.rawResponse.metadata.version, '1.0');
  assert.equal((await request(`/api/alert-games/${run.id}/steps`)).length, 3);

  let human = await create('storm');
  human = await request(`/api/alert-games/${human.id}/clock`, { running: true });
  const handoff = { alertId: 'AL-001', requestId: randomUUID(), route: 'remote_review' };
  const duplicate = await Promise.all([
    request(`/api/alert-games/${human.id}/triage`, handoff),
    request(`/api/alert-games/${human.id}/triage`, handoff),
  ]);
  assert.equal(duplicate[0].snapshot.stats.routed, 1);
  assert.equal(duplicate[1].snapshot.stats.routed, 1);
  assert.equal((await request(`/api/alert-games/${human.id}/steps`)).length, 1);
  const humanStep = await request(`/api/alert-games/${human.id}/steps/1`);
  assert.equal(humanStep.rawResponse, null);
  assert.equal(humanStep.apiMs, null);
  assert.equal(humanStep.answers, null);
  await request(
    `/api/alert-games/${human.id}/triage`,
    { alertId: 'AL-001', requestId: randomUUID(), route: 'repair_device' },
    400
  );
  human = await request(`/api/alert-games/${human.id}/clock`, { running: false });
  await wait(1000);
  assert.equal((await request(`/api/alert-games/${human.id}`)).snapshot.elapsedMs, human.snapshot.elapsedMs);
  for (const old of legacy.runs) {
    assert.equal((await request(`/api/runs/${old.id}`)).id, old.id);
  }
  console.table(observations);
  console.log(
    'Live alert routing, exact evidence, replay, clock, concurrent retries, Lakebase, and retained lab history passed.'
  );
} finally {
  for (const id of created) {
    await request(`/api/alert-games/${id}/clock`, { running: false }).catch(() => undefined);
  }
}
