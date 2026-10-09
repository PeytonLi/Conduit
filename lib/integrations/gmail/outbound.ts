import { z } from "zod";
import { createHash } from "node:crypto";
import type {
  ActionRecord,
  DispatchResult,
  ProviderAdapter,
} from "@/lib/actions/types";
import { classifyGmailError, type GmailApi } from "./api";
import { normalizeAddress } from "./mime";

const QUOTE_FIELDS = [
  "unit_price",
  "freight",
  "arrival_date",
  "quantity_available",
  "valid_until",
] as const;

export const supplierEmailPayloadSchema = z
  .object({
    template: z.enum(["quote_request", "delivery_confirmation"]),
    connection_id: z.string().uuid(),
    contact_id: z.string().uuid(),
    to: z.string().min(3),
    subject: z.string().min(1).max(200),
    thread: z
      .object({
        provider_thread_id: z.string(),
        in_reply_to: z.string(),
        references: z.array(z.string()),
      })
      .strict()
      .nullable(),
    facts: z
      .object({
        item_sku: z.string(),
        item_description: z.string(),
        specification: z.record(z.string(), z.union([z.string(), z.number()])),
        quantity: z.number().int().positive(),
        unit: z.string(),
        destination_name: z.string(),
        needed_by_local: z.string(),
        quote_fields: z.array(z.enum(QUOTE_FIELDS)),
      })
      .strict(),
    question: z.string().max(1000),
  })
  .strict();

export type SupplierEmailPayload = z.infer<typeof supplierEmailPayloadSchema>;

function stripHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function renderSupplierEmail(
  payload: SupplierEmailPayload,
  action: ActionRecord,
  { fromAddress, domain }: { fromAddress: string; domain: string },
): { mime: string; rfcMessageId: string; payloadHash: string } {
  const rfcMessageId = `<conduit.${action.id}@${stripHeader(domain)}>`;
  const subjectBase = stripHeader(payload.subject);
  const subject = payload.thread
    ? /^re:\s*/i.test(subjectBase)
      ? subjectBase
      : `Re: ${subjectBase}`
    : subjectBase;

  const lines: string[] = [];
  if (payload.template === "quote_request") {
    lines.push(
      `Hello,`,
      ``,
      `We are requesting a quote for the following item:`,
      ``,
      `Item: ${payload.facts.item_sku} — ${payload.facts.item_description}`,
      `Quantity: ${payload.facts.quantity} ${payload.facts.unit}`,
      `Destination: ${payload.facts.destination_name}`,
      `Needed by: ${payload.facts.needed_by_local}`,
    );
    const spec = Object.entries(payload.facts.specification)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");
    if (spec) lines.push(`Specification:`, spec);
    if (payload.facts.quote_fields.length > 0) {
      lines.push(`Please include: ${payload.facts.quote_fields.join(", ")}.`);
    }
  } else {
    lines.push(
      `Hello,`,
      ``,
      `Please confirm the current delivery status for ${payload.facts.item_sku} (${payload.facts.item_description}).`,
      `Open quantity: ${payload.facts.quantity} ${payload.facts.unit}`,
      `Destination: ${payload.facts.destination_name}`,
      `Promised for: ${payload.facts.needed_by_local}`,
    );
  }
  if (payload.question) lines.push(``, payload.question);
  lines.push(``, `Thank you,`, `Conduit`);

  const headers: string[] = [
    `From: ${stripHeader(fromAddress)}`,
    `To: ${stripHeader(payload.to)}`,
    `Subject: ${subject}`,
    `Message-ID: ${rfcMessageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
  ];
  if (payload.thread) {
    headers.push(`In-Reply-To: ${stripHeader(payload.thread.in_reply_to)}`);
    const refs = [
      ...payload.thread.references,
      payload.thread.in_reply_to,
    ]
      .map((r) => stripHeader(r))
      .join(" ");
    headers.push(`References: ${refs}`);
  }
  const mime = `${headers.join("\r\n")}\r\n\r\n${lines.join("\r\n")}`;
  const payloadHash = createHash("sha256").update(mime).digest("hex");
  return { mime, rfcMessageId, payloadHash };
}

export interface ContactRecord {
  normalized_address: string;
  outreach_approved_at: string | null;
  permitted_channels: string[];
  supplier_id: string;
}

export interface OutboundDeps {
  appEnv: "replay" | "sandbox" | "live";
  transportFor(action: ActionRecord): Promise<GmailApi | null> | GmailApi | null;
  loadContact(orgId: string, contactId: string): Promise<ContactRecord | null>;
  fromAddressFor(action: ActionRecord): Promise<string> | string;
  domain: string;
  replayTransport: GmailApi;
}

function failed(summary: string): DispatchResult {
  return { outcome: "failed", safeSummary: summary };
}

export function createSupplierEmailAdapter(deps: OutboundDeps): ProviderAdapter {
  return {
    kind: "supplier_email",
    async dispatch(action) {
      const parsed = supplierEmailPayloadSchema.safeParse(action.payload);
      if (!parsed.success) {
        return failed("supplier email payload failed validation");
      }
      const payload = parsed.data;

      const contact = await deps.loadContact(action.orgId, payload.contact_id);
      if (
        !contact ||
        contact.outreach_approved_at === null ||
        !contact.permitted_channels.includes("email")
      ) {
        return failed("recipient_not_approved");
      }
      if (normalizeAddress(payload.to) !== contact.normalized_address) {
        return failed("recipient_not_approved");
      }

      if (action.providerRef) {
        const result = await this.findResult(action);
        return {
          outcome: result.outcome === "confirmed" ? "confirmed" : result.outcome,
          providerRef: action.providerRef,
          safeSummary: result.safeSummary,
        };
      }

      const isReplay = action.mode === "replay" || deps.appEnv === "replay";
      const transport = isReplay
        ? deps.replayTransport
        : await deps.transportFor(action);
      if (!transport) {
        return failed("no gmail transport for connection");
      }

      const { mime, rfcMessageId } = renderSupplierEmail(payload, action, {
        fromAddress: await deps.fromAddressFor(action),
        domain: deps.domain,
      });
      void rfcMessageId;

      try {
        if (!isReplay) {
          const existing = await transport.findSentByRfcMessageId(rfcMessageId);
          if (existing) {
            return {
              outcome: "confirmed",
              providerRef: existing.id,
              safeSummary: "supplier email already sent (found in Sent)",
            };
          }
        }
        const sent = await transport.send({
          raw: mime,
          threadId: payload.thread?.provider_thread_id,
        });
        return {
          outcome: "submitted",
          providerRef: isReplay ? `replay:${action.id}` : sent.id,
          safeSummary: isReplay
            ? "supplier email dispatched in replay mode"
            : "supplier email sent",
        };
      } catch (err) {
        const kind = classifyGmailError(err);
        if (kind === "transient" || kind === "rate_limited") {
          return { outcome: "unknown", safeSummary: `send uncertain (${kind})` };
        }
        return failed(`send rejected (${kind})`);
      }
    },
    async findResult(action) {
      const parsed = supplierEmailPayloadSchema.safeParse(action.payload);
      if (!parsed.success || !action.providerRef) {
        return { outcome: "unknown", safeSummary: "no provider reference" };
      }
      const isReplay = action.mode === "replay" || deps.appEnv === "replay";
      const transport = isReplay
        ? deps.replayTransport
        : await deps.transportFor(action);
      if (!transport) {
        return { outcome: "unknown", safeSummary: "no gmail transport" };
      }
      try {
        const { rfcMessageId } = renderSupplierEmail(parsed.data, action, {
          fromAddress: await deps.fromAddressFor(action),
          domain: deps.domain,
        });
        const found = await transport.findSentByRfcMessageId(rfcMessageId);
        if (found) {
          return {
            outcome: "confirmed",
            providerRef: found.id,
            safeSummary: "supplier email confirmed in Sent",
          };
        }
        // Never report failed from absence of evidence.
        return { outcome: "unknown", safeSummary: "sent copy not found" };
      } catch {
        return { outcome: "unknown", safeSummary: "sent lookup failed" };
      }
    },
  };
}
