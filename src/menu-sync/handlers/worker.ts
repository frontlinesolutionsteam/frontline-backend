import "dotenv/config";
import {
  claimPendingWebhookEvents,
  markWebhookEventFailed,
  markWebhookEventProcessed,
} from "../../clover/webhooks/persist";
import { pool } from "../../db/pool";
import { logger } from "../../shared/logging/logger";
import { closeAvailabilityCache } from "../cache/availabilityCache";
import { processWebhookEvent } from "./processEvent";

const POLL_INTERVAL_MS = 2000;
const BATCH_SIZE = 10;
let stopping = false;

async function tick(): Promise<void> {
  const events = await claimPendingWebhookEvents(BATCH_SIZE);
  for (const event of events) {
    try {
      await processWebhookEvent(event);
      await markWebhookEventProcessed(event.id);
    } catch (err) {
      logger.error("Webhook event processing failed", {
        eventId: event.id,
        objectKind: event.objectKind,
        cloverObjectId: event.cloverObjectId,
        error: err instanceof Error ? err.message : String(err),
      });
      await markWebhookEventFailed(event.id);
    }
  }
}

async function run(): Promise<void> {
  logger.info("Webhook worker started, polling webhook_events");
  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      logger.error("Webhook worker tick failed", { error: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  await Promise.all([pool.end(), closeAvailabilityCache()]);
}

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

run();
