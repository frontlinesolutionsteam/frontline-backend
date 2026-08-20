import { Router } from "express";
import { getMerchantById } from "../clover/auth/tokenStore";
import { normalizePhoneE164 } from "../customers/matching/normalizePhone";
import { HostedCheckoutInProgressError, initiateHostedCheckoutOrder } from "../orders/order-gateway/hostedCheckoutOrder";
import { getOrderStatus } from "../orders/order-gateway/repository";
import { previewCart } from "../orders/order-gateway/previewCart";
import type { CheckoutLineItemInput } from "../orders/order-gateway/resolveCartLines";
import { submitOrder } from "../orders/order-gateway/submitOrder";
import { PaymentAlreadyAttemptedError, PaymentDeclinedError, submitPaidOrder } from "../orders/order-gateway/submitPaidOrder";
import { getPublicMenu, getUsualItem } from "./repository";

export const websiteApiRouter = Router();

websiteApiRouter.get("/merchants/:merchantId/menu", async (req, res) => {
  const categories = await getPublicMenu(req.params.merchantId);
  res.json(categories);
});

// Caller-recognition support (AI phone first; website is a future consumer of
// the same data). Always 200s with itemId: null rather than 404ing on
// "nothing to report" -- an unrecognized/first-time number is a normal,
// expected response, not an error.
websiteApiRouter.get("/merchants/:merchantId/customers/:phone/usual-item", async (req, res) => {
  const phoneE164 = normalizePhoneE164(req.params.phone);
  if (!phoneE164) {
    res.status(400).json({ error: "Invalid phone number" });
    return;
  }
  const result = await getUsualItem(req.params.merchantId, phoneE164);
  res.json({ itemId: result?.itemId ?? null });
});

// Read-only, tax-aware total for the pre-checkout cart page. No order is
// created and nothing is written -- safe to call on every cart edit.
websiteApiRouter.post("/merchants/:merchantId/cart/preview", async (req, res) => {
  const merchantId = req.params.merchantId;
  const body = req.body as { items?: CheckoutLineItemInput[] };

  const merchant = await getMerchantById(merchantId);
  if (!merchant) {
    res.status(404).json({ error: "Unknown merchant" });
    return;
  }
  if (!body.items?.length) {
    res.status(400).json({ error: "items must be a non-empty array" });
    return;
  }

  try {
    const result = await previewCart(merchantId, merchant.cloverMerchantId, body.items);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

interface CheckoutBody {
  items?: CheckoutLineItemInput[];
  customer?: { phone?: string; firstName?: string; lastName?: string; email?: string };
  requestedTime?: string;
  note?: string;
  source?: "website" | "ai_phone" | "kiosk";
  // GAP-4: required, caller-generated, stable across retries of one checkout
  // attempt. See submitOrder.ts / mapCartToCloverOrder.ts GAP-4.
  idempotencyKey?: string;
  // Single-use clv_... token from the storefront's Clover iframe. Required
  // for website checkout (this is how the customer pays); never used for
  // ai_phone -- voice card capture is a separate, out-of-scope problem, so
  // AI phone orders keep going through the unpaid/pay-at-pickup path below.
  sourceToken?: string;
}

websiteApiRouter.post("/merchants/:merchantId/orders", async (req, res) => {
  const merchantId = req.params.merchantId;
  const body = req.body as CheckoutBody;

  const merchant = await getMerchantById(merchantId);
  if (!merchant) {
    res.status(404).json({ error: "Unknown merchant" });
    return;
  }

  if (!body.items?.length) {
    res.status(400).json({ error: "items must be a non-empty array" });
    return;
  }
  if (!body.customer?.phone) {
    res.status(400).json({ error: "customer.phone is required" });
    return;
  }
  if (!body.idempotencyKey) {
    res.status(400).json({ error: "idempotencyKey is required" });
    return;
  }

  const customer = {
    phone: body.customer.phone,
    firstName: body.customer.firstName,
    lastName: body.customer.lastName,
    email: body.customer.email,
  };

  // ai_phone never carries a card token (voice card capture is out of
  // scope); kiosk may or may not, depending on whether the tablet is
  // collecting payment itself -- source alone doesn't decide paid vs unpaid
  // for kiosk the way it does for the other two.
  if (body.source === "ai_phone" || (body.source === "kiosk" && !body.sourceToken)) {
    try {
      const result = await submitOrder({
        merchantId,
        cloverMerchantId: merchant.cloverMerchantId,
        items: body.items,
        customer,
        source: body.source,
        requestedTime: body.requestedTime,
        note: body.note,
        idempotencyKey: body.idempotencyKey,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (!body.sourceToken) {
    res.status(400).json({ error: "sourceToken is required" });
    return;
  }

  try {
    const result = await submitPaidOrder({
      merchantId,
      cloverMerchantId: merchant.cloverMerchantId,
      items: body.items,
      customer,
      source: body.source === "kiosk" ? "kiosk" : "website",
      requestedTime: body.requestedTime,
      note: body.note,
      idempotencyKey: body.idempotencyKey,
      sourceToken: body.sourceToken,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof PaymentDeclinedError) {
      res.status(402).json({ error: err.message, declined: true, declineCode: err.declineCode });
      return;
    }
    if (err instanceof PaymentAlreadyAttemptedError) {
      res.status(409).json({ error: err.message });
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

interface PayByLinkBody {
  items?: CheckoutLineItemInput[];
  customer?: { phone?: string; firstName?: string; lastName?: string; email?: string };
  requestedTime?: string;
  note?: string;
  idempotencyKey?: string;
}

// Pay-by-link initiation -- AI-phone orders now go through this instead of
// POST /orders' immediate ai_phone path (that path is left in place, not
// deleted, in case it's ever needed again; Maya's finalize flow is what
// changed, not this backend's capabilities). No kitchen ticket is created
// here at all -- see hostedCheckoutOrder.ts for the full sequencing.
websiteApiRouter.post("/merchants/:merchantId/orders/pay-by-link", async (req, res) => {
  const merchantId = req.params.merchantId;
  const body = req.body as PayByLinkBody;

  const merchant = await getMerchantById(merchantId);
  if (!merchant) {
    res.status(404).json({ error: "Unknown merchant" });
    return;
  }
  if (!body.items?.length) {
    res.status(400).json({ error: "items must be a non-empty array" });
    return;
  }
  if (!body.customer?.phone) {
    res.status(400).json({ error: "customer.phone is required" });
    return;
  }
  if (!body.idempotencyKey) {
    res.status(400).json({ error: "idempotencyKey is required" });
    return;
  }

  try {
    const result = await initiateHostedCheckoutOrder({
      merchantId,
      cloverMerchantId: merchant.cloverMerchantId,
      items: body.items,
      customer: {
        phone: body.customer.phone,
        firstName: body.customer.firstName,
        lastName: body.customer.lastName,
        email: body.customer.email,
      },
      requestedTime: body.requestedTime,
      note: body.note,
      idempotencyKey: body.idempotencyKey,
      source: "ai_phone",
    });
    res.json(result);
  } catch (err) {
    if (err instanceof HostedCheckoutInProgressError) {
      res.status(409).json({ error: err.message });
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

websiteApiRouter.get("/orders/:orderId", async (req, res) => {
  const order = await getOrderStatus(req.params.orderId);
  if (!order) {
    res.status(404).json({ error: "Unknown order" });
    return;
  }
  res.json(order);
});
