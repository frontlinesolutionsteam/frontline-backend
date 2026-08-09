-- Live inventory sync (Phase 3): stock quantity and low-stock threshold.
--
-- Distinct from the existing hidden/available booleans, which already gate
-- whether an item can be ordered at all. quantity/stock_alert_threshold are
-- purely informational (Clover's own "low stock" concept) -- an item can be
-- low on stock and still orderable, so these never affect the availability
-- checks in submitOrder.ts/resolveCartLines.ts. NULL means the merchant
-- doesn't track stock for this item at all (most items, in practice).
ALTER TABLE items ADD COLUMN quantity NUMERIC;
ALTER TABLE items ADD COLUMN stock_alert_threshold NUMERIC;
