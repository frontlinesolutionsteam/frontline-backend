-- Merchant-generated Clover Platform API tokens.
--
-- These are the "simplest auth path" alternative to OAuth: the restaurant
-- generates a long-lived token in their own Clover Dashboard and hands it to
-- us, scoped to the permissions we need. Unlike OAuth tokens they do not
-- expire on a 30-minute clock and have no refresh token, so they get their own
-- table rather than being squeezed into `clover_tokens`.
--
-- Stored with the same AES-256-GCM envelope as OAuth tokens (auth/crypto.ts),
-- so TOKEN_ENCRYPTION_KEY is still required.
CREATE TABLE clover_api_tokens (
  merchant_id UUID PRIMARY KEY REFERENCES merchants(id),
  api_token_encrypted TEXT NOT NULL,
  -- Free-text reminder of which dashboard token this is, e.g.
  -- "Frontline online ordering (created 2026-08-04)". Never the token itself.
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Clover routes tickets by order type ("Online Order", "Pickup", ...). The ids
-- are per-merchant, so this cannot be a constant -- it is per-client config.
-- Nullable: orders still post without it, they just inherit the merchant's
-- default order type.
ALTER TABLE merchants ADD COLUMN clover_order_type_id TEXT;
