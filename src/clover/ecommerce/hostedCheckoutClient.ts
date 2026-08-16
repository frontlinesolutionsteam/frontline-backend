import { resolveAccessToken } from "../auth/resolveAccessToken";
import { cloverConfig } from "../config";

export interface HostedCheckoutLineItem {
  name: string;
  price: number; // cents
  unitQty: number;
  note?: string;
}

export interface CreateHostedCheckoutSessionInput {
  merchantId: string; // our uuid, for token resolution
  cloverMerchantId: string;
  lineItems: HostedCheckoutLineItem[];
}

export interface HostedCheckoutSession {
  checkoutSessionId: string;
  href: string;
  createdTime: number;
  expirationTime: number;
}

interface CreateSessionResponseBody {
  checkoutSessionId?: string;
  href?: string;
  createdTime?: number;
  expirationTime?: number;
}

// POST /invoicingcheckoutservice/v1/checkouts -- lives on the Platform API
// host (apisandbox.dev.clover.com / api.clover.com), NOT the Ecommerce charge
// host payOrderClient.ts/chargeClient.ts use (confirmed empirically: the
// Ecommerce host 404s on this path). Otherwise a different API surface from
// both of those: merchant is identified by the X-Clover-Merchant-Id header,
// not a path segment, and line items here are ad-hoc name/price/qty strings,
// NOT references to real Clover item ids -- this session has no relationship
// to a Platform atomic order at all. See hostedCheckoutOrder.ts for how we
// create the real order and attach payment to it only after Clover confirms
// this session was paid.
//
// Sessions are Clover's own fixed 15-minute lifetime (confirmed against
// Clover's docs; not configurable via this request) -- our own timeout job
// uses a 17-minute window (15 + a 2-minute buffer) rather than trusting the
// session to self-expire in a way we'd observe.
export async function createHostedCheckoutSession(
  input: CreateHostedCheckoutSessionInput,
): Promise<HostedCheckoutSession> {
  const { accessToken } = await resolveAccessToken(input.merchantId, input.cloverMerchantId);
  const response = await fetch(`https://${cloverConfig.apiHost}/invoicingcheckoutservice/v1/checkouts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Clover-Merchant-Id": input.cloverMerchantId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      customer: {},
      shoppingCart: {
        lineItems: input.lineItems.map((li) => ({
          name: li.name,
          price: li.price,
          unitQty: li.unitQty,
          note: li.note,
        })),
      },
    }),
  });

  const body = (await response.json().catch(() => ({}))) as CreateSessionResponseBody;
  if (!response.ok || !body.checkoutSessionId || !body.href) {
    throw new Error(`Clover Hosted Checkout session creation failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return {
    checkoutSessionId: body.checkoutSessionId,
    href: body.href,
    createdTime: body.createdTime ?? Date.now(),
    expirationTime: body.expirationTime ?? Date.now() + 15 * 60 * 1000,
  };
}
