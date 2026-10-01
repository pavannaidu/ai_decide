import { Alert, AlertDescription, AlertTitle, Button, Skeleton } from '@databricks/appkit-ui/react';
import { Activity, ArrowRight, LoaderCircle, Pause, Play, RotateCcw, TriangleAlert } from 'lucide-react';
import { DecisionExchange, PreviousDecisions } from './components/SimulationViews';
import { LabBoard } from './components/LabBoard';
import { useSimulation } from './useSimulation';
import type { ScenarioKind } from '../../shared/types';

const STORIES: { kind: ScenarioKind; label: string }[] = [
  { kind: 'lot_qc', label: 'Shared reagent issue' },
  { kind: 'isolated_fault', label: 'Equipment fault' },
  { kind: 'ambiguous_report', label: 'Missing details' },
];

export default function LegacyLabApp() {
  const sim = useSimulation();
  const complete = (sim.run?.tick ?? 0) >= 60;
  const showingNext = sim.deciding || (!!sim.error && sim.hasRetry) || !sim.step;
  const step = showingNext ? null : sim.step;
  const request = step?.request ?? sim.run?.nextDecision?.request ?? null;
  const scene = step?.beforeSnapshot ?? sim.run?.nextDecision?.beforeSnapshot ?? sim.snapshot;
  const disabled = sim.loading || sim.busy || !!sim.replay || complete || !!sim.error;
  const scenario = sim.run?.scenario ?? 'lot_qc';

  return (
    <div className="app-shell">
      <a className="skip-link" href="#demo">
        Skip to demo
      </a>
      <header className="app-header">
        <span className="wordmark">
          <Activity size={21} aria-hidden="true" />
          <code>ai_decide</code>
          <span className="wordmark-sub">/ lab demo</span>
        </span>
        <span className="synthetic-note">Synthetic data only</span>
      </header>

      <main id="demo" className="app-main">
        <section className="intro">
          <p className="eyebrow">MedTech · live AI decisions</p>
          <h1>What should the lab do next?</h1>
          <p>A lab problem in. One AI decision out.</p>
        </section>

        <div className="simulation-toolbar">
          <div className="story-picker" role="group" aria-label="Choose a story">
            {STORIES.map((story) => (
              <Button
                key={story.kind}
                variant="outline"
                className="story-button"
                aria-pressed={scenario === story.kind}
                disabled={sim.loading || sim.busy || sim.playing}
                onClick={() => void sim.startStory(story.kind)}
              >
                {story.label}
              </Button>
            ))}
          </div>
          <div className="decision-controls">
            <Button
              className="ask-button"
              disabled={disabled || sim.playing || !request}
              onClick={() => void sim.tick()}
            >
              {sim.deciding ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}
              {sim.deciding ? 'AI_DECIDE is choosing…' : 'Ask AI_DECIDE'}
            </Button>
            <Button
              variant="outline"
              disabled={sim.loading || !!sim.replay || complete || (!sim.playing && (sim.busy || !!sim.error))}
              onClick={sim.playing ? sim.pause : sim.play}
            >
              {sim.playing ? <Pause size={16} /> : <Play size={16} />}
              {sim.playing ? 'Pause' : 'Play'}
            </Button>
            <Button
              variant="ghost"
              disabled={sim.loading || sim.busy || sim.playing}
              onClick={() => void sim.startStory(scenario)}
            >
              <RotateCcw size={15} />
              Restart
            </Button>
            <span className="run-state">
              {sim.replay ? `Saved turn ${sim.replay.turn}` : `Turn ${sim.run?.tick ?? 0}`}
              {' · '}
              {sim.replay ? 'replay' : complete ? 'complete' : sim.playing ? 'live' : 'paused'}
            </span>
          </div>
        </div>

        {sim.error && (
          <Alert variant="destructive" className="operation-error">
            <TriangleAlert size={18} />
            <AlertTitle>The demo is paused</AlertTitle>
            <AlertDescription>
              <span>{sim.error}</span>
              <Button variant="outline" disabled={sim.busy} onClick={() => void sim.retry()}>
                {sim.hasRetry ? 'Retry decision' : 'Reconnect'}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {sim.replay && (
          <div className="replay-banner" role="status">
            <span>Saved turn {sim.replay.turn} · no new API call</span>
            <Button variant="outline" onClick={sim.exitReplay}>
              Back to live
            </Button>
          </div>
        )}

        {complete && !sim.replay && <p className="completion-note">60 turns complete. Restart to try again.</p>}

        <div className="demo-layout">
          <div className="lab-column">
            {sim.loading ? (
              <Skeleton className="story-skeleton" aria-label="Loading the saved story" />
            ) : (
              <LabBoard
                key={sim.run?.id ?? 'offline'}
                snapshot={step?.afterSnapshot ?? scene}
                observation={scene}
                step={step}
                deciding={sim.deciding}
                playing={sim.playing}
              />
            )}
          </div>
          <div className="decision-column">
            <DecisionExchange
              request={request}
              step={step}
              deciding={sim.deciding}
              failed={!!sim.error && sim.hasRetry}
            />
            <div className="secondary-details">
              <PreviousDecisions steps={sim.steps} busy={sim.busy || sim.playing} replay={sim.selectReplay} />
              <details className="about-demo">
                <summary>How it works</summary>
                <div className="about-copy">
                  <p>
                    Like Snake: observe the board, choose a move, apply it, repeat. Here the board is a simulated lab
                    and each move is a real AI_DECIDE API response.
                  </p>
                  <p>
                    Play repeats the loop about every two seconds. Lakebase saves the exact request, response, and
                    outcome. Saved decisions replay without calling AI again.
                  </p>
                  <p>
                    AI can choose incorrectly; we show what actually happens. Confidence is AI-reported, not a
                    correctness guarantee. No patient data, clinical decisions, or real device control.
                  </p>
                  <a href="https://docs.databricks.com/api/ai-functions/v1/ai-decide" target="_blank" rel="noreferrer">
                    AI_DECIDE REST reference <ArrowRight size={14} />
                  </a>
                </div>
              </details>
            </div>
          </div>
        </div>

        <div className="sr-only" role="status" aria-live="polite">
          {sim.notice}
        </div>

        <footer className="app-footer">
          <span>Real AI_DECIDE · simulated actions · {sim.health ? 'saved in Lakebase' : 'storage unavailable'}</span>
          <span>No patient data or device control</span>
        </footer>
      </main>
    </div>
  );
}
