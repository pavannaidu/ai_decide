import { createHash } from 'node:crypto';
import type { LakebasePool } from '@databricks/appkit';
import { SOP } from './policy';
import { ALERT_POLICY } from './alert-policy';

export async function initializeDatabase(pool: LakebasePool) {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS deviceops_sim;
    CREATE TABLE IF NOT EXISTS deviceops_sim.sop_versions (
      version TEXT PRIMARY KEY,
      content JSONB NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS deviceops_sim.simulation_runs (
      id UUID PRIMARY KEY,
      owner_key TEXT NOT NULL,
      seed INTEGER NOT NULL,
      tick INTEGER NOT NULL DEFAULT 0 CHECK (tick BETWEEN 0 AND 60),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      sop_version TEXT NOT NULL REFERENCES deviceops_sim.sop_versions(version),
      state JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS simulation_runs_owner_updated
      ON deviceops_sim.simulation_runs(owner_key, updated_at DESC);
    CREATE TABLE IF NOT EXISTS deviceops_sim.simulation_steps (
      run_id UUID NOT NULL REFERENCES deviceops_sim.simulation_runs(id),
      turn INTEGER NOT NULL CHECK (turn BETWEEN 1 AND 60),
      request_id UUID NOT NULL,
      request JSONB NOT NULL,
      raw_response JSONB NOT NULL,
      selected_action TEXT NOT NULL,
      before_snapshot JSONB NOT NULL,
      after_snapshot JSONB NOT NULL,
      outcome TEXT NOT NULL,
      api_ms INTEGER NOT NULL CHECK (api_ms >= 0),
      tick_ms INTEGER NOT NULL CHECK (tick_ms >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (run_id, turn),
      UNIQUE (run_id, request_id)
    );
    CREATE TABLE IF NOT EXISTS deviceops_sim.alert_game_runs (
      id UUID PRIMARY KEY,
      owner_key TEXT NOT NULL,
      seed INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('steady', 'storm')),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      policy_version TEXT NOT NULL REFERENCES deviceops_sim.sop_versions(version),
      state JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS alert_game_runs_owner_updated
      ON deviceops_sim.alert_game_runs(owner_key, updated_at DESC);
    CREATE TABLE IF NOT EXISTS deviceops_sim.alert_game_steps (
      run_id UUID NOT NULL REFERENCES deviceops_sim.alert_game_runs(id),
      turn INTEGER NOT NULL CHECK (turn BETWEEN 1 AND 60),
      request_id UUID NOT NULL,
      detail JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (run_id, turn),
      UNIQUE (run_id, request_id)
    );
  `);
  for (const policy of [SOP, ALERT_POLICY]) {
    const content = JSON.stringify(policy);
    const checksum = createHash('sha256').update(content).digest('hex');
    await pool.query(
      `INSERT INTO deviceops_sim.sop_versions(version, content, content_hash)
     VALUES ($1, $2::jsonb, $3) ON CONFLICT (version) DO NOTHING`,
      [policy.version, content, checksum]
    );
    const { rows } = await pool.query<{ content_hash: string }>(
      'SELECT content_hash FROM deviceops_sim.sop_versions WHERE version = $1',
      [policy.version]
    );
    if (rows[0]?.content_hash !== checksum) {
      throw new Error('Policy content changed without a new SOP version.');
    }
  }
}
