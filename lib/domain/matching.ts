import type { VerifiedLine, UnresolvedFact } from "@/lib/agent/extraction-verify";

export interface SenderContact {
  contact_id: string;
  supplier_id: string;
  supplier_name: string;
  normalized_address: string;
  channel: string;
  outreach_approved_at: string | null;
  permitted_channels: string[];
}

export interface ContextSchedule {
  id: string;
  quantity_remaining: number;
  earliest_at: string | null;
  latest_at: string | null;
  promise_state: string;
}

export interface ContextLine {
  po_line_id: string;
  po_id: string;
  po_external_id: string;
  external_line_id: string | null;
  supplier_id: string;
  item_id: string;
  sku: string;
  base_unit: string;
  supplier_skus: string[];
  location_id: string;
  location_timezone: string;
  ordered_qty: number;
  received_qty: number;
  cancelled_qty: number;
  active_schedules: ContextSchedule[];
}

export interface MatchContext {
  sender_contacts: SenderContact[];
  lines: ContextLine[];
}

export interface MatchedLine {
  po_line_id: string;
  item_id: string;
  location_id: string;
  schedule_id: string;
  affected_qty: number;
  remaining_qty: number;
  full: boolean;
  new_earliest_at: string | null;
  new_latest_at: string | null;
  new_promise_state: "confirmed" | "estimated";
  evidence_id: string | null;
}

export interface MatchCandidate {
  line_index: number;
  po_line_id: string;
  po_external_id: string;
  external_line_id: string | null;
  sku: string;
  item_id: string;
  location_id: string;
  remaining_qty: number;
}

export interface MatchOutcome {
  status: "matched" | "needs_review" | "not_delay";
  lines: MatchedLine[];
  unresolved: UnresolvedFact[];
  candidates: MatchCandidate[];
  case_groups: { item_id: string; location_id: string }[];
}

export function normalizeOrderRef(ref: string): string {
  return ref
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^PO/, "");
}

function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/s$/, "");
}

function normalizeSku(sku: string): string {
  return sku.toUpperCase().replace(/[\s_-]+/g, "");
}

export interface MatchInput {
  senderAddress: string;
  verifiedLines: VerifiedLine[];
  context: MatchContext;
  isDelayNotice: boolean;
  pins?: Record<number, string>;
}

export function matchDelay(input: MatchInput): MatchOutcome {
  const { senderAddress, context, pins } = input;
  const unresolved: UnresolvedFact[] = [];
  const candidates: MatchCandidate[] = [];

  if (!input.isDelayNotice) {
    return {
      status: "not_delay",
      lines: [],
      unresolved: [],
      candidates: [],
      case_groups: [],
    };
  }

  const sender = senderAddress.toLowerCase();
  const contacts = context.sender_contacts.filter(
    (c) => c.channel === "email" && c.normalized_address === sender,
  );
  const supplierIds = [...new Set(contacts.map((c) => c.supplier_id))];
  if (supplierIds.length !== 1) {
    unresolved.push({
      line_index: -1,
      field: "supplier",
      reason:
        supplierIds.length === 0 ? "sender_not_a_supplier_contact" : "sender_matches_multiple_suppliers",
    });
    // Supplier unresolved: never offer other suppliers' lines as candidates
    // and never open or join a case.
    return {
      status: "needs_review",
      lines: [],
      unresolved,
      candidates: [],
      case_groups: [],
    };
  }
  const supplierId = supplierIds[0];
  const supplierLines = context.lines.filter((l) => l.supplier_id === supplierId);

  const seen = new Set<string>();
  const candidatePool: ContextLine[][] = input.verifiedLines.map(() => []);

  input.verifiedLines.forEach((vl, i) => {
    if (pins?.[i] !== undefined) {
      const pinned = context.lines.find((l) => l.po_line_id === pins[i]);
      if (!pinned || pinned.supplier_id !== supplierId) {
        unresolved.push({
          line_index: i,
          field: "order_line",
          reason: "pin_invalid",
        });
        return;
      }
      if (seen.has(pinned.po_line_id)) {
        unresolved.push({
          line_index: i,
          field: "order_line",
          reason: "duplicate_line",
        });
        return;
      }
      seen.add(pinned.po_line_id);
      candidatePool[i] = [pinned];
      return;
    }

    let pool = supplierLines;

    if (vl.order_ref) {
      const want = normalizeOrderRef(vl.order_ref);
      pool = pool.filter((l) => normalizeOrderRef(l.po_external_id) === want);
      if (pool.length === 0) {
        unresolved.push({ line_index: i, field: "order_ref", reason: "no_matching_order" });
        candidatePool[i] = supplierLines;
        return;
      }
    }

    const itemRef = vl.item_ref ?? null;
    const lineRef = vl.line_ref ?? null;

    if (lineRef) {
      const filtered = pool.filter(
        (l) => l.external_line_id && l.external_line_id === lineRef,
      );
      if (filtered.length > 0) pool = filtered;
    }
    // Item refs match only an exact SKU or supplier SKU (post-normalize); a
    // generic noun never narrows the pool.
    const itemRefMatches = (l: ContextLine, want: string) =>
      normalizeSku(l.sku) === want ||
      l.supplier_skus.some((s) => normalizeSku(s) === want);

    if (itemRef) {
      const want = normalizeSku(itemRef);
      const filtered = pool.filter((l) => itemRefMatches(l, want));
      if (filtered.length > 0) {
        pool = filtered;
      } else {
        unresolved.push({
          line_index: i,
          field: "item_ref",
          reason: "no_matching_item",
        });
      }
    }

    if (pool.length === 0) {
      unresolved.push({ line_index: i, field: "order_ref", reason: "no_matching_order" });
      candidatePool[i] = itemRef
        ? supplierLines.filter((l) => itemRefMatches(l, normalizeSku(itemRef)))
        : supplierLines;
      return;
    }
    if (pool.length > 1) {
      unresolved.push({ line_index: i, field: "order_line", reason: "ambiguous_line" });
      candidatePool[i] = pool;
      return;
    }

    const chosen = pool[0];
    if (seen.has(chosen.po_line_id)) {
      unresolved.push({ line_index: i, field: "order_line", reason: "duplicate_line" });
      return;
    }
    seen.add(chosen.po_line_id);
    candidatePool[i] = [chosen];
  });

  return finish(input.verifiedLines, unresolved, candidates, context, pins, candidatePool, seen);
}

