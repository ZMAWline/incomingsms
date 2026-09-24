// CORS for the dashboard's /api/* responses.
//
// The dashboard frontend is served from the same origin as its API, so the
// browser never needs CORS for it, and the agent API is called by non-browser
// clients that ignore CORS entirely. The only cross-origin browser caller we
// accept is another copy of this dashboard: PROD, TEST, or a per-version PR
// preview (`wrangler versions upload --env test` prints
// https://<hex>-dashboard-test.zalmen-531.workers.dev, see
// .github/workflows/dashboard-pr-preview.yml). wrangler.toml has no custom
// domain routes. Any other Origin gets no Access-Control-Allow-Origin header,
// so a foreign page cannot read API responses.

const ALLOWED_ORIGINS = new Set([
  'https://dashboard.zalmen-531.workers.dev',
  'https://dashboard-test.zalmen-531.workers.dev',
]);

const PREVIEW_ORIGIN = /^https:\/\/[0-9a-f]+(?:-[0-9a-f]+)*-dashboard-test\.zalmen-531\.workers\.dev$/;

export function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.has(origin) || PREVIEW_ORIGIN.test(origin);
}

export function corsHeadersFor(request) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
  const origin = request.headers.get('Origin');
  if (isAllowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}
