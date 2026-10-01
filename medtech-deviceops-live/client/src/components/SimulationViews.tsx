import { useState } from 'react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@databricks/appkit-ui/react';
import { ArrowDown, ArrowRight, Check, History, LoaderCircle } from 'lucide-react';
import type { DecisionRequest, StepDetail, StepSummary } from '../../../shared/types';
import { formatJson } from '../lib/json';

function actionLabel(id: string) {
  const [kind, target] = id.split(':');
  if (kind === 'review') return `Review reagent lot ${target}`;
  if (kind === 'service') return `Service machine ${target}`;
  if (kind === 'clarify') return `Ask a technician about ${target}`;
  return 'Wait for the next observation';
}

function JsonBody({ value, label }: { value: unknown; label: string }) {
  return (
    <pre className="json-body" tabIndex={0} aria-label={label}>
      <code>{formatJson(value)}</code>
    </pre>
  );
}

export function DecisionExchange({
  request,
  step,
  deciding,
  failed,
}: {
  request: DecisionRequest | null;
  step: StepDetail | null;
  deciding: boolean;
  failed: boolean;
}) {
  return (
    <section className="decision-exchange" aria-label="AI_DECIDE request and response">
      <div className="exchange-grid">
        <Card className="request-card">
          <CardHeader className="exchange-heading">
            <div>
              <p className="eyebrow">01 · input</p>
              <h2>Request</h2>
            </div>
            <span className="exchange-status">
              {step ? `Sent · turn ${step.turn}` : deciding ? 'Sending…' : 'Ready to send'}
            </span>
          </CardHeader>
          <CardContent className="exchange-content">
            <p className="endpoint">
              <code>POST /api/2.0/ai-functions/ai-decide</code>
            </p>
            {request ? (
              <JsonBody value={request} label="Exact AI_DECIDE request JSON" />
            ) : (
              <Empty className="exchange-empty">
                <EmptyHeader>
                  <EmptyTitle>Request unavailable</EmptyTitle>
                  <EmptyDescription>Connect to the saved story to see the actual request.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>

        <Card className="response-card">
          <CardHeader className="exchange-heading">
            <div>
              <p className="eyebrow">02 · output</p>
              <h2>Response</h2>
            </div>
            {step && <span className="api-time">{step.apiMs.toLocaleString()} ms</span>}
          </CardHeader>
          <CardContent className="exchange-content">
            {step ? (
              <>
                <div className="selected-action">
                  <ArrowRight size={19} aria-hidden="true" />
                  <strong>{actionLabel(step.selectedAction)}</strong>
                </div>
                <JsonBody value={step.rawResponse} label="Exact AI_DECIDE response JSON" />
              </>
            ) : (
              <Empty className="exchange-empty">
                <EmptyHeader>
                  {deciding && <LoaderCircle className="spin" size={26} aria-hidden="true" />}
                  <EmptyTitle>
                    {deciding ? 'AI_DECIDE is choosing…' : failed ? 'No response to apply' : 'What will AI choose?'}
                  </EmptyTitle>
                  <EmptyDescription>
                    {deciding
                      ? 'Calling the real API with the request shown above.'
                      : failed
                        ? 'The call failed. Retry this decision; no mock response is used.'
                        : 'Press Ask AI_DECIDE to call the real API.'}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
      </div>

      {step && (
        <div className={`simulation-result ${step.outcome.kind === 'no_change' ? 'result-wait' : ''}`} role="status">
          {step.outcome.kind === 'applied' ? (
            <Check size={21} aria-hidden="true" />
          ) : (
            <ArrowDown size={21} aria-hidden="true" />
          )}
          <div>
            <p className="eyebrow">03 · simulated result</p>
            <p>{step.outcome.message}</p>
          </div>
        </div>
      )}
    </section>
  );
}

export function PreviousDecisions({
  steps,
  busy,
  replay,
}: {
  steps: StepSummary[];
  busy: boolean;
  replay: (turn: number) => Promise<void>;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? steps : steps.slice(0, 5);
  return (
    <details className="previous-decisions">
      <summary>
        <History size={15} aria-hidden="true" /> Previous decisions ({steps.length})
      </summary>
      {steps.length ? (
        <div className="history-list">
          {visible.map((step) => (
            <Button
              variant="ghost"
              key={step.turn}
              disabled={busy}
              onClick={() => void replay(step.turn)}
              className="history-row"
            >
              <span className="history-turn">Turn {step.turn}</span>
              <span>{actionLabel(step.selectedAction)}</span>
              <span className="history-latency">
                {step.apiMs} ms <ArrowRight size={14} />
              </span>
            </Button>
          ))}
          {steps.length > 5 && (
            <Button variant="ghost" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show fewer' : 'Show all'}
            </Button>
          )}
        </div>
      ) : (
        <p className="history-empty">Your first decision appears here after the API responds.</p>
      )}
    </details>
  );
}