function finish(
  verifiedLines: VerifiedLine[],
  unresolved: UnresolvedFact[],
  candidates: MatchCandidate[],
  context: MatchContext,
  pins: Record<number, string> | undefined,
  candidatePool?: ContextLine[][],
  seen?: Set<string>,
): MatchOutcome {
  // Recompute pools when called from the early supplier-unresolved return.
  if (!candidatePool) {
    candidatePool = verifiedLines.map(() => context.lines.slice(0, 10));
    seen = new Set();
  }

  const matched: MatchedLine[] = [];

  verifiedLines.forEach((vl, i) => {
    const pool = candidatePool![i];
    if (pool.length !== 1 || unresolved.some((u) => u.line_index === i)) {
      if (pool.length > 0 && candidates.length < 50) {
        for (const l of pool.slice(0, 10)) {
          candidates.push({
            line_index: i,
            po_line_id: l.po_line_id,
            po_external_id: l.po_external_id,
            external_line_id: l.external_line_id,
            sku: l.sku,
            item_id: l.item_id,
            location_id: l.location_id,
            remaining_qty: l.ordered_qty - l.received_qty - l.cancelled_qty,
          });
        }
      }
      return;
    }
    const line = pool[0];
    const remaining = line.ordered_qty - line.received_qty - line.cancelled_qty;

    const scheduleSum = line.active_schedules.reduce(
      (s, sch) => s + sch.quantity_remaining,
      0,
    );
    if (scheduleSum !== remaining) {
      unresolved.push({ line_index: i, field: "schedule", reason: "schedule_conflict" });
      return;
    }
    const active = line.active_schedules.filter((s) => s.promise_state !== "superseded");
    if (active.length !== 1) {
      unresolved.push({ line_index: i, field: "schedule", reason: "schedule" });
      return;
    }
    const schedule = active[0];

    if (vl.unit != null && normalizeUnit(vl.unit) !== normalizeUnit(line.base_unit)) {
      unresolved.push({ line_index: i, field: "unit", reason: "unit" });
      return;
    }

    let affected: number;
    if (vl.quantity_scope === "all_remaining") {
      affected = remaining;
      if (vl.affected_quantity != null && vl.affected_quantity !== remaining) {
        unresolved.push({ line_index: i, field: "affected_quantity", reason: "quantity" });
        return;
      }
    } else if (vl.quantity_scope === "partial") {
      if (vl.affected_quantity == null || vl.affected_quantity <= 0) {
        unresolved.push({ line_index: i, field: "affected_quantity", reason: "quantity" });
        return;
      }
      affected = vl.affected_quantity;
    } else {
      unresolved.push({ line_index: i, field: "affected_quantity", reason: "quantity" });
      return;
    }
    if (affected > remaining) {
      unresolved.push({ line_index: i, field: "affected_quantity", reason: "quantity" });
      return;
    }

    if (!vl.new_promise) {
      unresolved.push({ line_index: i, field: "new_promise", reason: "missing" });
      return;
    }

    matched.push({
      po_line_id: line.po_line_id,
      item_id: line.item_id,
      location_id: line.location_id,
      schedule_id: schedule.id,
      affected_qty: affected,
      remaining_qty: remaining,
      full: affected === remaining,
      new_earliest_at: vl.new_promise.earliest_at,
      new_latest_at: vl.new_promise.latest_at,
      new_promise_state: vl.new_promise.promise_state,
      evidence_id: vl.body_evidence_id ?? null,
    });
  });

  void pins;
  void seen;

  if (unresolved.length > 0) {
    const groups = new Map<string, { item_id: string; location_id: string }>();
    for (const vl of verifiedLines) {
      const pool = candidatePool[vl.line_index] ?? [];
      const keys = new Set(pool.map((l) => `${l.item_id}:${l.location_id}`));
      if (keys.size === 1) {
        const l = pool[0];
        groups.set(`${l.item_id}:${l.location_id}`, {
          item_id: l.item_id,
          location_id: l.location_id,
        });
      }
    }
    return {
      status: "needs_review",
      lines: [],
      unresolved,
      candidates: candidates.slice(0, 50),
      case_groups: [...groups.values()],
    };
  }

  const groups = new Map<string, { item_id: string; location_id: string }>();
  for (const m of matched) {
    groups.set(`${m.item_id}:${m.location_id}`, {
      item_id: m.item_id,
      location_id: m.location_id,
    });
  }
  return {
    status: "matched",
    lines: matched,
    unresolved: [],
    candidates: [],
    case_groups: [...groups.values()],
  };
}
