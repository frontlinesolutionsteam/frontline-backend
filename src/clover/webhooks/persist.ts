import { pool } from "../../db/pool";
import type { RawWebhookEvent, WebhookEventType } from "./types";
import { parseObjectId } from "./types";

// webhook_events doubles as our durable queue: the ingest endpoint inserts
// rows and returns fast, a separate worker polls for status='pending' and
// processes them. Keeps Phase 1 infra-light (no SQS) while still decoupling
// processing from Clover's delivery timing/retries, per the doc's design.
export async function enqueueWebhookEvent(merchantId: string, event: RawWebhookEvent): Promise<void> {
  const { kind, cloverId } = parseObjectId(event.objectId);
  await pool.query(
    `INSERT INTO webhook_events (merchant_id, clover_object_id, event_type, object_kind, received_at, status)
     VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), 'pending')`,
    [merchantId, cloverId, event.type, kind, event.ts],
  );
}

export interface PendingWebhookEvent {
  id: string;
  merchantId: string;
  cloverObjectId: string;
  eventType: WebhookEventType;
  objectKind: string;
}

export async function claimPendingWebhookEvents(limit: number): Promise<PendingWebhookEvent[]> {
  // SKIP LOCKED lets multiple worker instances run concurrently later
  // without double-processing the same event.
  const { rows } = await pool.query(
    `UPDATE webhook_events
     SET status = 'processing'
     WHERE id IN (
       SELECT id FROM webhook_events
       WHERE status = 'pending'
       ORDER BY received_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, merchant_id, clover_object_id, event_type, object_kind`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    merchantId: r.merchant_id,
    cloverObjectId: r.clover_object_id,
    eventType: r.event_type,
    objectKind: r.object_kind,
  }));
}

export async function markWebhookEventProcessed(id: string): Promise<void> {
  await pool.query(`UPDATE webhook_events SET status = 'processed', processed_at = now() WHERE id = $1`, [id]);
}

export async function markWebhookEventFailed(id: string): Promise<void> {
  await pool.query(`UPDATE webhook_events SET status = 'failed', processed_at = now() WHERE id = $1`, [id]);
}
