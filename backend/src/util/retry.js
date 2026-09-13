const { logger } = require('../logger');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry(fn, options = {}) {
  const {
    attempts = 3,
    delays = [1000, 2000],
    label = 'operation',
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
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

      if (attempt < attempts) {
        await sleep(delays[attempt - 1] ?? delays[delays.length - 1] ?? 1000);
      }
    }
  }

  throw lastError;
}

module.exports = { retry };
