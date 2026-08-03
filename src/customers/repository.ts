import { pool } from "../db/pool";
import { cloverRequest } from "../clover/client/httpClient";
import type { CloverCustomer, CloverCustomerSearchResult } from "../clover/types/customer";
import { normalizePhoneE164 } from "./matching/normalizePhone";

export interface LocalCustomer {
  id: string;
  merchantId: string;
  cloverCustomerId: string | null;
  phoneE164: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface CustomerInput {
  phone: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}

async function findLocalByPhone(merchantId: string, phoneE164: string): Promise<LocalCustomer | null> {
  const { rows } = await pool.query(
    `SELECT id, merchant_id, clover_customer_id, phone_e164, email, first_name, last_name
     FROM customers WHERE merchant_id = $1 AND phone_e164 = $2`,
    [merchantId, phoneE164],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    merchantId: row.merchant_id,
    cloverCustomerId: row.clover_customer_id,
    phoneE164: row.phone_e164,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
  };
}

async function insertLocalCustomer(
  merchantId: string,
  cloverCustomerId: string,
  input: CustomerInput & { phoneE164: string },
): Promise<LocalCustomer> {
  const { rows } = await pool.query(
    `INSERT INTO customers (merchant_id, clover_customer_id, phone_e164, email, first_name, last_name, marketing_opt_in)
     VALUES ($1, $2, $3, $4, $5, $6, false)
     RETURNING id, merchant_id, clover_customer_id, phone_e164, email, first_name, last_name`,
    [merchantId, cloverCustomerId, input.phoneE164, input.email ?? null, input.firstName ?? null, input.lastName ?? null],
  );
  const row = rows[0];
  return {
    id: row.id,
    merchantId: row.merchant_id,
    cloverCustomerId: row.clover_customer_id,
    phoneE164: row.phone_e164,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
  };
}

// Clover's Customer API has no dedup/merge on create, so every lookup must
// search by (normalized) phone before ever creating a new Customer record,
// both locally and on Clover. Frontline's own `customers` table is the
// source of truth going forward; Clover's copy is a write-through mirror.
export async function getOrCreateCustomer(
  merchantId: string,
  cloverMerchantId: string,
  input: CustomerInput,
): Promise<LocalCustomer> {
  const phoneE164 = normalizePhoneE164(input.phone);
  if (!phoneE164) {
    throw new Error(`Could not normalize phone number: ${input.phone}`);
  }

  const existing = await findLocalByPhone(merchantId, phoneE164);
  if (existing) return existing;

  const searchResult = await cloverRequest<CloverCustomerSearchResult>(
    merchantId,
    cloverMerchantId,
    "/customers",
    { query: { filter: `phoneNumber=${phoneE164}` } },
  );

  let cloverCustomer: CloverCustomer;
  if (searchResult.elements.length > 0) {
    cloverCustomer = searchResult.elements[0];
  } else {
    cloverCustomer = await cloverRequest<CloverCustomer>(merchantId, cloverMerchantId, "/customers", {
      method: "POST",
      body: {
        firstName: input.firstName,
        lastName: input.lastName,
        phoneNumbers: [{ phoneNumber: phoneE164 }],
        emailAddresses: input.email ? [{ emailAddress: input.email }] : undefined,
      },
    });
  }

  return insertLocalCustomer(merchantId, cloverCustomer.id, { ...input, phoneE164 });
}
