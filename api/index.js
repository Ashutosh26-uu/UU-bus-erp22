/*
 * Vercel serverless entry. Every non-static request is rewritten here (see vercel.json) and handled
 * by the same Express app that `npm start` runs locally.
 */
import app from '../src/app.js';

export default app;
