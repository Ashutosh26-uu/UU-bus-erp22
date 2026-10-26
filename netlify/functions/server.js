/*
 * Netlify Functions entry. netlify.toml rewrites every non-static request here; the same Express
 * app that `npm start` runs locally handles it (via serverless-http).
 */
import serverless from 'serverless-http';

let handlerPromise = null;

export const handler = async (event, context) => {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      // tell the app where it runs before it reads its configuration
      process.env.HOSTING_PLATFORM ||= 'netlify';
      const { default: app } = await import('../../src/app.js');
      return serverless(app, { basePath: '/.netlify/functions/server' });
    })().catch((e) => { handlerPromise = null; throw e; });
  }
  return (await handlerPromise)(event, context);
};
