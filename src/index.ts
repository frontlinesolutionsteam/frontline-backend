import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import { buildAuthorizeUrl, exchangeCodeForToken } from "./clover/auth/oauth";
import { saveTokenPair, upsertMerchant } from "./clover/auth/tokenStore";
import { webhooksRouter } from "./clover/webhooks/router";
import { logger } from "./shared/logging/logger";

const app = express();
app.use(express.json());
app.use("/webhooks", webhooksRouter);

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
