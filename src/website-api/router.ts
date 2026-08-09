import { Router } from "express";
import { getMerchantById } from "../clover/auth/tokenStore";
import { getOrderStatus } from "../orders/order-gateway/repository";
import { previewCart } from "../orders/order-gateway/previewCart";
import type { CheckoutLineItemInput } from "../orders/order-gateway/resolveCartLines";
import { submitOrder } from "../orders/order-gateway/submitOrder";
import { getPublicMenu } from "./repository";

export const websiteApiRouter = Router();

websiteApiRouter.get("/merchants/:merchantId/menu", async (req, res) => {
  const categories = await getPublicMenu(req.params.merchantId);
  res.json(categories);
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
  source?: "website" | "ai_phone";
  // GAP-4: required, caller-generated, stable across retries of one checkout
  // attempt. See submitOrder.ts / mapCartToCloverOrder.ts GAP-4.
  idempotencyKey?: string;
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

  try {
    const result = await submitOrder({
      merchantId,
      cloverMerchantId: merchant.cloverMerchantId,
      items: body.items,
      customer: {
        phone: body.customer.phone,
        firstName: body.customer.firstName,
        lastName: body.customer.lastName,
        email: body.customer.email,
      },
      source: body.source === "ai_phone" ? "ai_phone" : "website",
      requestedTime: body.requestedTime,
      note: body.note,
      idempotencyKey: body.idempotencyKey,
    });
    res.json(result);
  } catch (err) {
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
