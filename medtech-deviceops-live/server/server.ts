import { createApp, lakebase, server } from '@databricks/appkit';
import { initializeDatabase } from './database';
import { callAiDecide } from './ai-decide';
import { buildDecisionRequest } from './decisions';
import { HttpError } from './errors';
import { SOP } from './policy';
import { registerRoutes } from './routes';
import { registerAlertRoutes } from './alert-routes';
import { createState, snapshot } from './simulator';

createApp({
  plugins: [lakebase({ pool: { max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000 } }), server()],
  async onPluginsReady(appkit) {
    await initializeDatabase(appkit.lakebase.pool);
    appkit.server.extend((app) => {
      registerRoutes(app, appkit.lakebase.pool);
      registerAlertRoutes(app, appkit.lakebase.pool);
      app.post('/api/inference-check', async (_request, response) => {
        try {
          const result = await callAiDecide(buildDecisionRequest(snapshot(createState(42)), SOP));
          response.json(result);
        } catch (error) {
          response
            .status(error instanceof HttpError ? error.status : 500)
            .json({ error: error instanceof Error ? error.message : 'Inference check failed.' });
        }
      });
    });
  },
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'App startup failed.');
  process.exitCode = 1;
});
