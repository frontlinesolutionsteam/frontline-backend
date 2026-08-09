/**
 * Store a pilot restaurant's Clover Platform API token, encrypted, against
 * their merchant row.
 *
 * The token is read from STDIN, never from argv, so it does not land in shell
 * history or `ps` output.
 *
 *   echo -n '<api-token>' | pnpm set-clover-credentials \
 *     --clover-merchant-id=YT39NHT366D21 \
 *     --label="Frontline online ordering" \
 *     [--order-type-id=ABC123]
 *
 * Re-running replaces the stored token (a rotated dashboard token just gets
 * pushed through the same command).
 */
import "dotenv/config";
import { saveApiToken, setOrderTypeId } from "../clover/auth/apiTokenStore";
import { getMerchantByCloverId, upsertMerchant } from "../clover/auth/tokenStore";
import { pool } from "../db/pool";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error("Pipe the API token in on stdin: echo -n '<token>' | pnpm set-clover-credentials ...");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main() {
  const cloverMerchantId = arg("clover-merchant-id");
  if (!cloverMerchantId) {
    throw new Error("--clover-merchant-id is required");
  }

  const apiToken = await readStdin();
  if (!apiToken) {
    throw new Error("No API token received on stdin");
  }

  const existing = await getMerchantByCloverId(cloverMerchantId);
  const merchant = existing ?? (await upsertMerchant(cloverMerchantId));

  await saveApiToken(merchant.id, apiToken, arg("label"));

  const orderTypeId = arg("order-type-id");
  if (orderTypeId) {
    await setOrderTypeId(merchant.id, orderTypeId);
  }

  console.log(`Stored Clover API token for merchant ${cloverMerchantId}`);
  console.log(`  frontline merchant id: ${merchant.id}`);
  console.log(`  token: ${apiToken.length} chars, encrypted at rest`);
  if (orderTypeId) console.log(`  order type id: ${orderTypeId}`);
  console.log(`\nThis merchant will now authenticate with the API token instead of OAuth.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
