import { pool } from "../../db/pool";
import { decrypt, encrypt } from "./crypto";
import type { TokenPair } from "../types";

export interface MerchantRecord {
  id: string;
  cloverMerchantId: string;
  status: string;
}

export async function upsertMerchant(cloverMerchantId: string): Promise<MerchantRecord> {
  const { rows } = await pool.query(
    `INSERT INTO merchants (clover_merchant_id, status)
     VALUES ($1, 'connected')
     ON CONFLICT (clover_merchant_id)
     DO UPDATE SET status = 'connected'
     RETURNING id, clover_merchant_id, status`,
    [cloverMerchantId],
  );
  const row = rows[0];
  return { id: row.id, cloverMerchantId: row.clover_merchant_id, status: row.status };
}

export async function getMerchantById(merchantId: string): Promise<MerchantRecord | null> {
  const { rows } = await pool.query(
    `SELECT id, clover_merchant_id, status FROM merchants WHERE id = $1`,
    [merchantId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return { id: row.id, cloverMerchantId: row.clover_merchant_id, status: row.status };
}

export async function getMerchantByCloverId(cloverMerchantId: string): Promise<MerchantRecord | null> {
  const { rows } = await pool.query(
    `SELECT id, clover_merchant_id, status FROM merchants WHERE clover_merchant_id = $1`,
    [cloverMerchantId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return { id: row.id, cloverMerchantId: row.clover_merchant_id, status: row.status };
}

// Small, purpose-specific lookup (same style as getOrderTypeId) rather than
// folding onto MerchantRecord, which most call sites don't need.
export async function getHostedCheckoutWebhookSecret(cloverMerchantId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT hosted_checkout_webhook_secret FROM merchants WHERE clover_merchant_id = $1`,
    [cloverMerchantId],
  );
  return rows[0]?.hosted_checkout_webhook_secret ?? null;
}

export async function getConnectedMerchants(): Promise<MerchantRecord[]> {
  const { rows } = await pool.query(
    `SELECT id, clover_merchant_id, status FROM merchants WHERE status = 'connected'`,
  );
  return rows.map((row) => ({ id: row.id, cloverMerchantId: row.clover_merchant_id, status: row.status }));
}

export async function saveTokenPair(merchantId: string, tokens: TokenPair): Promise<void> {
  await pool.query(
    `INSERT INTO clover_tokens
       (merchant_id, access_token_encrypted, refresh_token_encrypted, access_token_expires_at, refresh_token_expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (merchant_id)
     DO UPDATE SET
       access_token_encrypted = EXCLUDED.access_token_encrypted,
       refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
       access_token_expires_at = EXCLUDED.access_token_expires_at,
       refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
       updated_at = now()`,
    [
      merchantId,
      encrypt(tokens.accessToken),
      encrypt(tokens.refreshToken),
      tokens.accessTokenExpiresAt,
      tokens.refreshTokenExpiresAt,
    ],
  );
}

export async function loadTokenPair(merchantId: string): Promise<TokenPair | null> {
  const { rows } = await pool.query(
    `SELECT access_token_encrypted, refresh_token_encrypted, access_token_expires_at, refresh_token_expires_at
     FROM clover_tokens WHERE merchant_id = $1`,
    [merchantId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    accessToken: decrypt(row.access_token_encrypted),
    refreshToken: decrypt(row.refresh_token_encrypted),
    accessTokenExpiresAt: row.access_token_expires_at,
    refreshTokenExpiresAt: row.refresh_token_expires_at,
  };
}
