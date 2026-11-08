import { outlookCredentialSchema, type OutlookCredential } from "./schemas";

export type { OutlookCredential };

export function serializeOutlookCredential(credential: OutlookCredential): string {
  return JSON.stringify(outlookCredentialSchema.parse(credential));
}

/** Throws when the stored plaintext is not an Outlook credential. */
export function parseOutlookCredential(plaintext: string): OutlookCredential {
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    throw new Error("Stored Outlook credential is unreadable");
  }
  const parsed = outlookCredentialSchema.safeParse(value);
  if (!parsed.success) throw new Error("Stored credential is not an Outlook credential");
  return parsed.data;
}
