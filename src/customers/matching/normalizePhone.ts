// Clover's customer phone search is exact-string match, not normalized, so every
// phone number must be written and searched in one consistent format. Assumes
// US/CA numbers for now (10 digits, or 11 with a leading 1).
export function normalizePhoneE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
