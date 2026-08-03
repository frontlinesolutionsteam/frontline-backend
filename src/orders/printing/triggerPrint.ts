import { cloverRequest } from "../../clover/client/httpClient";
import { logger } from "../../shared/logging/logger";

interface CloverPrinter {
  id: string;
  type: string;
}

interface CloverPrintersResponse {
  elements: CloverPrinter[];
}

// Printing is not automatic on order creation -- Clover requires this
// separate call, and it only works if the merchant has an actual configured,
// connected order printer. This is the single riskiest part of the whole
// integration per the architecture doc and must be validated physically in a
// pilot restaurant; sandbox printers are configuration stubs with no live
// device behind them; a failure here should never fail the surrounding order.
export async function triggerPrint(
  merchantId: string,
  cloverMerchantId: string,
  cloverOrderId: string,
): Promise<{ success: boolean; reason?: string }> {
  try {
    const printers = await cloverRequest<CloverPrintersResponse>(
      merchantId,
      cloverMerchantId,
      "/printers",
    );
    if (printers.elements.length === 0) {
      return { success: false, reason: "no printers configured for merchant" };
    }

    await cloverRequest(merchantId, cloverMerchantId, "/print_event", {
      method: "POST",
      body: {
        printers: printers.elements.map((p) => ({ id: p.id })),
        orderRef: { id: cloverOrderId },
      },
    });
    return { success: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error("Print trigger failed", { merchantId, cloverOrderId, reason });
    return { success: false, reason };
  }
}
