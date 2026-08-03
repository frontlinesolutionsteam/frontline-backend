import { Router } from "express";
import { getMerchantByCloverId } from "../auth/tokenStore";
import { logger } from "../../shared/logging/logger";
import { enqueueWebhookEvent } from "./persist";
import { verifyCloverAuthHeader } from "./verify";
import type { WebhookPayload } from "./types";

export const webhooksRouter = Router();

webhooksRouter.post("/clover", async (req, res) => {
  const payload = req.body as WebhookPayload;

  // One-time setup handshake: Clover POSTs a verification code when the
  // webhook URL is first saved in the Developer Dashboard. No merchants
  // payload is present yet, and no auth header is sent — just acknowledge.
  if (payload.verificationCode && !payload.merchants) {
    logger.info("Clover webhook verification handshake received", {
      verificationCode: payload.verificationCode,
    });
    res.sendStatus(200);
    return;
  }

  if (!verifyCloverAuthHeader(req.header("X-Clover-Auth"))) {
    logger.error("Webhook rejected: invalid or missing X-Clover-Auth header");
    res.sendStatus(401);
    return;
  }

  // Ack fast, process async — Clover has no published retry/SLA guarantee,
  // so we don't want ingest latency (or a slow downstream fetch) to be what
  // determines whether Clover considers delivery successful.
  res.sendStatus(200);

  const merchants = payload.merchants ?? {};
  for (const [cloverMerchantId, events] of Object.entries(merchants)) {
    const merchant = await getMerchantByCloverId(cloverMerchantId);
    if (!merchant) {
      logger.error("Webhook event for unknown merchant, dropping", { cloverMerchantId });
      continue;
    }
    for (const event of events) {
      try {
        await enqueueWebhookEvent(merchant.id, event);
      } catch (err) {
        logger.error("Failed to enqueue webhook event", {
          cloverMerchantId,
          objectId: event.objectId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
});
