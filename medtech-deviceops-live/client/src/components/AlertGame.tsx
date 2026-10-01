import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Skeleton,
} from '@databricks/appkit-ui/react';
import {
  ArrowRight,
  Bot,
  ExternalLink,
  LoaderCircle,
  Pause,
  Play,
  Radio,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import { useEffect } from 'react';
import { ALERT_ROUTES } from '../../../shared/alerts';
import { useAlertGame } from '../useAlertGame';
import { AlertBoard } from './AlertBoard';
import { AlertDispatch } from './AlertDispatch';
import { AlertInspector } from './AlertInspector';

export function AlertGame() {
  const game = useAlertGame();
  const { stopAutopilot, triage } = game;
  const snapshot = game.snapshot;
  const running = !!game.run?.snapshot.running && !game.replay;
  const complete = !!game.run?.snapshot.complete;
  const remainingMs = Math.max(0, (snapshot?.durationMs ?? 60_000) - game.elapsedMs);
  const canRoute =
    running &&
    !complete &&
    !game.deadlineReached &&
    !!game.run?.nextDecision &&
    !game.controlBusy &&
    !game.routing &&
    !game.pending &&
    !game.error &&
    !game.stale;
  const canAutopilot =
    running &&
    !complete &&
    !game.deadlineReached &&
    !game.controlBusy &&
    !game.routing &&
    !game.pending &&
    !game.error &&
    !game.stale;
  const mode = game.run?.mode ?? 'steady';
  const lastAi = game.steps.find((step) => step.source === 'ai' && step.apiMs !== null);
  const status = game.replay
    ? `Replay · handoff ${game.replay.turn}`
    : complete
      ? 'Shift complete'
      : game.deadlineReached
        ? 'Final snapshot syncing'
        : game.stale
          ? 'Feed needs a connection'
          : running
            ? 'Shift live'
            : 'Shift paused';

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!canRoute || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.closest('input, textarea, select, [contenteditable="true"], [data-game-no-shortcuts]') ||
          target.closest('dialog'))
      ) {
        return;
      }
      const route = ALERT_ROUTES[Number(event.key) - 1];
      if (!['1', '2', '3'].includes(event.key) || !route) return;
      event.preventDefault();
      stopAutopilot();
      void triage(route.id);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [canRoute, stopAutopilot, triage]);

  return (
    <div className="alert-game">
      <a className="ag-skip-link" href="#alert-game-main">
        Skip to alert game
      </a>
      <header className="ag-header">
        <div className="ag-wordmark">
          <Radio size={20} aria-hidden="true" />
          <span>Databricks</span>
          <span className="ag-wordmark-divider">/</span>
          <code>AI_DECIDE</code>
        </div>
        <div className="ag-header-right">
          <Badge variant="outline">Synthetic game</Badge>
          <a href="?demo=lab">
            Lab demo <ArrowRight size={13} aria-hidden="true" />
          </a>
        </div>
      </header>

      <main id="alert-game-main" className="ag-main">
        <section className="ag-intro">
          <div>
            <p className="ag-eyebrow">Medtech / imaging-equipment technical support</p>
            <h1>Device Alert Dispatch</h1>
            <p className="ag-lead">Route the alert. Not the diagnosis.</p>
          </div>
          <div
            className={`ag-clock${remainingMs <= 10_000 ? ' ag-clock--ending' : ''}`}
            aria-label="Synthetic shift clock"
          >
            <div className="ag-clock-top">
              <span>60-second shift</span>
              <Badge variant="outline">{status}</Badge>
            </div>
            <div className="ag-clock-value">
              <span aria-label={`${(remainingMs / 1000).toFixed(1)} seconds remaining`}>
                {(remainingMs / 1000).toFixed(1)}
                <small>s</small>
              </span>
              <span className="ag-small-note">
                Game time left
                <br />
                Not a service SLA
              </span>
            </div>
            <progress value={remainingMs} max={snapshot?.durationMs ?? 60_000} aria-label="Game time remaining" />
          </div>
        </section>

        <div className="ag-toolbar">
          <div className="ag-mode-picker" role="group" aria-label="Choose a new shift mode">
            <Button
              variant="ghost"
              aria-pressed={mode === 'steady'}
              disabled={game.controlBusy || game.routing || !!game.replay}
              onClick={() => void game.newShift('steady')}
            >
              <Radio size={14} aria-hidden="true" />
              Steady feed
            </Button>
            <Button
              variant="ghost"
              aria-pressed={mode === 'storm'}
              disabled={game.controlBusy || game.routing || !!game.replay}
              onClick={() => void game.newShift('storm')}
            >
              <Zap size={14} aria-hidden="true" />
              Alert storm
            </Button>
          </div>
          <div className="ag-play-controls">
            <Button
              variant="outline"
              disabled={
                !game.run ||
                game.controlBusy ||
                !!game.replay ||
                complete ||
                (!running && (game.routing || !!game.error || !!game.pending))
              }
              onClick={() => void game.setRunning(!running)}
            >
              {game.controlBusy && game.run ? (
                <LoaderCircle size={15} className="ag-spin" aria-hidden="true" />
              ) : running ? (
                <Pause size={15} aria-hidden="true" />
              ) : (
                <Play size={15} aria-hidden="true" />
              )}
              {running ? 'Pause' : 'Start shift'}
            </Button>
            <Button disabled={!canRoute || game.autopilot} onClick={() => void game.triage()}>
              {game.deciding ? (
                <LoaderCircle size={15} className="ag-spin" aria-hidden="true" />
              ) : (
                <ArrowRight size={15} aria-hidden="true" />
              )}
              {game.deciding ? 'AI deciding…' : 'Ask AI_DECIDE'}
            </Button>
            <Button
              variant="outline"
              aria-pressed={game.autopilot}
              disabled={!game.autopilot && !canAutopilot}
              onClick={game.toggleAutopilot}
              title="One AI call at a time. Stopping autopilot lets the current call finish."
            >
              <Bot size={16} aria-hidden="true" />
              {game.autopilot ? 'Stop autopilot' : 'AI autopilot'}
            </Button>
            <Button
              variant="ghost"
              disabled={game.controlBusy || game.routing || !!game.replay}
              onClick={() => void game.newShift(mode)}
            >
              <RotateCcw size={14} aria-hidden="true" />
              New shift
            </Button>
          </div>
        </div>

        {game.error && (
          <Alert variant="destructive" className="ag-error">
            <TriangleAlert size={17} aria-hidden="true" />
            <AlertTitle>{game.hasRetry ? 'Handoff failed · shift recovery' : 'The game needs attention'}</AlertTitle>
            <AlertDescription>
              <div>
                <p>{game.error}</p>
                {game.hasRetry && (
                  <p>Retry resumes the paused shift with the same operation ID. No mock response is substituted.</p>
                )}
              </div>
              <Button
                variant="outline"
                disabled={game.controlBusy || game.routing || (game.hasRetry && complete)}
                onClick={() => void game.retry()}
              >
                {game.hasRetry ? 'Retry handoff' : 'Reconnect / retry'}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {game.stale && !game.error && (
          <Alert className="ag-stale">
            <TriangleAlert size={16} aria-hidden="true" />
            <AlertTitle>Showing the last observed snapshot</AlertTitle>
            <AlertDescription>
              <p>
                {game.syncError ??
                  'Live updates are delayed. The clock is interpolated; alert arrivals and scores come only from the server.'}
              </p>
              <Button variant="outline" disabled={game.controlBusy || game.routing} onClick={() => void game.retry()}>
                Reconnect
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {game.replay && (
          <div className="ag-replay-banner" role="status">
            <span>Saved handoff {game.replay.turn} · after-handoff board · no new AI call</span>
            <Button variant="outline" onClick={game.exitReplay}>
              Return to live · paused
            </Button>
          </div>
        )}

        <div className="ag-scoreboard" aria-label="Server-scored synthetic shift results">
          {[
            { label: 'Score', value: snapshot?.stats.score, detail: 'synthetic points' },
            { label: 'Routed', value: snapshot?.stats.routed, detail: 'queue handoffs' },
            {
              label: 'Rubric matches',
              value: snapshot?.stats.matches,
              detail: `${snapshot?.stats.mismatches ?? 0} mismatches`,
            },
            { label: 'Missed', value: snapshot?.stats.missed, detail: 'game deadlines' },
            { label: 'Streak', value: snapshot?.stats.streak, detail: `best ${snapshot?.stats.bestStreak ?? 0}` },
          ].map((metric) => (
            <div key={metric.label} className="ag-metric">
              <span>{metric.label}</span>
              <strong>{metric.value ?? '—'}</strong>
              <small>{metric.detail}</small>
            </div>
          ))}
          <div className="ag-metric ag-metric--latency">
            <span>Last AI transport</span>
            <strong>
              {lastAi?.apiMs !== null && lastAi?.apiMs !== undefined ? Math.round(lastAi.apiMs) : '—'}
              <small> ms</small>
            </strong>
            <small>
              {game.run?.timings.apiP50 !== null && game.run?.timings.apiP50 !== undefined
                ? `p50 ${Math.round(game.run.timings.apiP50)} ms · this shift`
                : 'measured, not simulated'}
            </small>
          </div>
        </div>
        <div className="ag-snapshot-note">
          <span>Scores assess a synthetic routing rubric—not clinical correctness.</span>
          <span>
            {game.replay ? 'Saved snapshot' : 'Server snapshot'}
            {' · '}
            {game.run ? (
              <time dateTime={game.replay?.createdAt ?? game.run.observedAt}>
                {new Date(game.replay?.createdAt ?? game.run.observedAt).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </time>
            ) : (
              'Connecting'
            )}
            {' · '}
            {game.stale ? 'stale' : running ? 'polling every second' : 'paused'}
          </span>
        </div>

        {game.loading ? (
          <div className="ag-layout" aria-busy="true" aria-label="Loading the saved game">
            <Skeleton className="ag-loading-board" />
            <Skeleton className="ag-loading-board" />
          </div>
        ) : snapshot ? (
          <div className="ag-layout">
            <AlertBoard
              key={`${game.run?.id ?? 'game'}-${game.replay?.turn ?? 'live'}`}
              snapshot={snapshot}
              elapsedMs={game.elapsedMs}
              nextAlertId={game.replay ? null : (game.run?.nextDecision?.alertId ?? null)}
              pendingAlertId={game.pending?.alertId ?? null}
              replay={!!game.replay}
            />
            <section className="ag-right-column" aria-label="Dispatch queues and exact decision evidence">
              <AlertDispatch
                snapshot={snapshot}
                nextAlertId={game.replay ? null : (game.run?.nextDecision?.alertId ?? null)}
                disabled={!canRoute}
                onRoute={(route) => {
                  game.stopAutopilot();
                  void game.triage(route);
                }}
              />
              <AlertInspector game={game} />
            </section>
          </div>
        ) : (
          <Card className="ag-offline">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>The live game is not connected yet</EmptyTitle>
                <EmptyDescription>
                  This demo requires the alert-game API and Lakebase. Reconnect to load real saved state; no fake
                  decisions are shown.
                </EmptyDescription>
              </EmptyHeader>
              <Button variant="outline" disabled={game.controlBusy} onClick={() => void game.retry()}>
                Reconnect
              </Button>
            </Empty>
          </Card>
        )}

        {complete && !game.replay && (
          <div className="ag-finish" role="status">
            <ShieldCheck size={18} aria-hidden="true" />
            <p>
              Shift finished: {snapshot?.stats.routed ?? 0} handed off, {snapshot?.stats.matches ?? 0} rubric matches,{' '}
              {snapshot?.stats.missed ?? 0} missed. Devices were not diagnosed or repaired.
              {game.routing ? ' A real response is still in flight; late results are recorded without routing.' : ''}
            </p>
          </div>
        )}

        <details className="ag-sources">
          <summary>
            <ExternalLink size={14} aria-hidden="true" />
            Real-world inspiration: GE HealthCare OnWatch technical-service alerts
            <span>Sources & boundaries</span>
          </summary>
          <div className="ag-source-grid">
            <div>
              <h3>A real service workflow</h3>
              <p>
                GE describes automated imaging-equipment alerts reviewed by a remote engineer, with on-site follow-up
                when needed.
              </p>
              <a
                href="https://www.gehealthcare.com/en-us/services/digital-solutions/onwatch"
                target="_blank"
                rel="noreferrer"
              >
                GE HealthCare OnWatch <ExternalLink size={13} aria-hidden="true" />
              </a>
            </div>
            <div>
              <h3>A concrete MRI example</h3>
              <p>
                GE publishes a cooling-airflow case: remote log review led to an on-site inspection that found a
                saturated air filter.
              </p>
              <a href="https://landing1.gehealthcare.com/Innovation-Talk-Landing.html" target="_blank" rel="noreferrer">
                MRI cooling / air-filter case <ExternalLink size={13} aria-hidden="true" />
              </a>
            </div>
          </div>
          <p className="ag-boundary">
            GE is the workflow inspiration, not an AI_DECIDE customer claim. Devices, sites, notes, routing policy,
            deadlines, and scores are fictional. These are technical-service alerts, not patient or clinical alarms.
            Queue handoffs do not control a device, authorize its use, repair it, or automatically dispatch anyone.
          </p>
        </details>

        <footer className="ag-footer">
          <span>
            Real AI_DECIDE calls · simulated alerts and handoffs ·{' '}
            {game.health ? `Lakebase: ${game.health.lakebase}` : 'storage health unavailable'}
          </span>
          <span>No patient data · no device control</span>
        </footer>
        <div className="ag-sr-only" role="status" aria-live="polite">
          {game.notice}
        </div>
      </main>
    </div>
  );
}
