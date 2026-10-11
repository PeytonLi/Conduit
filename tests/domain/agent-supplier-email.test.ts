import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "@/lib/agent/budgets";
import { createRequestSupplierEmailTool } from "@/lib/agent/tools/request-supplier-email";
import {
  createSupplierEmailAdapter,
  supplierEmailPayloadSchema,
} from "@/lib/integrations/gmail/outbound";
import { createReplayTransport } from "@/lib/integrations/gmail/replay";
import type { ActionRecord } from "@/lib/actions/types";
import {
  ASSESSMENT_A,
  BAY_CARTON,
  BAY_EMAIL_CONTACT,
  GMAIL_CONNECTION_A,
  ITEM_A,
  ctx,
  harborStore,
  clock,
  createFakePreparer,
} from "./planner-test-helpers";

type RequestInput = Parameters<
  ReturnType<typeof createRequestSupplierEmailTool>["run"]
>[1];

function request(overrides: Partial<RequestInput> = {}): RequestInput {
  return {
    contact_id: BAY_EMAIL_CONTACT,
    purpose: "availability_request",
    required_fields: ["quantity"],
    ...overrides,
  };
}

describe("request_supplier_email adapter contract", () => {
  it("prepares a strict Gmail payload with mapped facts and the organization timezone", async () => {
    const store = harborStore();
    const item = store.items.get(ITEM_A)!;
    item.specification.not_a_string_or_number = { value: 1 };
    item.specification.ignore_boolean = false;
    const preparer = createFakePreparer(store);
    const tool = createRequestSupplierEmailTool({ store, clock, preparer });

    const result = await tool.run(
      ctx,
      request({
        required_fields: [
          "quantity",
          "arrival",
          "freight",
          "split_delivery",
          "quote_validity",
          "order_cutoff",
          "written_confirmation",
        ],
      }),
    );

    expect(result.ok).toBe(true);
    const payload = supplierEmailPayloadSchema.parse(preparer.calls[0].payload);
    expect(payload).toMatchObject({
      template: "quote_request",
      connection_id: GMAIL_CONNECTION_A,
      contact_id: BAY_EMAIL_CONTACT,
      to: "sales@baycarton.example.com",
      subject:
        "Availability request: Kraft single-wall shipping carton (CARTON-302015)",
      thread: null,
      supplier_id: BAY_CARTON,
      episode: 1,
      purpose: "availability_request",
      facts: {
        item_sku: "CARTON-302015",
        item_description: "Kraft single-wall shipping carton",
        specification: {
          length_mm: 300,
          width_mm: 200,
          height_mm: 150,
          material_grade: "KRAFT-SW-DEMO",
        },
        quantity: 600,
        unit: "carton",
        destination_name: "Main Warehouse",
        needed_by_local: "Wed, Oct 14, 2026, 11:00 AM CDT",
        quote_fields: [
          "unit_price",
          "quantity_available",
          "arrival_date",
          "freight",
          "valid_until",
        ],
      },
      question:
        "Please also confirm: whether a split delivery is possible; the latest order cutoff for that arrival; written confirmation of the delivery date.",
    });
    expect(payload.facts.specification).not.toHaveProperty(
      "not_a_string_or_number",
    );
    expect(payload.facts.specification).not.toHaveProperty("ignore_boolean");
  });

  it("uses the delivery-confirmation template and truncates its subject", async () => {
    const store = harborStore();
    store.items.get(ITEM_A)!.description = "x".repeat(250);
    const preparer = createFakePreparer(store);
    const tool = createRequestSupplierEmailTool({ store, clock, preparer });

    const result = await tool.run(
      ctx,
      request({
        purpose: "written_confirmation",
        required_fields: ["written_confirmation"],
      }),
    );

    expect(result.ok).toBe(true);
    const payload = supplierEmailPayloadSchema.parse(preparer.calls[0].payload);
    expect(payload.template).toBe("delivery_confirmation");
    expect(payload.purpose).toBe("written_confirmation");
    expect(payload.subject).toHaveLength(200);
    expect(payload.subject).toMatch(/^Delivery confirmation: /);
    expect(payload.facts.quote_fields).toEqual([]);
    expect(payload.question).toBe(
      "Please also confirm: written confirmation of the delivery date.",
    );
  });

  it("deduplicates quote fields and always requests unit_price for quotes", async () => {
    const store = harborStore();
    const preparer = createFakePreparer(store);
    const tool = createRequestSupplierEmailTool({ store, clock, preparer });

    const result = await tool.run(
      ctx,
      request({ required_fields: ["quantity", "quantity", "freight"] }),
    );

    expect(result.ok).toBe(true);
    const payload = supplierEmailPayloadSchema.parse(preparer.calls[0].payload);
    expect(payload.facts.quote_fields).toEqual([
      "unit_price",
      "quantity_available",
      "freight",
    ]);
  });

  it("does not prepare when no usable Gmail connection exists", async () => {
    const store = harborStore();
    store.gmailConnections = [
      {
        id: GMAIL_CONNECTION_A,
        org_id: ctx.orgId,
        provider: "gmail",
        status: "expired",
      },
    ];
    const preparer = createFakePreparer(store);
    const tool = createRequestSupplierEmailTool({ store, clock, preparer });

    const result = await tool.run(ctx, request());

    expect(result).toMatchObject({
      ok: false,
      code: "channel_unavailable",
      safeMessage: "no connected Gmail account",
    });
    expect(preparer.calls).toHaveLength(0);
  });

  it("does not prepare without a positive bridge quantity", async () => {
    const store = harborStore();
    store.assessments.get(ASSESSMENT_A)!.bridge_qty = null;
    const preparer = createFakePreparer(store);
    const tool = createRequestSupplierEmailTool({ store, clock, preparer });

    const result = await tool.run(ctx, request());

    expect(result).toMatchObject({ ok: false, code: "insufficient_facts" });
    expect(preparer.calls).toHaveLength(0);
  });

  it("counts the new supplier and episode metadata against the email budget", async () => {
    const store = harborStore();
    const preparer = createFakePreparer(store);
    const tool = createRequestSupplierEmailTool({
      store,
      clock,
      preparer,
      limits: { ...DEFAULT_LIMITS, emailsPerSupplier: 1 },
    });

    const first = await tool.run(ctx, request());
    expect(first.ok).toBe(true);
    const firstAction = [...store.actions.values()][0]!;
    firstAction.episode = null;

    const second = await tool.run(
      ctx,
      request({ purpose: "follow_up" }),
    );

    expect(second).toMatchObject({ ok: false, code: "budget_exhausted" });
    expect(preparer.calls).toHaveLength(1);
  });

  it("dispatches the prepared tool payload through replay and confirms the rendered email", async () => {
    const store = harborStore();
    const preparer = createFakePreparer(store);
    const tool = createRequestSupplierEmailTool({ store, clock, preparer });
    const result = await tool.run(ctx, request());
    expect(result.ok).toBe(true);

    const payload = supplierEmailPayloadSchema.parse(preparer.calls[0].payload);
    const transport = createReplayTransport();
    const adapter = createSupplierEmailAdapter({
      appEnv: () => "replay",
      transportFor: () => null,
      loadContact: (orgId, contactId) =>
        store.getContact(orgId, contactId),
      fromAddressFor: () => "inbox@conduit.local",
      replayTransport: transport,
    });
    const action: ActionRecord = {
      id: "action-supplier-email",
      orgId: ctx.orgId,
      caseId: ctx.caseId,
      kind: "supplier_email",
      idempotencyKey: preparer.calls[0].idempotencyKey,
      payloadHash: "payload-hash",
      payload,
      contactId: BAY_EMAIL_CONTACT,
      providerRef: null,
      mode: "replay",
    };

    expect((await adapter.dispatch(action)).outcome).toBe("submitted");
    expect((await adapter.dispatch(action)).outcome).toBe("confirmed");
    expect(transport.sent).toHaveLength(1);
    const raw = transport.sent[0].raw;
    const body = raw.slice(raw.indexOf("\r\n\r\n") + 4);
    expect(body).toContain("Quantity: 600 carton");
    expect(body).toContain("Destination: Main Warehouse");
    expect(body).toContain("Please include: unit_price, quantity_available.");
  });
});
