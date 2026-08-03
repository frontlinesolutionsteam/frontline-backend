export type WebhookEventType = "CREATE" | "UPDATE" | "DELETE";

export interface RawWebhookEvent {
  objectId: string; // e.g. "I:ABC123" — kind-prefixed Clover object id
  type: WebhookEventType;
  ts: number;
}

export interface WebhookPayload {
  appId?: string;
  verificationCode?: string; // present only on the one-time setup handshake
  merchants?: Record<string, RawWebhookEvent[]>;
}

// objectId is "<kind>:<id>", e.g. "I:ABC123" -> kind "I", id "ABC123".
export function parseObjectId(objectId: string): { kind: string; cloverId: string } {
  const separatorIndex = objectId.indexOf(":");
  if (separatorIndex === -1) {
    return { kind: "", cloverId: objectId };
  }
  return {
    kind: objectId.slice(0, separatorIndex),
    cloverId: objectId.slice(separatorIndex + 1),
  };
}
