const { logger } = require('../logger');

// Races `promise` against a timer. Resolves to `fallback` (never rejects) if
// the timer wins or if `promise` rejects — callers get partial results instead
// of a thrown error either way. Extracted from routes/search.js so it can be
// unit-tested together with retry() (see test/unit/retryTimeoutBudget.test.js).
function withTimeout(promise, ms, fallback, label) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      logger.warn({ scraper: label, status: 'timeout', timeoutMs: ms }, 'scraper timed out');
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
