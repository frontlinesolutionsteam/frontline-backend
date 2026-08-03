import { createClient } from "redis";
import { logger } from "../../shared/logging/logger";

const redis = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
redis.on("error", (err) => logger.error("Redis client error", { error: err.message }));

let connecting: Promise<void> | null = null;
async function ensureConnected(): Promise<void> {
  if (redis.isOpen) return;
  connecting ??= redis.connect().then(() => undefined);
  await connecting;
}

export interface ItemAvailability {
  hidden: boolean;
  available: boolean;
}

function key(merchantId: string, cloverItemId: string): string {
  return `availability:${merchantId}:${cloverItemId}`;
}

// Called on every item upsert (webhook-driven or reconciliation) so the
// website and AI receptionist can check live availability without hitting
// Postgres or Clover directly. 86'd items need to propagate in seconds, not
// on the nightly reconciliation cycle.
export async function writeAvailability(
  merchantId: string,
  cloverItemId: string,
  state: ItemAvailability,
): Promise<void> {
  await ensureConnected();
  await redis.set(key(merchantId, cloverItemId), JSON.stringify(state));
}

export async function readAvailability(
  merchantId: string,
  cloverItemId: string,
): Promise<ItemAvailability | null> {
  await ensureConnected();
  const raw = await redis.get(key(merchantId, cloverItemId));
  return raw ? (JSON.parse(raw) as ItemAvailability) : null;
}

export async function deleteAvailability(merchantId: string, cloverItemId: string): Promise<void> {
  await ensureConnected();
  await redis.del(key(merchantId, cloverItemId));
}

export async function closeAvailabilityCache(): Promise<void> {
  if (redis.isOpen) await redis.quit();
}
