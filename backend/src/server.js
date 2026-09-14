require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { logger } = require('./logger');
const { getBrowser } = require('./browser');
const { validateAllowedOrigin } = require('./config/validateAllowedOrigin');
const { requireBearerToken } = require('./config/searchAuth');
const searchRoute = require('./routes/search');
const healthRoute = require('./routes/health');

const PORT = parseInt(process.env.PORT, 10) || 8787;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Fail fast in production instead of silently opening CORS to '*' — see
// .claude/CLAUDE.md audit point 3. Local dev is unaffected: NODE_ENV isn't
// 'production', so this is a no-op and ALLOWED_ORIGIN keeps defaulting to
// '*' below exactly as before.
try {
  validateAllowedOrigin({ nodeEnv: NODE_ENV, allowedOrigin: process.env.ALLOWED_ORIGIN });
} catch (err) {
  logger.error({ err: err.message }, 'failed to boot');
  process.exit(1);
}

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const app = express();
// Render (and most PaaS) terminate TLS behind a single reverse-proxy hop and
// set X-Forwarded-For. Without this, req.ip resolves to the proxy's own
// address for every request, so the per-IP rate limiter on /search
// (routes/search.js) would see all traffic as one client — either blocking
// everyone together after a handful of legitimate requests, or never
// isolating abusive clients at all. `1` = trust exactly one hop, the
// standard safe setting for a platform with one reverse proxy in front.
app.set('trust proxy', 1);
app.use(
  cors({
    origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',').map((s) => s.trim()),
  })
);
app.use(express.json());

// Optional Bearer-token auth (JP_SEARCH_SERVICE_TOKEN) for FlipRadar's
// integration — see config/searchAuth.js. Scoped to /search only so
// Render's own unauthenticated platform health check against /health
// keeps working regardless of whether a token is configured.
app.use('/search', requireBearerToken(process.env.JP_SEARCH_SERVICE_TOKEN || ''));

app.use(searchRoute);
app.use(healthRoute);

app.use((err, req, res, _next) => {
  logger.error({ err: err.message, path: req.path }, 'unhandled error');
  res.status(500).json({ error: 'Internal error' });
});

(async () => {
  try {
    await getBrowser();
    app.listen(PORT, () => {
      logger.info({ port: PORT, allowedOrigin: ALLOWED_ORIGIN }, 'EmThaoJP backend listening');
    });
  } catch (err) {
    logger.error({ err: err.message }, 'failed to boot');
    process.exit(1);
  }
})();
