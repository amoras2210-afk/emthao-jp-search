const { logger } = require('../logger');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `options.signal` (optional) is an AbortController's signal scoped to this
// one call — see routes/search.js/withTimeout.js. It lets an external
// deadline (which already gave up and returned a fallback to ITS caller)
// stop this retry loop from launching a next attempt that nobody is waiting
// for anymore. Omitting `signal` keeps this function's behavior byte-for-byte
// identical to before (every `signal?.` check below is a no-op when
// `signal` is undefined).
async function retry(fn, options = {}) {
  const {
    attempts = 3,
    delays = [1000, 2000],
    label = 'operation',
    signal,
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) {
      throw lastError || new Error(`${label} aborted before attempt ${attempt}`);
    }

    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      logger.warn(
        {
          label,
          attempt,
          attempts,
          error: err.message,
        },
        'retryable operation failed'
      );

      // Checked again here (not just at the top of the next iteration)
      // because the abort can happen WHILE fn(attempt) was running — the
      // external deadline already gave up on this operation, so sleeping
      // and launching another attempt would just create another orphaned
      // Chromium page nobody is waiting for.
      if (attempt < attempts && !signal?.aborted) {
        await sleep(delays[attempt - 1] ?? delays[delays.length - 1] ?? 1000);
      }
    }
  }

  throw lastError;
}

module.exports = { retry };
