import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const profile = process.env.DATABRICKS_CONFIG_PROFILE ?? 'FEVM';
const appName = process.env.DEVICEOPS_APP_NAME ?? 'medtech-deviceops-live';
const app = JSON.parse(
  execFileSync('databricks', ['apps', 'get', appName, '--profile', profile, '-o', 'json'], { encoding: 'utf8' })
);
const credential = JSON.parse(
  execFileSync('databricks', ['auth', 'token', '--profile', profile], { encoding: 'utf8' })
);
if (!credential.access_token) throw new Error('A valid OAuth CLI profile is required.');
const root = new URL(app.url);
if (root.protocol !== 'https:' || !root.hostname.endsWith('.databricksapps.com')) throw new Error('Untrusted app URL.');
const headers = { Authorization: `Bearer ${credential.access_token}`, 'Content-Type': 'application/json' };

async function request(route, body, expectedStatus = 200) {
  const response = await fetch(new URL(route, root), {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  const result = await response.json();
  assert.equal(response.status, expectedStatus, `${route}: ${JSON.stringify(result)}`);
  return result;
}

const health = await request('/api/health');
assert.equal(health.lakebase, 'connected');
assert.equal(health.schemaOwnedByCaller, true);
const bootstrap = await request('/api/runs');
assert.equal(typeof bootstrap.policyVersion, 'string');
const observations = [];
for (const [kind, expectedPrefix] of [
  ['isolated_fault', 'service:'],
  ['lot_qc', 'review:'],
  ['ambiguous_report', 'clarify:'],
]) {
  let run = await request('/api/runs', { seed: 42, requestId: randomUUID(), scenario: kind });
  assert.equal(run.scenario, kind);
  assert.equal(run.sopVersion, bootstrap.policyVersion);
  assert.equal(run.tick, 0);
  assert.equal(run.latestStep, null);
  const preview = run.nextDecision;
  assert.deepEqual(Object.keys(preview.request.questions), ['next_action']);
  const input = { expectedRevision: run.revision, requestId: randomUUID() };
  run = await request(`/api/runs/${run.id}/tick`, input);
  assert.equal(run.tick, 1);
  assert.deepEqual(run.latestStep.request, preview.request);
  assert.deepEqual(run.latestStep.beforeSnapshot, preview.beforeSnapshot);
  assert.ok(Object.hasOwn(run.latestStep.request.questions.next_action.criteria, run.latestStep.selectedAction));
  for (const privateKey of ['"cause":', 'clarificationCause', 'randomState', 'expectedAction']) {
    assert.equal(JSON.stringify(run.latestStep.request).includes(privateKey), false);
  }
  const repeat = await request(`/api/runs/${run.id}/tick`, input);
  assert.equal(repeat.tick, 1);
  const history = await request(`/api/runs/${run.id}/steps`);
  assert.equal(history.length, 1);
  const saved = await request(`/api/runs/${run.id}/steps/1`);
  assert.deepEqual(saved.rawResponse, run.latestStep.rawResponse);
  assert.deepEqual(
    saved.candidates.map((candidate) => [candidate.id, candidate.description]),
    Object.entries(saved.request.questions.next_action.criteria)
  );
  await request(`/api/runs/${run.id}/tick`, { expectedRevision: 0, requestId: randomUUID() }, 409);
  observations.push({
    scenario: kind,
    choice: run.latestStep.selectedAction,
    matchedIllustrativeExpectation: run.latestStep.selectedAction.startsWith(expectedPrefix),
    apiMs: run.latestStep.apiMs,
    confidence: run.latestStep.answers.next_action.confidence,
    outcome: run.latestStep.outcome.message,
  });
  if (kind === 'lot_qc' && run.latestStep.selectedAction.startsWith('review:')) {
    for (let index = 0; index < 2; index += 1)
      run = await request(`/api/runs/${run.id}/tick`, { expectedRevision: run.revision, requestId: randomUUID() });
    assert.ok(run.snapshot.events.some((event) => event.kind === 'simulated_reviewer'));
  }
  if (kind === 'ambiguous_report' && run.latestStep.selectedAction.startsWith('clarify:')) {
    run = await request(`/api/runs/${run.id}/tick`, { expectedRevision: run.revision, requestId: randomUUID() });
    assert.ok(run.snapshot.events.some((event) => event.kind === 'simulated_clarification'));
  }
}
const run = await request('/api/runs', { seed: 7, requestId: randomUUID() });
const concurrent = await Promise.all([
  fetch(new URL(`/api/runs/${run.id}/tick`, root), {
    method: 'POST',
    headers,
    body: JSON.stringify({ expectedRevision: 0, requestId: randomUUID() }),
  }),
  fetch(new URL(`/api/runs/${run.id}/tick`, root), {
    method: 'POST',
    headers,
    body: JSON.stringify({ expectedRevision: 0, requestId: randomUUID() }),
  }),
]);
assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 409]);
assert.equal((await request(`/api/runs/${run.id}/steps`)).length, 1);
await request('/api/runs', { seed: 7, requestId: randomUUID() });
assert.equal((await request(`/api/runs/${run.id}`)).tick, 1);
await request('/api/runs/not-a-uuid', undefined, 400);
await request(`/api/runs/${run.id}/steps/not-a-turn`, undefined, 400);
await request(`/api/runs/${run.id}/steps/61`, undefined, 400);
await request(`/api/runs/${randomUUID()}`, undefined, 404);
await request('/api/runs', { seed: -1, requestId: randomUUID() }, 400);
console.log(
  JSON.stringify(
    {
      verifiedAt: new Date().toISOString(),
      checks: [
        'Lakebase SP ownership',
        'one live choice question',
        'three ready-to-run stories',
        'preview matches the exact sent request',
        'no hidden-cause leakage',
        'tick idempotency',
        'stale revision conflict',
        'atomic concurrent tick',
        'saved replay',
        'reset retains history',
        'input validation',
      ],
      observations,
    },
    null,
    2
  )
);
