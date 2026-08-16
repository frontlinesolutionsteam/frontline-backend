import type { Request } from "express";
import { Router } from "express";
import { getHostedCheckoutWebhookSecret, getMerchantByCloverId } from "../auth/tokenStore";
import { logger } from "../../shared/logging/logger";
import { completeHostedCheckoutOrder } from "../../orders/order-gateway/hostedCheckoutOrder";
import { enqueueWebhookEvent } from "./persist";
import { verifyCloverAuthHeader, verifyHostedCheckoutSignature } from "./verify";
import type { WebhookPayload } from "./types";

export const webhooksRouter = Router();

interface HostedCheckoutPaymentWebhook {
  type?: string;
  status?: "APPROVED" | "DECLINED";
  id?: string;
  merchantId?: string;
  data?: string; // checkout session id
  message?: string;
}

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
    // Never log header values or any part of the auth secret here, even
    // truncated -- this branch fires on attacker-controlled input as much as
    // on real misconfiguration, and logs are a durable sink an attacker
    // shouldn't be able to write chosen bytes into.
    logger.error("Webhook rejected: invalid or missing X-Clover-Auth header", {
      endpoint: req.path,
      headerPresent: req.header("X-Clover-Auth") !== undefined,
    });
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

// Hosted Checkout (pay-by-link) payment notifications -- a genuinely
// different webhook system from the core /clover route above: per-merchant
// signing secret (not the app-wide CLOVER_WEBHOOK_SECRET), HMAC-SHA256
// Clover-Signature header instead of a static X-Clover-Auth header, and a
// single event type ("PAYMENT") rather than the I/IC/IG/IM/O/etc. taxonomy.
// See verify.ts's verifyHostedCheckoutSignature for the exact scheme.
webhooksRouter.post("/clover-checkout", async (req, res) => {
  const payload = req.body as HostedCheckoutPaymentWebhook;
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

  if (!payload.merchantId) {
    res.sendStatus(400);
    return;
  }

  const secret = await getHostedCheckoutWebhookSecret(payload.merchantId);
  if (!verifyHostedCheckoutSignature(req.header("Clover-Signature"), rawBody, secret ?? undefined)) {
    logger.error("Hosted Checkout webhook rejected: invalid or missing Clover-Signature", {
      cloverMerchantId: payload.merchantId,
      headerPresent: req.header("Clover-Signature") !== undefined,
    });
    res.sendStatus(401);
    return;
  }

  // Ack fast, same principle as the core webhook route above -- Clover
  // publishes no delivery-retry SLA to lean on either way.
  res.sendStatus(200);

  if (payload.type !== "PAYMENT" || !payload.data) {
    logger.info("Ignoring Hosted Checkout webhook of unhandled shape", { type: payload.type });
    return;
  }

  if (payload.status !== "APPROVED") {
    // A decline doesn't cancel the pending order -- Hosted Checkout's own
    // page lets the customer retry with a different card within the same
    // 15-minute session, so this isn't necessarily terminal. Just log it;
    // the timeout backstop is what governs if no later attempt succeeds.
    logger.info("Hosted Checkout payment not approved", { checkoutSessionId: payload.data, status: payload.status });
    return;
  }

  try {
    await completeHostedCheckoutOrder(payload.data);
  } catch (err) {
    logger.error("Hosted Checkout payment webhook processing failed", {
      checkoutSessionId: payload.data,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
