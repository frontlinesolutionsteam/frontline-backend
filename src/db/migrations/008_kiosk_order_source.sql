-- Adds "kiosk" as a valid orders.source value alongside the existing
-- 'website' | 'ai_phone'. Required for kiosk checkout (source: "kiosk" in
-- POST /merchants/:merchantId/orders) to insert successfully -- without this,
-- insertDraftOrder's INSERT INTO orders would fail the source CHECK
-- constraint from 001_init.sql on every kiosk order.
ALTER TABLE orders DROP CONSTRAINT orders_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_source_check CHECK (source IN ('website', 'ai_phone', 'kiosk'));
