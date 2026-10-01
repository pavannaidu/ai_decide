# Development

See the [demo README](../README.md) for the story and walkthrough.

## Run locally

Use Node.js 22+, an authenticated Databricks CLI profile, and the existing Lakebase connection settings in `.env`.

```sh
npm ci
npm run dev
```

The app calls the real AI_DECIDE API and Lakebase. There is no mock fallback. Keep `.env` and tokens private.

## Build and deploy

The bundle targets the existing FEVM app and `medtech-deviceops` Lakebase project.

```sh
npm test
npm run typecheck
npm run lint
npm run build
databricks apps deploy --skip-validation --auto-approve --profile FEVM
```

For an authenticated local view of the deployed app, run `npm run preview:deployed` and open `http://127.0.0.1:8765`.

For local frontend changes without changing database permissions, keep that preview running and start `node scripts/dev-frontend.mjs`. Open `http://127.0.0.1:8766`; its API requests use the authenticated deployed backend.

`node scripts/check-alert-game.mjs` exercises real alert-game API calls and Lakebase persistence. It prints results, creates synthetic test shifts, and leaves them paused.

The app service principal owns the `deviceops_sim` schema. Preserve existing runs; changing the demo rules requires a new policy version. Alert-game tables and `SIM-ALERT-TRIAGE-1.0` are separate from the retained `SIM-SOP-2.0` lab simulation.
