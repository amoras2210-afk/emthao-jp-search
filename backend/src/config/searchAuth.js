'use strict';
// Optional Bearer-token auth for GET /search and DELETE /search/cache.
// FlipRadar's emthaoProvider.ts sends `Authorization: Bearer
// <JP_SEARCH_SERVICE_TOKEN>` on every request when the token is configured —
// see src/lib/marketplaces/japan/providers/emthaoProvider.ts's headers().
//
// /health is intentionally NOT gated by this: Render's own platform health
// check (render.yaml healthCheckPath: /health) hits it without any
// Authorization header, and gating it would make Render mark a correctly
// running service as unhealthy and cycle it. FlipRadar's
// fetchJapanSearchHealth() does send the token to /health too, but an extra
// header on an unprotected route is harmless.
//
// If JP_SEARCH_SERVICE_TOKEN isn't set, this is a no-op (mirrors
// services/jp-search's same optional-token convention) — local dev and the
// existing emthao-jp-search/frontend, which send no Authorization header at
// all, are unaffected either way.
function requireBearerToken(token) {
  return function bearerAuth(req, res, next) {
    if (!token) return next();
    const header = req.get('authorization') || '';
    if (header === `Bearer ${token}`) return next();
    res.status(401).json({ error: 'Unauthorized' });
  };
}

module.exports = { requireBearerToken };
