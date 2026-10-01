import { useState } from 'react';
import { Button } from '@databricks/appkit-ui/react';
import { Activity, Check, Cpu, FlaskConical, HelpCircle, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { Analyzer, FleetSnapshot, StepDetail } from '../../../shared/types';

function deviceLabel(device: Analyzer) {
  if (device.pending === 'review') return 'In quality review';
  if (device.pending === 'information') return 'Technician asked';
  if (device.status === 'fault') return 'Equipment fault';
  if (device.qc === 'failed') return 'QC failed';
  if (device.status === 'ambiguous') return 'Details missing';
  return 'Ready';
}

function situation(snapshot: FleetSnapshot) {
  const failing = snapshot.devices.filter((device) => device.qc === 'failed');
  const sharedLot = failing.find((device) => failing.filter((other) => other.lotId === device.lotId).length >= 2);
  if (sharedLot) {
    const count = failing.filter((device) => device.lotId === sharedLot.lotId).length;
    return {
      title: `${count === 2 ? 'Two' : count} machines fail the same quality check.`,
      detail: `They share reagent lot ${sharedLot.lotId}—the same batch of testing chemicals. Repair a machine—or check that batch?`,
    };
  }
  const faults = snapshot.devices.filter((device) => device.status === 'fault' && !device.pending);
  if (faults.length) {
    return {
      title:
        faults.length === 1
          ? 'One machine reports an equipment fault.'
          : `${faults.length} machines report equipment faults.`,
      detail: `${faults.map((device) => device.id).join(' and ')}: calibration drift reported; reagent quality checks passed.`,
    };
  }
  const incomplete = snapshot.devices.find((device) => device.status === 'ambiguous' && !device.pending);
  if (incomplete) {
    return {
      title: 'A report is missing measurements.',
      detail: `${incomplete.id} has an incomplete technician note. Ask for details—or guess the cause?`,
    };
  }
  if (snapshot.pendingTasks.length) {
    return {
      title: 'A simulated response is on the way.',
      detail: 'A reviewer or technician is already checking the issue. AI can choose to wait.',
    };
  }
  return {
    title: 'All machines are ready.',
    detail: 'Try another story, or press Play to watch AI respond to new incidents.',
  };
}

function MachineIcon({ device }: { device: Analyzer }) {
  const StatusIcon = device.pending
    ? LoaderCircle
    : device.status === 'healthy'
      ? Check
      : device.status === 'ambiguous'
        ? HelpCircle
        : TriangleAlert;
  return (
    <span className="machine-shell" aria-hidden="true">
      <span className="machine-display">
        <StatusIcon size={15} />
      </span>
      <span className="machine-tray">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

export function LabBoard({
  snapshot,
  observation,
  step,
  deciding,
  playing,
}: {
  snapshot: FleetSnapshot | null;
  observation: FleetSnapshot | null;
  step: StepDetail | null;
  deciding: boolean;
  playing: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (!snapshot) {
    return (
      <section className="story-board">
        <h2>The lab is not connected yet.</h2>
        <p>Reconnect to load the story. We do not substitute fake AI responses.</p>
      </section>
    );
  }

  const story = situation(observation ?? snapshot);
  const lots = [...new Set(snapshot.devices.map((device) => device.lotId))];
  const selected =
    snapshot.devices.find((device) => device.id === selectedId) ??
    snapshot.devices.find((device) => step?.outcome.affectedIds.includes(device.id)) ??
    snapshot.devices.find((device) => device.status !== 'healthy') ??
    snapshot.devices[0];
  const ready = snapshot.devices.filter((device) => device.status === 'healthy').length;

  return (
    <section className="story-board" aria-labelledby="story-title">
      <div className="story-heading">
        <p className="eyebrow">{step ? 'The situation AI saw' : 'The story · what AI sees'}</p>
        <h2 id="story-title">{story.title}</h2>
        <p>{story.detail}</p>
      </div>

      <section
        className="lab-arena"
        aria-label="Lab machines grouped by reagent batch"
        data-running={playing}
        data-deciding={deciding}
      >
        <div className="lab-arena-heading">
          <span>
            <Activity size={15} aria-hidden="true" />
            {step ? 'Lab after the decision' : 'The simulated lab'}
          </span>
          <span className="lab-count">
            {ready}/{snapshot.devices.length} ready
          </span>
        </div>
        <p className="lab-group-hint">Same column = same reagent batch</p>

        <div className="reagent-lanes">
          {lots.map((lotId) => {
            const devices = snapshot.devices.filter((device) => device.lotId === lotId);
            const failures = devices.filter((device) => device.qc === 'failed').length;
            const reviewing = devices.some((device) => device.pending === 'review');
            const targeted = step?.selectedAction === `review:${lotId}`;
            return (
              <div className="reagent-lane" key={lotId}>
                <div
                  className={`reagent-canister ${failures || reviewing ? 'batch-attention' : ''}`}
                  data-targeted={targeted}
                >
                  <FlaskConical size={22} aria-hidden="true" />
                  <div>
                    <strong>{lotId}</strong>
                    <span>{reviewing ? 'Review pending' : failures ? `${failures} QC failures` : 'Reagent batch'}</span>
                  </div>
                  {targeted && <span className="action-flash" key={step?.turn} aria-hidden="true" />}
                </div>
                <div className="machine-stack">
                  {devices.map((device) => {
                    const affected = step?.outcome.affectedIds.includes(device.id) ?? false;
                    return (
                      <Button
                        variant="ghost"
                        key={device.id}
                        className={`machine-button machine-${device.status}`}
                        aria-label={`Inspect ${device.id}: ${deviceLabel(device)}`}
                        aria-pressed={selected?.id === device.id}
                        data-affected={affected}
                        onClick={() => setSelectedId(device.id)}
                      >
                        <MachineIcon device={device} />
                        <span className="machine-label">
                          <strong>{device.id}</strong>
                          <span>{deviceLabel(device)}</span>
                          <small>Bay {device.bay}</small>
                        </span>
                        {affected && <span className="action-flash" key={step?.turn} aria-hidden="true" />}
                      </Button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="lab-legend" aria-label="Machine status legend">
          <span>
            <i className="legend-ready" />
            Ready
          </span>
          <span>
            <i className="legend-attention" />
            Needs attention
          </span>
          <span>
            <i className="legend-pending" />
            Response pending
          </span>
          <span className="lab-inspect-hint">Click a machine to inspect</span>
        </div>
      </section>

      {selected && (
        <div className="machine-detail" aria-label="Selected machine details">
          <div className="machine-detail-heading">
            <Cpu size={16} aria-hidden="true" />
            <strong>{selected.id}</strong>
            <span>{deviceLabel(selected)}</span>
          </div>
          <dl>
            <div>
              <dt>Reagent batch</dt>
              <dd>{selected.lotId}</dd>
            </div>
            <div>
              <dt>Quality check</dt>
              <dd>{selected.qc}</dd>
            </div>
            <div>
              <dt>Temperature</dt>
              <dd>{selected.temperatureC === null ? 'Unknown' : `${selected.temperatureC.toFixed(1)} °C`}</dd>
            </div>
            <div>
              <dt>Calibration offset</dt>
              <dd>{selected.calibrationOffset?.toFixed(2) ?? 'Unknown'}</dd>
            </div>
          </dl>
          <p>{selected.report}</p>
        </div>
      )}

      {snapshot.events
        .filter(
          (event) =>
            event.turn === snapshot.turn &&
            (event.kind === 'simulated_reviewer' || event.kind === 'simulated_clarification')
        )
        .map((event) => (
          <p className="response-event" key={event.id}>
            {event.message}
          </p>
        ))}
    </section>
  );
}
