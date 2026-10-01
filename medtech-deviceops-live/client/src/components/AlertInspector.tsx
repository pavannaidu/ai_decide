import { Badge, Button, Card, Tooltip, TooltipContent, TooltipTrigger } from '@databricks/appkit-ui/react';
import { ArrowRight, Check, Clock3, History, Info, LoaderCircle, Minus, UserRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ALERT_ROUTES } from '../../../shared/alerts';
import type { useAlertGame } from '../useAlertGame';
import { formatJson } from '../lib/json';

export function AlertInspector({ game }: { game: ReturnType<typeof useAlertGame> }) {
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const evidenceKey = `${game.run?.id}:${game.step?.turn}`;
  const showNext = previewFor === evidenceKey;
  const step = game.replay ?? (game.pending || showNext ? null : game.step);
  const request = game.pending?.request ?? step?.request ?? game.run?.nextDecision?.request ?? null;
  const requestJson = useMemo(() => (request ? formatJson(request) : ''), [request]);
  const responseJson = useMemo(() => (step?.source === 'ai' ? formatJson(step.rawResponse) : ''), [step]);
  const human = step?.source === 'human' || !!game.pending?.route;
  const source = game.deciding
    ? 'Live API call'
    : human
      ? 'Human handoff'
      : step
        ? 'Saved API response'
        : 'Request preview';
  const routeLabel = step
    ? (ALERT_ROUTES.find((route) => route.id === step.selectedAction)?.label ?? step.selectedAction)
    : null;
  const disabled = game.controlBusy || game.routing || !!game.pending;

  return (
    <Card className="ag-inspector" data-game-no-shortcuts>
      <div className="ag-panel-heading">
        <h2>AI_DECIDE</h2>
        <Badge variant="outline">{source}</Badge>
      </div>
      {!game.replay && game.step && !game.pending && (
        <div className="ag-inspector-picker" role="group" aria-label="Choose decision evidence">
          <Button variant="ghost" size="sm" aria-pressed={!showNext} onClick={() => setPreviewFor(null)}>
            Last handoff
          </Button>
          <Button variant="ghost" size="sm" aria-pressed={showNext} onClick={() => setPreviewFor(evidenceKey)}>
            Next input
          </Button>
        </div>
      )}
      <div className="ag-endpoint">
        {human ? (
          <span>Human route—no AI call</span>
        ) : (
          <>
            <Badge variant="secondary">POST</Badge>
            <code>/api/2.0/ai-functions/ai-decide</code>
          </>
        )}
        {step?.apiMs !== null && step?.apiMs !== undefined && (
          <span className="ag-transport-time">
            <Clock3 size={12} aria-hidden="true" />
            {Math.round(step.apiMs)} ms transport
          </span>
        )}
      </div>
      <details className="ag-json" open>
        <summary>
          <span>{human ? 'Context' : 'Request'}</span>
          <span>{request?.state.alert.id ?? 'No queued alert'}</span>
        </summary>
        {request ? (
          <pre tabIndex={0} aria-label={human ? 'Recorded human routing context' : 'Exact AI_DECIDE request'}>
            {requestJson}
          </pre>
        ) : (
          <p className="ag-json-empty">There is no next routing input. The feed or a new shift supplies it.</p>
        )}
      </details>
      <details className="ag-json" open>
        <summary>
          <span>{human ? 'Handoff' : 'Response'}</span>
          <span>
            {step ? `Handoff ${step.turn}` : game.routing ? 'In flight' : game.hasRetry ? 'Failed' : 'Not called'}
          </span>
        </summary>
        {human ? (
          <div className="ag-no-response">
            <UserRound size={17} aria-hidden="true" />
            <div>
              <p>Human route—no AI call.</p>
              <span>{game.routing ? 'Saving the handoff…' : 'No AI response or AI latency is invented.'}</span>
            </div>
          </div>
        ) : game.deciding ? (
          <div className="ag-no-response" role="status">
            <LoaderCircle size={17} className="ag-spin" aria-hidden="true" />
            <div>
              <p>AI_DECIDE is choosing a handoff…</p>
              <span>The game clock and incoming feed continue independently.</span>
            </div>
          </div>
        ) : step ? (
          <pre tabIndex={0} aria-label="Exact AI_DECIDE response">
            {responseJson}
          </pre>
        ) : (
          <p className="ag-json-empty">
            {game.hasRetry
              ? 'No successful response is available. Retry reuses the same operation ID.'
              : 'Start the shift, then ask AI_DECIDE. The real response appears here.'}
          </p>
        )}
      </details>
      {game.pending && (
        <p className="ag-operation-id">
          Operation <code>{game.pending.requestId}</code>
        </p>
      )}
      {step && (
        <div className={`ag-outcome ag-outcome--${step.outcome.kind}`} role="status">
          {step.outcome.kind === 'match' ? (
            <Check size={19} aria-hidden="true" />
          ) : step.outcome.kind === 'late' ? (
            <Clock3 size={19} aria-hidden="true" />
          ) : (
            <Minus size={19} aria-hidden="true" />
          )}
          <div>
            <p className="ag-action-label">
              {step.outcome.kind === 'late' ? 'Late response · no handoff' : routeLabel}
              <code>{step.selectedAction}</code>
            </p>
            <div className="ag-outcome-meta">
              <span>
                {step.outcome.kind === 'match'
                  ? 'Rubric match'
                  : step.outcome.kind === 'late'
                    ? 'Too late'
                    : 'Rubric mismatch'}
                {' · '}
                {step.outcome.points > 0 ? '+' : ''}
                {step.outcome.points} pts
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="ag-outcome-help"
                    type="button"
                    aria-label={`Outcome details: ${step.outcome.message} ${step.outcome.explanation}`}
                  >
                    <Info size={13} aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="ag-outcome-tooltip" side="right" sideOffset={6}>
                  <strong>{step.outcome.message}</strong>
                  <span>{step.outcome.explanation}</span>
                  <span>Expected route: {step.outcome.expectedRoute}</span>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
      )}

      <details className="ag-history">
        <summary>
          <History size={14} aria-hidden="true" />
          Saved handoffs
          <Badge variant="secondary">{game.steps.length}</Badge>
          <span>Replay without AI</span>
        </summary>
        <p className="ag-small-note">Opening a handoff pauses this shift. Returning to live leaves it paused.</p>
        {game.steps.length ? (
          <ol className="ag-history-list">
            {game.steps.map((entry) => (
              <li key={entry.turn}>
                <Button variant="ghost" disabled={disabled} onClick={() => void game.selectReplay(entry.turn)}>
                  <span className="ag-history-turn">#{entry.turn}</span>
                  <span>
                    <strong>{entry.actionLabel}</strong>
                    <span className="ag-history-meta">
                      {entry.alertId} ·{' '}
                      {entry.outcome.kind === 'late' ? 'late, not routed' : `rubric ${entry.outcome.kind}`}
                    </span>
                  </span>
                  <span className="ag-history-timing">
                    {entry.source === 'human'
                      ? 'Human · no AI'
                      : entry.apiMs === null
                        ? 'Latency unavailable'
                        : `${Math.round(entry.apiMs)} ms`}
                    <ArrowRight size={13} aria-hidden="true" />
                  </span>
                </Button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="ag-history-empty">No handoffs yet. Route an alert to create inspectable history.</p>
        )}
        {game.runs.length > 1 && (
          <details className="ag-saved-shifts">
            <summary>Earlier shifts · preserved in Lakebase</summary>
            {game.runs
              .filter((entry) => entry.id !== game.run?.id)
              .map((entry) => (
                <Button
                  key={entry.id}
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => void game.openSavedShift(entry.id)}
                >
                  <span>{entry.mode === 'storm' ? 'Alert storm' : 'Steady feed'}</span>
                  <time dateTime={entry.createdAt}>
                    {new Date(entry.createdAt).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </time>
                  <ArrowRight size={13} aria-hidden="true" />
                </Button>
              ))}
          </details>
        )}
      </details>
    </Card>
  );
}
