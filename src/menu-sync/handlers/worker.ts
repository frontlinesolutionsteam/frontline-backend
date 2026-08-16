import "dotenv/config";
import {
  claimPendingWebhookEvents,
  markWebhookEventFailed,
  markWebhookEventProcessed,
} from "../../clover/webhooks/persist";
import { pool } from "../../db/pool";
import { cancelExpiredHostedCheckoutOrders } from "../../orders/order-gateway/hostedCheckoutOrder";
import { logger } from "../../shared/logging/logger";
import { closeAvailabilityCache } from "../cache/availabilityCache";
import { processWebhookEvent } from "./processEvent";

const POLL_INTERVAL_MS = 2000;
const BATCH_SIZE = 10;
// Pay-by-link timeout backstop, piggybacked on this already-running
// persistent process rather than provisioning a whole separate Railway
// service for one periodic check -- a lesson from earlier this project:
// every service sharing this source needs its own deploy, and a job this
// small doesn't justify another one to remember to redeploy.
const TIMEOUT_CHECK_INTERVAL_MS = 60 * 1000;
let stopping = false;
let lastTimeoutCheck = 0;

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

  if (Date.now() - lastTimeoutCheck >= TIMEOUT_CHECK_INTERVAL_MS) {
    lastTimeoutCheck = Date.now();
    try {
      await cancelExpiredHostedCheckoutOrders();
    } catch (err) {
      logger.error("Pay-by-link timeout check failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

async function run(): Promise<void> {
  logger.info("Webhook worker started, polling webhook_events + pay-by-link timeouts");
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
