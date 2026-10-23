/**
 * Runs the Vercel function (api/index.js) behind a plain Node HTTP server, the way Vercel invokes it.
 * Use it to try serverless mode locally, e.g. against Turso:
 *   SERVERLESS=1 TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... SESSION_SECRET=... node scripts/serve-function.mjs
 * PORT defaults to 3001.
 */
import http from 'node:http';
import handler from '../api/index.js';

const port = Number(process.env.PORT) || 3001;
http.createServer((req, res) => handler(req, res)).listen(port, () => {
  console.log(`Serverless function emulation on http://localhost:${port} (SERVERLESS=${process.env.SERVERLESS || ''})`);
});
