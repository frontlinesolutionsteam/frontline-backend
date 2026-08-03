import { cloverConfig } from "../config";
import { getValidToken } from "../auth/getValidToken";
import { cloverRateLimiter } from "../../shared/rate-limiter/cloverRateLimiter";

const MAX_RETRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CloverRequestOptions {
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

// All outbound Clover REST calls should go through this function so they
// share the app-wide rate limiter and token refresh logic.
export async function cloverRequest<T>(
  merchantId: string,
  cloverMerchantId: string,
  path: string,
  options: CloverRequestOptions = {},
): Promise<T> {
  const url = new URL(`/v3/merchants/${cloverMerchantId}${path}`, `https://${cloverConfig.apiHost}`);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const accessToken = await getValidToken(merchantId);

    const response = await cloverRateLimiter.run(merchantId, () =>
      fetch(url, {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      }),
    );

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get("retry-after");
      const backoffMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : (2 ** attempt + Math.random()) * 1000;
      await sleep(backoffMs);
      continue;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Clover API ${options.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
    }

    return (await response.json()) as T;
  }

  throw new Error(`Clover API ${path} failed after ${MAX_RETRIES} retries (rate limited)`);
}
