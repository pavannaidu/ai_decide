import { Badge, Button, Card } from '@databricks/appkit-ui/react';
import { Check, ClipboardList, Headphones, MessageSquareMore, Minus } from 'lucide-react';
import { ALERT_ROUTES } from '../../../shared/alerts';
import type { AlertGameSnapshot, AlertRoute } from '../../../shared/alerts';

const ROUTE_ICONS = {
  remote_review: Headphones,
  field_review: ClipboardList,
  request_details: MessageSquareMore,
};

interface AlertDispatchProps {
  snapshot: AlertGameSnapshot;
  nextAlertId: string | null;
  disabled: boolean;
  onRoute: (route: AlertRoute) => void;
}

export function AlertDispatch({ snapshot, nextAlertId, disabled, onRoute }: AlertDispatchProps) {
  return (
    <Card className="ag-dispatch">
      <div className="ag-panel-heading">
        <div>
          <p className="ag-eyebrow">02 / Hand off</p>
          <h2>Three queues. One next move.</h2>
        </div>
        <Badge variant="outline">Handoffs only</Badge>
      </div>
      <div className="ag-lanes">
        {ALERT_ROUTES.map((route) => {
          const Icon = ROUTE_ICONS[route.id];
          const recent = snapshot.alerts
            .filter((alert) => alert.status === 'routed' && alert.route === route.id)
            .slice(-2);
          return (
            <section key={route.id} className="ag-lane" aria-label={`${route.label} handoff lane`}>
              <div className="ag-lane-heading">
                <Icon size={17} aria-hidden="true" />
                <span className="ag-lane-count">{snapshot.routeCounts[route.id]}</span>
              </div>
              <h3>{route.label}</h3>
              <p>{route.description}</p>
              <div className="ag-lane-recent">
                {recent.length ? (
                  recent.map((alert) => (
                    <div
                      key={alert.id}
                      className={`ag-handoff${alert.result === 'mismatch' ? ' ag-handoff--mismatch' : ''}`}
                    >
                      {alert.result === 'match' ? (
                        <Check size={12} aria-hidden="true" />
                      ) : (
                        <Minus size={12} aria-hidden="true" />
                      )}
                      <code>{alert.deviceId}</code>
                      <span>{alert.result === 'match' ? 'Rubric match' : 'Rubric mismatch'}</span>
                    </div>
                  ))
                ) : (
                  <span className="ag-lane-empty">No handoffs yet</span>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <div className="ag-human-routing">
        <div className="ag-human-caption">
          <span>Route it yourself</span>
          <span className="ag-small-note">{nextAlertId ? `Oldest: ${nextAlertId}` : 'Waiting for an alert'}</span>
        </div>
        <div className="ag-route-buttons" role="group" aria-label="Human handoff for oldest queued alert">
          {ALERT_ROUTES.map((route, index) => (
            <Button
              key={route.id}
              variant="outline"
              disabled={disabled}
              onClick={() => onRoute(route.id)}
              aria-label={`Route oldest alert to ${route.label}, keyboard shortcut ${index + 1}`}
            >
              <kbd aria-hidden="true">{index + 1}</kbd>
              {route.id === 'remote_review'
                ? 'Remote engineer'
                : route.id === 'field_review'
                  ? 'Field review'
                  : 'More details'}
            </Button>
          ))}
        </div>
        <p className="ag-small-note">Keys 1 / 2 / 3 while playing. Human handoffs make no AI call.</p>
      </div>
    </Card>
  );
}
