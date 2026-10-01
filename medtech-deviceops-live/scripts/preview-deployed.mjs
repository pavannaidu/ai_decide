import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';

const profile = process.env.DATABRICKS_CONFIG_PROFILE ?? 'FEVM';
const appName = process.env.DEVICEOPS_APP_NAME ?? 'medtech-deviceops-live';
const app = JSON.parse(
  execFileSync('databricks', ['apps', 'get', appName, '--profile', profile, '-o', 'json'], { encoding: 'utf8' })
);
const upstream = new URL(app.url);
if (upstream.protocol !== 'https:' || !upstream.hostname.endsWith('.databricksapps.com')) {
  throw new Error('The selected app did not return a trusted Databricks Apps URL.');
}
const port = 8765;
const localOrigin = `http://127.0.0.1:${port}`;
let cachedToken;
let tokenTime = 0;

function bearer() {
  if (!cachedToken || Date.now() - tokenTime > 40 * 60 * 1000) {
    const credential = JSON.parse(
      execFileSync('databricks', ['auth', 'token', '--profile', profile], { encoding: 'utf8' })
    );
    if (!credential.access_token) throw new Error('The selected CLI profile has no OAuth token.');
    cachedToken = credential.access_token;
    tokenTime = Date.now();
  }
  return cachedToken;
}

const server = createServer((request, response) => {
  void (async () => {
    if (request.headers.origin && request.headers.origin !== localOrigin) {
      response.writeHead(403).end('Cross-origin access is not allowed.');
      return;
    }
    const relative = new URL(request.url ?? '/', localOrigin);
    const target = new URL(relative.pathname + relative.search, upstream);
    if (target.origin !== upstream.origin || relative.pathname.startsWith('/.auth/')) {
      response.writeHead(400).end('Only app content is proxied.');
      return;
    }
    const headers = new Headers({ Authorization: `Bearer ${bearer()}` });
    for (const key of ['accept', 'content-type']) {
      const value = request.headers[key];
      if (typeof value === 'string') headers.set(key, value);
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 100_000) throw new Error('Preview request body exceeds its limit.');
      chunks.push(chunk);
    }
    const result = await fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method ?? 'GET') ? undefined : Buffer.concat(chunks),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    if (result.status >= 300 && result.status < 400) {
      response.writeHead(502).end('The deployed app rejected CLI authentication; sign in or refresh the CLI profile.');
      return;
    }
    result.headers.forEach((value, key) => {
      if (!['content-encoding', 'content-length', 'set-cookie', 'connection', 'transfer-encoding'].includes(key))
        response.setHeader(key, value);
    });
    response.writeHead(result.status);
    if (result.body) Readable.fromWeb(result.body).pipe(response);
    else response.end();
  })().catch(() => {
    if (!response.headersSent) response.writeHead(502);
    response.end('Authenticated developer preview could not reach the deployed app.');
  });
});

server.listen(port, '127.0.0.1', () =>
  console.log(
    `Authenticated deployed-app preview: ${localOrigin}\nCredentials stay server-side. Serving ${appName}; no mocked API or local database.`
  )
);
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
