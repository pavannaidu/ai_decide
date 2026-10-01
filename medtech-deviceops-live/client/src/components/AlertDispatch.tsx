import { Badge, Button, Card, Tooltip, TooltipContent, TooltipTrigger } from '@databricks/appkit-ui/react';
import { Check, ClipboardList, Headphones, Info, MessageSquareMore, Minus } from 'lucide-react';
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
          <p className="ag-eyebrow">02 · Route</p>
          <h2>Choose a queue</h2>
        </div>
      </div>
      <div className="ag-route-options">
        {ALERT_ROUTES.map((route, index) => {
          const Icon = ROUTE_ICONS[route.id];
          const recent = snapshot.alerts
            .filter((alert) => alert.status === 'routed' && alert.route === route.id)
            .at(-1);
          return (
            <section key={route.id} className="ag-route-option" aria-label={`${route.label} handoff lane`}>
              <div className="ag-route-heading">
                <span className="ag-route-icon">
                  <Icon size={18} aria-hidden="true" />
                </span>
                <Badge variant="secondary">{snapshot.routeCounts[route.id]} routed</Badge>
              </div>
              <div className="ag-route-title">
                <h3>{route.label}</h3>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button className="ag-route-help" type="button" aria-label={`${route.label}: ${route.description}`}>
                      <Info size={14} aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="ag-route-tooltip" side="top" sideOffset={6}>
                    {route.description}
                  </TooltipContent>
                </Tooltip>
              </div>
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => onRoute(route.id)}
                aria-label={`Route oldest alert to ${route.label}, keyboard shortcut ${index + 1}`}
              >
                <kbd aria-hidden="true">{index + 1}</kbd>
                Route here
              </Button>
              <div className={`ag-last-route${recent?.result === 'mismatch' ? ' ag-last-route--mismatch' : ''}`}>
                {recent ? (
                  <>
                    {recent.result === 'match' ? (
                      <Check size={12} aria-hidden="true" />
                    ) : (
                      <Minus size={12} aria-hidden="true" />
                    )}
                    <span>
                      Last: <code>{recent.deviceId}</code> ·{' '}
                      {recent.result === 'match' ? 'Rubric match' : 'Rubric mismatch'}
                    </span>
                  </>
                ) : (
                  <span>No handoffs yet</span>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <div className="ag-human-caption">
        <span>{nextAlertId ? `Routing oldest alert: ${nextAlertId}` : 'Waiting for an alert'}</span>
        <span className="ag-small-note">Human route: buttons or keys 1 / 2 / 3</span>
      </div>
    </Card>
  );
}
