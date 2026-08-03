import { cloverRequest } from "./httpClient";
import type { CloverPage } from "../types/menu";

const PAGE_SIZE = 100; // Clover default; max allowed is 1000.

export async function fetchAllPages<T>(
  merchantId: string,
  cloverMerchantId: string,
  path: string,
  query: Record<string, string> = {},
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;

  for (;;) {
    const page = await cloverRequest<CloverPage<T>>(merchantId, cloverMerchantId, path, {
      query: { ...query, limit: PAGE_SIZE, offset },
    });
    const elements = page.elements ?? [];
    all.push(...elements);
    if (elements.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return all;
}
