'use strict';
// Fails fast in production if ALLOWED_ORIGIN isn't configured, instead of
// silently falling back to CORS origin '*' (any site can call the API).
// Extracted as a pure function (throws, never calls process.exit itself) so
// server.js's actual boot-failure path can be tested without killing the
// test process. Local dev is unaffected — it keeps defaulting to '*' when
// ALLOWED_ORIGIN is unset, exactly as before.
function validateAllowedOrigin({ nodeEnv, allowedOrigin } = {}) {
  if (nodeEnv === 'production' && !allowedOrigin) {
    throw new Error(
      'Missing required environment variable ALLOWED_ORIGIN in production. ' +
        'Refusing to start with an insecure CORS fallback (origin: "*"). ' +
        'Set ALLOWED_ORIGIN to your frontend origin(s), comma-separated, before deploying.'
    );
  }
}

module.exports = { validateAllowedOrigin };
