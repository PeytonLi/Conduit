import { z } from "zod";

/** Response of the Microsoft identity platform token endpoint. */
export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().int().positive(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export const graphProfileSchema = z.object({
  mail: z.string().nullish(),
  userPrincipalName: z.string().nullish(),
});

const graphLink = z.string().url();

export const deltaPageSchema = z.object({
  value: z.array(
    z.object({
      id: z.string().min(1),
      conversationId: z.string().nullish(),
      from: z
        .object({ emailAddress: z.object({ address: z.string().nullish() }).nullish() })
        .nullish(),
      "@removed": z.unknown().optional(),
    }),
  ),
  "@odata.nextLink": graphLink.optional(),
  "@odata.deltaLink": graphLink.optional(),
});
export type DeltaPage = z.infer<typeof deltaPageSchema>;

export const messageRefSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().nullish(),
});

export const messageListSchema = z.object({ value: z.array(messageRefSchema) });

/** Persisted (encrypted) Outlook credential. */
export const outlookCredentialSchema = z.object({
  provider: z.literal("outlook"),
  refreshToken: z.string().min(1),
});
export type OutlookCredential = z.infer<typeof outlookCredentialSchema>;

/** Query of the OAuth callback, before any value is trusted. */
export const outlookCallbackQuerySchema = z.object({
  state: z.string().min(1).max(4096),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().max(200).optional(),
});

/** Signed state payload. `p` binds the state to this provider. */
export const outlookStatePayloadSchema = z.object({
  o: z.string().uuid(),
  u: z.string().uuid(),
  n: z.string().min(1),
  r: z.string().min(1),
  p: z.literal("outlook"),
  exp: z.number().int(),
});
export type OutlookStatePayload = z.infer<typeof outlookStatePayloadSchema>;
