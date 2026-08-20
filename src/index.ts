import "dotenv/config";
import crypto from "node:crypto";
import cors from "cors";
import express from "express";
import { adminApiRouter, UPLOADS_DIR } from "./admin-api/router";
import { buildAuthorizeUrl, exchangeCodeForToken } from "./clover/auth/oauth";
import { saveTokenPair, upsertMerchant } from "./clover/auth/tokenStore";
import { webhooksRouter } from "./clover/webhooks/router";
import { logger } from "./shared/logging/logger";
import { websiteApiRouter } from "./website-api/router";

const app = express();
// Captures the untouched raw body onto req.rawBody for every request --
// needed by the Hosted Checkout webhook's HMAC verification (verify.ts),
// which must sign the exact bytes Clover sent, not a re-serialized copy of
// the parsed JSON. Harmless/unused for every other route.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }),
);
app.use("/webhooks", webhooksRouter);

// Admin UI is a separate Next.js app on its own origin/port in dev.
app.use("/admin", cors({ origin: process.env.ADMIN_APP_ORIGIN ?? "http://localhost:3001" }), adminApiRouter);
app.use("/uploads", express.static(UPLOADS_DIR));

// Storefront and kiosk are separate Next.js apps, each on its own origin/port
// in dev, sharing this same /website API surface.
const websiteAllowedOrigins = [
  process.env.STOREFRONT_APP_ORIGIN ?? "http://localhost:3002",
  process.env.KIOSK_APP_ORIGIN ?? "http://localhost:3003",
];
app.use("/website", cors({ origin: websiteAllowedOrigins }), websiteApiRouter);

// Short-lived, single-use OAuth state values, keyed by value, cleared once consumed.
const pendingStates = new Set<string>();

app.get("/", (_req, res) => {
  res.send('Frontline Solutions backend is running. Start OAuth at <a href="/clover/connect">/clover/connect</a>.');
});

app.get("/clover/connect", (_req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.add(state);
  res.redirect(buildAuthorizeUrl(state));
});

app.get("/clover/oauth/callback", async (req, res) => {
  const { code, merchant_id: cloverMerchantId, state } = req.query;

  if (typeof state !== "string" || !pendingStates.has(state)) {
    res.status(400).send("Invalid or expired OAuth state.");
    return;
  }
  pendingStates.delete(state);

  if (typeof code !== "string" || typeof cloverMerchantId !== "string") {
    res.status(400).send("Missing code or merchant_id in OAuth callback.");
    return;
  }

  try {
    const tokens = await exchangeCodeForToken(code);
    const merchant = await upsertMerchant(cloverMerchantId);
    await saveTokenPair(merchant.id, tokens);

    logger.info("Clover merchant connected", { merchantId: merchant.id, cloverMerchantId });
    res.send(
      `Connected to Clover merchant ${cloverMerchantId}. Frontline merchant id: ${merchant.id}. You can close this tab.`,
    );
  } catch (err) {
    logger.error("OAuth callback failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).send("OAuth exchange failed. Check server logs.");
  }
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  logger.info(`Frontline backend listening on http://localhost:${port}`);
});
