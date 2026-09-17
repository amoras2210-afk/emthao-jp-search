const { logger } = require('../logger');

// Races `promise` against a timer. Resolves to `fallback` (never rejects) if
// the timer wins or if `promise` rejects — callers get partial results instead
// of a thrown error either way. Extracted from routes/search.js so it can be
// unit-tested together with retry() (see test/unit/retryTimeoutBudget.test.js).
//
// `controller` (optional, 5th arg) is an AbortController scoped to this one
// source/request — see routes/search.js. When the timer wins, we also call
// controller.abort() so retry()/the scraper can stop the now-abandoned
// underlying work (a page.goto/waitForResponse that would otherwise keep a
// Chromium page open until ITS OWN internal timeout, regardless of what this
// function already returned to its caller — see mercari.js's 2026-09-17
// "zombie attempt" incident). Purely additive: omitting `controller` keeps
// this function's resolution behavior byte-for-byte identical to before.
function withTimeout(promise, ms, fallback, label, controller) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      logger.warn({ scraper: label, status: 'timeout', timeoutMs: ms }, 'scraper timed out');
      if (controller) {
        try {
          controller.abort();
        } catch (err) {
          logger.error({ scraper: label, error: err.message }, 'controller.abort() threw');
        }
      }
      resolve(fallback);
    }, ms);
    promise.then(
      (val) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(val);
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        logger.error({ scraper: label, error: err.message }, 'scraper threw');
        resolve(fallback);
      }
    );
  });
}

module.exports = { withTimeout };
