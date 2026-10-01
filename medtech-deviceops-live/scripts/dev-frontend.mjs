import { createServer } from 'vite';

const localOrigin = 'http://127.0.0.1:8766';
const server = await createServer({
  configFile: 'client/vite.config.ts',
  plugins: [
    {
      name: 'protect-authenticated-preview',
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url?.startsWith('/api') && request.headers.origin && request.headers.origin !== localOrigin) {
            response.statusCode = 403;
            response.end('Cross-origin access to the authenticated preview is not allowed.');
            return;
          }
          next();
        });
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 8766,
    strictPort: true,
    middlewareMode: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
        headers: { Origin: 'http://127.0.0.1:8765' },
      },
    },
  },
});
await server.listen();
server.printUrls();
process.on('SIGINT', () => void server.close().then(() => process.exit(0)));
process.on('SIGTERM', () => void server.close().then(() => process.exit(0)));
