import { Semaphore } from "./semaphore";
import { TokenBucket } from "./tokenBucket";

// Clover's documented limits: 50 req/s app-wide, 16 req/s per token,
// 10 concurrent app-wide, 5 concurrent per token. Whichever is more
// restrictive applies, so every call must clear both layers.
const APP_RATE_PER_SECOND = 50;
const APP_MAX_CONCURRENT = 10;
const TOKEN_RATE_PER_SECOND = 16;
const TOKEN_MAX_CONCURRENT = 5;

class PerTokenLimiter {
  bucket = new TokenBucket(TOKEN_RATE_PER_SECOND);
  semaphore = new Semaphore(TOKEN_MAX_CONCURRENT);
}

export class CloverRateLimiter {
  private readonly appBucket = new TokenBucket(APP_RATE_PER_SECOND);
  private readonly appSemaphore = new Semaphore(APP_MAX_CONCURRENT);
  private readonly perToken = new Map<string, PerTokenLimiter>();

  private forMerchant(merchantId: string): PerTokenLimiter {
    let limiter = this.perToken.get(merchantId);
    if (!limiter) {
      limiter = new PerTokenLimiter();
      this.perToken.set(merchantId, limiter);
    }
    return limiter;
  }

  async run<T>(merchantId: string, fn: () => Promise<T>): Promise<T> {
    const merchantLimiter = this.forMerchant(merchantId);

    await Promise.all([this.appBucket.take(), merchantLimiter.bucket.take()]);

    const releaseApp = await this.appSemaphore.acquire();
    const releaseToken = await merchantLimiter.semaphore.acquire();
    try {
      return await fn();
    } finally {
      releaseToken();
      releaseApp();
    }
  }
}

// Every outbound Clover call funnels through one shared instance so the
// app-wide 50 req/s ceiling is enforced across all merchants combined.
export const cloverRateLimiter = new CloverRateLimiter();
