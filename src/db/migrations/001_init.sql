-- Frontline Solutions initial schema.
-- Frontline owns its own normalized copy of everything; Clover IDs are
-- foreign references, never the primary key of our world.

CREATE TABLE merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clover_merchant_id TEXT NOT NULL UNIQUE,
  business_name TEXT,
  timezone TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'connected', 'disconnected', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE clover_tokens (
  merchant_id UUID PRIMARY KEY REFERENCES merchants(id),
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  access_token_expires_at TIMESTAMPTZ NOT NULL,
  refresh_token_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  clover_category_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER,
  deleted_at TIMESTAMPTZ,
  UNIQUE (merchant_id, clover_category_id)
);

CREATE TABLE items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  clover_item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL DEFAULT 0,
  hidden BOOLEAN NOT NULL DEFAULT false,
  available BOOLEAN NOT NULL DEFAULT true,
  image_url TEXT,
  modified_at_clover TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, clover_item_id)
);

CREATE TABLE item_categories (
  item_id UUID NOT NULL REFERENCES items(id),
  category_id UUID NOT NULL REFERENCES categories(id),
  PRIMARY KEY (item_id, category_id)
);

CREATE TABLE modifier_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  clover_modifier_group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  min_required INTEGER,
  max_allowed INTEGER,
  UNIQUE (merchant_id, clover_modifier_group_id)
);

CREATE TABLE modifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  modifier_group_id UUID NOT NULL REFERENCES modifier_groups(id),
  clover_modifier_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  UNIQUE (modifier_group_id, clover_modifier_id)
);

CREATE TABLE item_modifier_groups (
  item_id UUID NOT NULL REFERENCES items(id),
  modifier_group_id UUID NOT NULL REFERENCES modifier_groups(id),
  PRIMARY KEY (item_id, modifier_group_id)
);

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  clover_customer_id TEXT,
  phone_e164 TEXT,
  email TEXT,
  first_name TEXT,
  last_name TEXT,
  marketing_opt_in BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_phone_e164 ON customers (merchant_id, phone_e164);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  clover_order_id TEXT,
  customer_id UUID REFERENCES customers(id),
  source TEXT NOT NULL CHECK (source IN ('website', 'ai_phone')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'confirmed_clover', 'printed', 'failed', 'canceled')),
  requested_time TEXT,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'refunded')),
  payment_method TEXT CHECK (payment_method IN ('iframe_web', 'hosted_checkout_sms', 'card_on_file')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  item_id UUID NOT NULL REFERENCES items(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  price_cents_at_order INTEGER NOT NULL
);

CREATE TABLE order_line_item_modifiers (
  order_line_item_id UUID NOT NULL REFERENCES order_line_items(id),
  modifier_id UUID NOT NULL REFERENCES modifiers(id),
  PRIMARY KEY (order_line_item_id, modifier_id)
);

CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  clover_object_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('CREATE', 'UPDATE', 'DELETE')),
  object_kind TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'
);
