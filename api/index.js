/**
 * Serverless entry point (Vercel, and any platform that imports a handler).
 *
 * Vercel never runs `npm start`, so `app.listen()` in server/index.js is never
 * reached there. It looks for functions under `api/` instead and calls whatever
 * they default-export with (req, res) — which is exactly an Express app's
 * signature, so the same app serves both local and deployed traffic.
 *
 * `vercel.json` rewrites /api/*, /uploads/* and /catalog/images/* here; static
 * files under public/ are served straight from the CDN.
 */
export { default } from '../server/index.js';
