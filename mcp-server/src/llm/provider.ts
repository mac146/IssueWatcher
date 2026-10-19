import { logger } from "../logger.js";
import type { Issue } from "../poller/types.js";
import {
  QuotaExhaustedError,
  buildBatchPrompt,
  parseBatchResponse,
  sleep as realSleep,
  type RateLimiter,
  type Summarizer,
} from "./summarizer.js";

/** A raw LLM endpoint: send a prompt, get text back. Retries and parsing live above it. */
export type LlmProvider = {
  name: string;
  complete(prompt: string): Promise<string>;
};

/** HTTP 429 or equivalent; `retryAfterMs` is how long the provider asked us to wait. */
export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** Missing, invalid or unauthorised credentials; retrying will not help. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

const MAX_ATTEMPTS = 4;
/** Longer waits than this mean a quota window (hours), not a burst limit. */
const MAX_RETRY_WAIT_MS = 90_000;
const AUTH_BACKOFF_MS = 3_600_000;
/** Don't hold a failed provider out for longer than this; it is cheap to probe again. */
const MAX_SKIP_MS = 3_600_000;

/** Turns any provider into a `Summarizer`: prompt, rate limit, retry, parse. */
export class LlmSummarizer implements Summarizer {
  constructor(
    private readonly provider: LlmProvider,
    private readonly maxBodyChars: number,
    private readonly limiter: RateLimiter,
    private readonly sleep: (ms: number) => Promise<void> = realSleep,
  ) {}

  get name(): string {
    return this.provider.name;
  }

  async summarizeBatch(issues: Issue[]): Promise<Array<string | null>> {
    const prompt = buildBatchPrompt(issues, this.maxBodyChars);
    for (let attempt = 1; ; attempt++) {
      try {
        await this.limiter.acquire();
        return parseBatchResponse(await this.provider.complete(prompt), issues.length);
      } catch (err) {
        if (err instanceof AuthError) {
          throw new QuotaExhaustedError(`${this.name}: ${err.message}`, AUTH_BACKOFF_MS);
        }
        if (err instanceof RateLimitError) {
          if (err.retryAfterMs > MAX_RETRY_WAIT_MS) {
            throw new QuotaExhaustedError(
              `${this.name} quota exhausted; provider asks to retry in ~${Math.round(err.retryAfterMs / 60_000)} min`,
              err.retryAfterMs,
            );
          }
          if (attempt >= MAX_ATTEMPTS) throw err;
          await this.sleep(err.retryAfterMs);
          continue;
        }
        if (attempt >= MAX_ATTEMPTS) throw err;
        await this.sleep(1000 * 2 ** attempt);
      }
    }
  }
}

type ChainEntry = { name: string; summarizer: Summarizer; unavailableUntil: number };

/**
 * Tries providers in order. A provider that reports exhausted quota (or a bad
 * key) is skipped for a while, so the rest of the run does not keep hitting it.
 * Throws `QuotaExhaustedError` only when every provider is unavailable.
 */
export class FallbackSummarizer implements Summarizer {
  private readonly chain: ChainEntry[];

  constructor(
    providers: Array<{ name: string; summarizer: Summarizer }>,
    private readonly now: () => number = Date.now,
  ) {
    this.chain = providers.map((p) => ({ ...p, unavailableUntil: 0 }));
  }

  async summarizeBatch(issues: Issue[]): Promise<Array<string | null>> {
    let lastError: unknown;
    let sawOtherFailure = false;
    let soonestRetry = MAX_SKIP_MS;

    for (const entry of this.chain) {
      const waitMs = entry.unavailableUntil - this.now();
      if (waitMs > 0) {
        soonestRetry = Math.min(soonestRetry, waitMs);
        continue;
      }
      try {
        return await entry.summarizer.summarizeBatch(issues);
      } catch (err) {
        lastError = err;
        if (err instanceof QuotaExhaustedError) {
          const skip = Math.min(err.retryAfterMs, MAX_SKIP_MS);
          entry.unavailableUntil = this.now() + skip;
          soonestRetry = Math.min(soonestRetry, skip);
          logger.warn(`${err.message}; switching to the next provider`);
        } else {
          sawOtherFailure = true;
          logger.warn(`${entry.name} failed; trying the next provider`, err);
        }
      }
    }

    if (sawOtherFailure) throw lastError;
    throw new QuotaExhaustedError("All AI providers are unavailable", soonestRetry);
  }
}

/** Used when no AI provider is configured; callers fall back to plain excerpts. */
export const noSummarizer: Summarizer = {
  summarizeBatch: async (issues) => issues.map(() => null),
};
