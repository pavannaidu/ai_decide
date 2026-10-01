# Device Alert Dispatch

## Real workflow

GE HealthCare OnWatch monitors imaging equipment and generates automated technical alerts. A remote engineer investigates; an on-site visit follows when needed:
https://www.gehealthcare.com/en-us/services/digital-solutions/onwatch

GE also publishes an MRI cooling-airflow case: remote log review led to an on-site inspection that found a saturated air filter:
https://landing1.gehealthcare.com/Innovation-Talk-Landing.html

This is the manufacturer’s technical-service workflow, not patient-alarm triage. We do not claim that GE uses AI_DECIDE.

## Demo boundary

Fictional MR/CT devices, sites, alert text, service policy, deadlines, and points. The 60-second shift is a game, not a medical service-level agreement. AI_DECIDE routes an existing alert; it does not detect faults, diagnose a cause, dispatch a technician, repair equipment, or authorize continued device use.

## Interaction and design

Audience: a medtech manufacturer’s technical-support team. Primary task: route incoming technical alerts with short, mixed-context notes.

Compact, single-screen schematic: connected-device tiles and an incoming queue on the left; three handoff lanes and exact API evidence on the right. Use existing AppKit Button, Badge, Card, Alert, and Skeleton primitives with semantic CSS tokens. Countdown colors indicate only game time. JSON and past decisions are expandable; device evidence and the current alert stay visible.

Steady and alert-storm shifts demonstrate a feed that keeps moving while inference runs. A human can route an alert, or AI autopilot can repeatedly make one bounded choice. Scores evaluate only the synthetic routing rubric. Wrong and missed routes remain visible.

## Architecture

Deterministic synthetic feed → observed alert and policy → real AI_DECIDE REST call → simulated queue handoff.

The existing FEVM app and Lakebase connection stay unchanged. Add app-owned alert-game tables and a new immutable policy version in `deviceops_sim`; retain old lab runs and their replay endpoints. Lakebase saves game state and exact requests/responses. Human actions have no invented AI response.
