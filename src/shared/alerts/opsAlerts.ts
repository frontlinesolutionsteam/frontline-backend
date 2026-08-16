import { logger } from "../logging/logger";

// TS mirror of frontline-maya-clover's execution/delivery.py alert_sms()/
// alert_email() -- not literally shared code (this is a separate process/
// language with no bridge between them), but the same pattern: same Twilio/
// SendGrid credentials and same OPS_ALERT_PHONE/OPS_ALERT_EMAIL destinations
// (kept as identical env var names on purpose so both services can point at
// the same values), same "best-effort, no-op silently if unconfigured"
// shape, same raw-fetch-no-SDK style already used for every other outbound
// call in this codebase (see clover/ecommerce/*Client.ts).

export async function alertOpsSms(body: string): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const fromPhone = process.env.TWILIO_PHONE_NUMBER;
  const toPhone = process.env.OPS_ALERT_PHONE;
  if (!sid || !token || !fromPhone || !toPhone) {
    logger.warn("alertOpsSms skipped -- Twilio SMS creds or OPS_ALERT_PHONE not set");
    return;
  }
  try {
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: toPhone,
        From: fromPhone,
        Body: `⚠️ Frontline backend alert: ${body.slice(0, 1500)}`,
      }),
    });
    if (!response.ok) {
      logger.error("alertOpsSms failed", { status: response.status, text: await response.text().catch(() => "") });
    }
  } catch (err) {
    logger.error("alertOpsSms failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function alertOpsEmail(subject: string, body: string): Promise<void> {
  const apiKey = process.env.SENDGRID_API_KEY;
  const toEmail = process.env.OPS_ALERT_EMAIL;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL ?? toEmail;
  if (!apiKey || !toEmail) {
    logger.warn("alertOpsEmail skipped -- SENDGRID_API_KEY or OPS_ALERT_EMAIL not set");
    return;
  }
  try {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: toEmail }] }],
        from: { email: fromEmail },
        subject: `⚠️ Frontline backend alert: ${subject}`,
        content: [{ type: "text/plain", value: body.slice(0, 3000) }],
      }),
    });
    if (!response.ok) {
      logger.error("alertOpsEmail failed", { status: response.status, text: await response.text().catch(() => "") });
    }
  } catch (err) {
    logger.error("alertOpsEmail failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function alertOps(subject: string, body: string): Promise<void> {
  await Promise.all([alertOpsSms(body), alertOpsEmail(subject, body)]);
}

// Arbitrary-destination customer SMS -- distinct from alertOpsSms (fixed
// destination, OPS_ALERT_PHONE). Same Twilio account/credentials, same
// raw-fetch pattern. Used by the pay-by-link timeout job to notify a
// customer directly; Maya sends the *initial* payment-link text herself
// (reusing execution/payments.py's existing send_payment_sms) since that
// happens live, on the call -- this one fires minutes later from a
// background job with no call or Maya process involved at all.
export async function sendCustomerSms(toPhoneE164: string, body: string): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const fromPhone = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !fromPhone) {
    logger.warn("sendCustomerSms skipped -- Twilio creds not set");
    return false;
  }
  try {
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: toPhoneE164, From: fromPhone, Body: body }),
    });
    if (!response.ok) {
      logger.error("sendCustomerSms failed", { status: response.status, text: await response.text().catch(() => "") });
      return false;
    }
    return true;
  } catch (err) {
    logger.error("sendCustomerSms failed", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
