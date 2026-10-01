import { Badge, Button, Card, Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@databricks/appkit-ui/react';
import { ArrowDown, Clock3, Inbox, Radio, ScanLine } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AlertGameSnapshot, DeviceAlert } from '../../../shared/alerts';

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
  const nextArrival = snapshot.nextArrivalMs === null ? null : Math.max(0, (snapshot.nextArrivalMs - elapsedMs) / 1000);

  function inspectDevice(deviceId: string) {
    const next = queued.find((alert) => alert.deviceId === deviceId);
    const latest = snapshot.alerts.filter((alert) => alert.deviceId === deviceId).at(-1);
    setInspectedId(next?.id ?? latest?.id ?? null);
  }

  return (
    <section className="ag-left-column" aria-label="Device feed and incoming alerts">
      <Card className="ag-fleet">
        <div className="ag-panel-heading">
          <div>
            <p className="ag-eyebrow">01 / Observe</p>
            <h2>Connected-device feed</h2>
          </div>
          <Badge variant="outline" className="ag-fleet-badge">
            <Radio size={12} aria-hidden="true" />
            {snapshot.devices.length} fictional scanners
          </Badge>
        </div>
        <div className="ag-device-grid">
          {snapshot.devices.map((device) => {
            const deviceQueued = queued.filter((alert) => alert.deviceId === device.id);
            const latest = snapshot.alerts.filter((alert) => alert.deviceId === device.id).at(-1);
            const selected = inspected?.deviceId === device.id;
            const missed = latest?.status === 'expired' && deviceQueued.length === 0;
            return (
              <Button
                key={device.id}
                variant="ghost"
                className={`ag-device${deviceQueued.length ? ' ag-device--queued' : ''}${selected ? ' ag-device--selected' : ''}${missed ? ' ag-device--missed' : ''}`}
                aria-pressed={selected}
                aria-label={`${device.id}, ${device.modality}, ${device.site}, ${deviceQueued.length} queued technical alerts`}
                onClick={() => inspectDevice(device.id)}
              >
                <span className="ag-device-top">
                  <ScanLine size={23} strokeWidth={1.5} aria-hidden="true" />
                  <span className="ag-device-modality">{device.modality}</span>
                  {deviceQueued.length > 0 && <span className="ag-device-count">{deviceQueued.length}</span>}
                </span>
                <span className="ag-device-name">{device.id}</span>
                <span className="ag-device-site" title={device.site}>
                  {device.site}
                </span>
                <span className="ag-device-state">
                  <span className="ag-status-dot" />
                  {deviceQueued.length ? 'Alert queued' : missed ? 'Game deadline missed' : 'No queued alerts'}
                </span>
              </Button>
            );
          })}
        </div>
        <div className="ag-feed-caption">
          <span>Tiles show alert activity, not device health.</span>
          <span>
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
          </span>
        </div>
      </Card>

      <Card className="ag-incoming">
        <div className="ag-panel-heading">
          <div className="ag-inline-heading">
            <Inbox size={18} aria-hidden="true" />
            <h2>Incoming alerts</h2>
            <Badge variant="secondary">{snapshot.pending} queued</Badge>
          </div>
          <span className="ag-small-note">Oldest first</span>
        </div>
        {queued.length ? (
          <ol className="ag-alert-list" aria-label="Queued technical alerts">
            {queued.map((alert) => {
              const secondsLeft = Math.max(0, (alert.dueAtMs - elapsedMs) / 1000);
              const isNext = alert.id === nextAlertId;
              return (
                <li key={alert.id}>
                  <Button
                    variant="ghost"
                    className={`ag-alert-row${inspected?.id === alert.id ? ' ag-alert-row--selected' : ''}`}
                    aria-pressed={inspected?.id === alert.id}
                    onClick={() => setInspectedId(alert.id)}
                  >
                    <span className="ag-alert-sequence" aria-hidden="true">
                      {isNext ? <ArrowDown size={15} /> : <Radio size={13} />}
                    </span>
                    <span className="ag-alert-copy">
                      <span className="ag-alert-headline">{alert.headline}</span>
                      <span className="ag-alert-meta">
                        {alert.deviceId}
                        {' · '}
                        {alert.id}
                        {alert.id === pendingAlertId ? ' · handoff in flight' : isNext ? ' · next to route' : ''}
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
          <Empty className="ag-empty">
            <EmptyHeader>
              <EmptyTitle>{snapshot.complete ? 'This shift is finished' : 'Queue clear'}</EmptyTitle>
              <EmptyDescription>
                {snapshot.complete
                  ? 'Inspect the saved handoffs or start a new shift.'
                  : snapshot.running
                    ? 'The feed keeps moving. The next technical alert will appear here.'
                    : 'Start the shift to continue the synthetic feed.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <p className="ag-queue-caption">Countdowns are game deadlines—not medical service SLAs.</p>
        {inspected && <AlertEvidence alert={inspected} isNext={inspected.id === nextAlertId} />}
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

function AlertEvidence({ alert, isNext }: { alert: DeviceAlert; isNext: boolean }) {
  return (
    <div className="ag-evidence" aria-label={`Observed evidence for ${alert.id}`}>
      <div className="ag-evidence-heading">
        <p className="ag-eyebrow">{isNext ? 'Next routing input' : 'Inspecting observed evidence'}</p>
        <code>{alert.id}</code>
      </div>
      <blockquote>{alert.technicianNote}</blockquote>
      <dl>
        <div>
          <dt>Technical signal</dt>
          <dd>{alert.signal}</dd>
        </div>
        <div>
          <dt>Diagnostic evidence</dt>
          <dd>{alert.diagnostics}</dd>
        </div>
        <div>
          <dt>Remote review</dt>
          <dd>{alert.remoteReview === 'completed' ? 'Already completed' : 'Not started'}</dd>
        </div>
        <div>
          <dt>Alert state</dt>
          <dd>{alert.status === 'routed' ? 'Handed off—not repaired' : alert.status}</dd>
        </div>
      </dl>
      {!isNext && alert.status === 'queued' && (
        <p className="ag-small-note">
          Inspection does not change routing order. Controls route the oldest queued alert.
        </p>
      )}
    </div>
  );
}
