import { Badge, Button, Card, Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@databricks/appkit-ui/react';
import { Clock3, Inbox, Radio, ScanLine } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AlertGameSnapshot, DeviceAlert, ImagingDevice } from '../../../shared/alerts';

interface AlertBoardProps {
  snapshot: AlertGameSnapshot;
  elapsedMs: number;
  nextAlertId: string | null;
  pendingAlertId: string | null;
  replay: boolean;
}

export function AlertBoard({ snapshot, elapsedMs, nextAlertId, pendingAlertId, replay }: AlertBoardProps) {
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const queued = useMemo(
    () =>
      snapshot.alerts
        .filter((alert) => alert.status === 'queued')
        .sort((left, right) => left.arrivedAtMs - right.arrivedAtMs || left.id.localeCompare(right.id)),
    [snapshot.alerts]
  );
  const expired = useMemo(() => snapshot.alerts.filter((alert) => alert.status === 'expired'), [snapshot.alerts]);
  const inspected =
    snapshot.alerts.find((alert) => alert.id === inspectedId) ??
    queued.find((alert) => alert.id === nextAlertId) ??
    queued[0] ??
    snapshot.alerts.at(-1) ??
    null;
  const device = snapshot.devices.find((entry) => entry.id === inspected?.deviceId) ?? null;
  const nextArrival = snapshot.nextArrivalMs === null ? null : Math.max(0, (snapshot.nextArrivalMs - elapsedMs) / 1000);

  return (
    <section className="ag-alert-board" aria-label="Live incoming device alerts">
      <Card className="ag-incoming">
        <div className="ag-panel-heading">
          <div>
            <p className="ag-eyebrow">01 · Alert</p>
            <h2>Incoming alerts</h2>
          </div>
          <div className="ag-board-badges">
            <Badge variant="outline" className="ag-fleet-badge">
              <Radio size={12} aria-hidden="true" />
              {snapshot.devices.length} devices
            </Badge>
            <Badge variant="secondary">{snapshot.pending} waiting</Badge>
          </div>
        </div>

        {inspected ? (
          <AlertEvidence
            alert={inspected}
            device={device}
            elapsedMs={elapsedMs}
            isNext={inspected.id === nextAlertId}
            inFlight={inspected.id === pendingAlertId}
          />
        ) : (
          <Empty className="ag-empty">
            <EmptyHeader>
              <EmptyTitle>{snapshot.complete ? 'This shift is finished' : 'Queue clear'}</EmptyTitle>
              <EmptyDescription>
                {snapshot.complete
                  ? 'Inspect a saved handoff or start a new shift.'
                  : snapshot.running
                    ? 'The feed is live. The next synthetic technical alert will appear here.'
                    : 'Start the shift to continue the synthetic feed.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        <div className="ag-queue">
          <div className="ag-queue-heading">
            <span>
              <Inbox size={15} aria-hidden="true" />
              Queue order
            </span>
            <span className="ag-small-note">Oldest first</span>
          </div>
          {queued.length ? (
            <ol className="ag-alert-list" aria-label="Queued technical alerts">
              {queued.map((alert, index) => {
                const secondsLeft = Math.max(0, (alert.dueAtMs - elapsedMs) / 1000);
                return (
                  <li key={alert.id}>
                    <Button
                      variant="ghost"
                      className={`ag-alert-row${inspected?.id === alert.id ? ' ag-alert-row--selected' : ''}`}
                      aria-pressed={inspected?.id === alert.id}
                      onClick={() => setInspectedId(alert.id)}
                    >
                      <span className="ag-alert-sequence">{index + 1}</span>
                      <span className="ag-alert-copy">
                        <span className="ag-alert-headline">{alert.headline}</span>
                        <span className="ag-alert-meta">
                          {alert.deviceId} · {alert.id}
                          {alert.id === pendingAlertId ? ' · handoff in flight' : index === 0 ? ' · next' : ''}
                        </span>
                      </span>
                      <span className={`ag-alert-deadline${secondsLeft < 3 ? ' ag-alert-deadline--soon' : ''}`}>
                        <Clock3 size={12} aria-hidden="true" />
                        {secondsLeft > 0 ? `${secondsLeft.toFixed(1)}s` : 'Syncing'}
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="ag-queue-empty">No alerts are waiting.</p>
          )}
        </div>

        <div className="ag-feed-caption">
          {replay
            ? 'Saved snapshot'
            : snapshot.complete
              ? 'Feed finished'
              : !snapshot.running
                ? 'Feed paused'
                : nextArrival === null
                  ? 'No more arrivals'
                  : nextArrival === 0
                    ? 'Arrival syncing…'
                    : `Next alert in ${nextArrival.toFixed(1)}s`}
        </div>

        {expired.length > 0 && (
          <details className="ag-missed">
            <summary>
              {expired.length} missed game {expired.length === 1 ? 'deadline' : 'deadlines'}
            </summary>
            <ul>
              {expired.map((alert) => (
                <li key={alert.id}>
                  <Button variant="ghost" onClick={() => setInspectedId(alert.id)}>
                    <code>{alert.deviceId}</code>
                    <span>{alert.headline}</span>
                    <Badge variant="outline">Missed</Badge>
                  </Button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>
    </section>
  );
}

function AlertEvidence({
  alert,
  device,
  elapsedMs,
  isNext,
  inFlight,
}: {
  alert: DeviceAlert;
  device: ImagingDevice | null;
  elapsedMs: number;
  isNext: boolean;
  inFlight: boolean;
}) {
  const secondsLeft = Math.max(0, (alert.dueAtMs - elapsedMs) / 1000);
  return (
    <div className="ag-evidence" aria-label={`Observed evidence for ${alert.id}`}>
      <div className="ag-evidence-heading">
        <span className="ag-alert-source">
          <ScanLine size={17} aria-hidden="true" />
          <code>{alert.deviceId}</code>
          {device && (
            <span>
              {device.modality} · {device.site}
            </span>
          )}
        </span>
        <Badge variant={isNext ? 'default' : 'outline'}>
          {inFlight ? 'AI call in flight' : isNext ? 'Next to route' : alert.status}
        </Badge>
      </div>
      <h3>{alert.headline}</h3>
      <blockquote>{alert.technicianNote}</blockquote>
      <dl>
        <div>
          <dt>Technical signal</dt>
          <dd>{alert.signal}</dd>
        </div>
        <div>
          <dt>Diagnostics</dt>
          <dd>{alert.diagnostics}</dd>
        </div>
        <div>
          <dt>Remote review</dt>
          <dd>{alert.remoteReview === 'completed' ? 'Completed' : 'Not started'}</dd>
        </div>
        <div>
          <dt>{alert.status === 'queued' ? 'Game time left' : 'Alert state'}</dt>
          <dd>{alert.status === 'queued' ? `${secondsLeft.toFixed(1)}s` : alert.status}</dd>
        </div>
      </dl>
      {!isNext && alert.status === 'queued' && (
        <p className="ag-small-note">Inspecting another alert does not change the oldest-first routing order.</p>
      )}
    </div>
  );
}
