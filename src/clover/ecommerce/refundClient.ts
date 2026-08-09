import { ecommerceConfig } from "./config";

export interface CloverRefund {
  id: string;
  charge: string;
  amount: number;
  status: string;
}

// POST /v1/refunds -- full refund of a charge created via POST /v1/charges
// (confirmed against Clover's docs: this endpoint "can be used only to
// refund charges created with /v1/charges", which is the only kind of charge
// this codebase creates). Omitting `amount` refunds the charge in full.
export async function createRefund(chargeId: string): Promise<CloverRefund> {
  const response = await fetch(`https://${ecommerceConfig.chargeHost}/v1/refunds`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ecommerceConfig.privateToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ charge: chargeId }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Clover refund failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body as CloverRefund;
}
