import { pool } from "../../db/pool";
import { decrypt, encrypt } from "./crypto";

export interface MerchantApiToken {
  merchantId: string;
  apiToken: string;
  label: string | null;
}

// Merchant-generated Platform API tokens never appear in code or config files
// -- they are written once via `pnpm set-clover-credentials` and read back
// only through here.
export async function saveApiToken(merchantId: string, apiToken: string, label?: string): Promise<void> {
  await pool.query(
    `INSERT INTO clover_api_tokens (merchant_id, api_token_encrypted, label, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (merchant_id)
     DO UPDATE SET
       api_token_encrypted = EXCLUDED.api_token_encrypted,
       label = EXCLUDED.label,
       updated_at = now()`,
    [merchantId, encrypt(apiToken), label ?? null],
  );
}

export async function loadApiToken(merchantId: string): Promise<MerchantApiToken | null> {
  const { rows } = await pool.query(
    `SELECT merchant_id, api_token_encrypted, label FROM clover_api_tokens WHERE merchant_id = $1`,
    [merchantId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    merchantId: row.merchant_id,
    apiToken: decrypt(row.api_token_encrypted),
    label: row.label,
  };
}

export async function deleteApiToken(merchantId: string): Promise<void> {
  await pool.query(`DELETE FROM clover_api_tokens WHERE merchant_id = $1`, [merchantId]);
}

export async function setOrderTypeId(merchantId: string, cloverOrderTypeId: string | null): Promise<void> {
  await pool.query(`UPDATE merchants SET clover_order_type_id = $1 WHERE id = $2`, [
    cloverOrderTypeId,
    merchantId,
  ]);
}

export async function getOrderTypeId(merchantId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT clover_order_type_id FROM merchants WHERE id = $1`, [
    merchantId,
  ]);
  return rows[0]?.clover_order_type_id ?? null;
}
