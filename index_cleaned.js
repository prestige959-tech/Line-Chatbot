// cleaned index.js (duplicates removed)

// ---- Simple concurrency limiter ----
let inFlight = 0;
const MAX_CONCURRENT = 4;
const queue = [];

async function withLimiter(fn) {
  if (inFlight >= MAX_CONCURRENT) {
    await new Promise(resolve => queue.push(resolve));
  }
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    if (queue.length > 0) {
      const next = queue.shift();
      next();
    }
  }
}

async function fetchOpenRouter(url, opts) {
  return withLimiter(() => fetch(url, opts));
}

// ... rest of your existing code here ...

// NOTE: the duplicate block that was originally at the bottom (~line 860)
// has been removed. Now only one concurrency limiter + fetchOpenRouter remain.