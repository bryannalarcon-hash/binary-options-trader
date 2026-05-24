/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  /** Maximum number of attempts (including the first try). Default 3. */
  attempts?: number;
  /** Initial delay between retries in ms. Default 500. */
  initialDelayMs?: number;
  /** Multiplier applied to delay on each failure. Default 2. */
  backoffFactor?: number;
  /** Cap on a single delay in ms. Default 30 seconds. */
  maxDelayMs?: number;
  /** Predicate: return false to stop retrying on a given error. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Called before each retry (good for logging). */
  onRetry?: (err: unknown, attempt: number, nextDelayMs: number) => void;
}

/**
 * Run `fn` with exponential backoff. Throws the LAST error if every attempt fails.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    attempts = 3,
    initialDelayMs = 500,
    backoffFactor = 2,
    maxDelayMs = 30_000,
    shouldRetry = () => true,
    onRetry,
  } = opts;

  let lastErr: unknown;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !shouldRetry(err, attempt)) {
        throw err;
      }
      const wait = Math.min(delay, maxDelayMs);
      onRetry?.(err, attempt, wait);
      await sleep(wait);
      delay *= backoffFactor;
    }
  }
  // Unreachable — loop either returns or throws — but TS doesn't know that.
  throw lastErr;
}
