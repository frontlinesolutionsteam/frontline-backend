import { createRefund } from "../../clover/ecommerce/refundClient";
import { getOrderByCloverOrderId, markOrderRefunded } from "./repository";

export interface RefundResult {
  refundId: string;
  orderId: string;
  cloverChargeId: string;
  amountCents: number;
}

// Full refund of an order that was paid through submitPaidOrder.ts, looked
// up by the Clover atomic order id (what's printed on the ticket / visible
// in the Clover dashboard's Orders view) rather than our internal uuid or
// the Ecommerce charge id, since that's what a staff member actually has in
// hand when they need to issue one. A staff action, not customer-facing --
// see scripts/refundOrder.ts for the CLI wrapper.
export async function refundOrderByCloverOrderId(cloverOrderId: string): Promise<RefundResult> {
  const order = await getOrderByCloverOrderId(cloverOrderId);
  if (!order) {
    throw new Error(`No order found with Clover order id ${cloverOrderId}`);
  }
  if (!order.cloverChargeId) {
    throw new Error(
      `Order ${order.id} (Clover ${cloverOrderId}) has no associated charge -- it was not paid through the online checkout flow`,
    );
  }
  if (order.paymentStatus === "refunded") {
    throw new Error(`Order ${order.id} (Clover ${cloverOrderId}) was already refunded`);
  }

  const refund = await createRefund(order.cloverChargeId);
  await markOrderRefunded(order.id);

  return {
    refundId: refund.id,
    orderId: order.id,
    cloverChargeId: order.cloverChargeId,
    amountCents: refund.amount,
  };
}
