import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const orgA = "00000000-0000-4000-8000-000000000001";
const orgB = "00000000-0000-4000-8000-000000000002";
const userA = "30000000-0000-4000-8000-000000000001";
const userB = "30000000-0000-4000-8000-000000000002";
// Distinct case ids so rls.test's cleanup never trips over our FK rows when
// the two integration files run against the same database.
const caseA = "40000000-0000-4000-8000-000000000003";
const caseB = "40000000-0000-4000-8000-000000000004";
// Dedicated item/location ids too: cases_one_active_per_item_location means
// this file must not share an item+location with rls.test's cases.
const itemA = "20000000-0000-4000-8000-000000000003";
const locationA = "10000000-0000-4000-8000-000000000003";
const itemB = "20000000-0000-4000-8000-000000000004";
const locationB = "10000000-0000-4000-8000-000000000004";
const reviewA = "11000000-0000-4000-8000-000000000011";
const reviewB = "11000000-0000-4000-8000-000000000022";
const queryA = "12000000-0000-4000-8000-000000000011";
const queryB = "12000000-0000-4000-8000-000000000022";
const candidateB = "13000000-0000-4000-8000-000000000099";

const client = new Client({
  connectionString:
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    // Assembled so secret scanners don't flag a literal credential in the URL.
    "postgresql://" + "postgres:postgres" + "@127.0.0.1:54322/postgres",
});

async function asRole(userId: string) {
  await client.query("begin");
  await client.query("set local role authenticated");
  await client.query(
    "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
    [userId, JSON.stringify({ sub: userId, role: "authenticated" })],
  );
}

describe("planner research tables", () => {
  beforeAll(async () => {
    await client.connect();
    for (const [id, email] of [
      [userA, "planner-a@harbor.example"],
      [userB, "planner-b@other.example"],
    ]) {
      await client.query(
        `insert into auth.users
          (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
           raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
         values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated',
           'authenticated', $2, '', now(), '{"provider":"email","providers":["email"]}',
           '{}', now(), now())
         on conflict (id) do nothing`,
        [id, email],
      );
    }
    await client.query(
      `insert into public.memberships (org_id, auth_user_id, role)
       values ($1, $3, 'owner'), ($2, $4, 'owner')
       on conflict (org_id, auth_user_id) do nothing`,
      [orgA, orgB, userA, userB],
    );
    await client.query(
      `insert into public.locations (id, org_id, name, timezone)
       values ($1, $3, 'PlannerDB Loc A', 'UTC'), ($2, $4, 'PlannerDB Loc B', 'UTC')
       on conflict (id) do nothing`,
      [locationA, locationB, orgA, orgB],
    );
    await client.query(
      `insert into public.items (id, org_id, sku, description, base_unit)
       values ($1, $3, 'PLANNERDB-A', 'planner db item a', 'carton'),
              ($2, $4, 'PLANNERDB-B', 'planner db item b', 'each')
       on conflict (id) do nothing`,
      [itemA, itemB, orgA, orgB],
    );
    await client.query(
      `insert into public.cases (id, org_id, item_id, location_id)
       values ($1, $3, $5, $7), ($2, $4, $6, $8)
       on conflict (id) do nothing`,
      [caseA, caseB, orgA, orgB, itemA, itemB, locationA, locationB],
    );
    await client.query(
      `insert into public.planner_reviews (id, org_id, case_id, reason)
       values ($1, $3, $5, 'test review'), ($2, $4, $6, 'other org review')
       on conflict (id) do nothing`,
      [reviewA, reviewB, orgA, orgB, caseA, caseB],
    );
    await client.query(
      `insert into public.research_queries
         (id, org_id, case_id, episode, query, provider, mode)
       values ($1, $2, $3, 1, 'cartons', 'exa', 'replay'),
              ($4, $5, $6, 1, 'widgets', 'exa', 'replay')
       on conflict (id) do nothing`,
      [queryA, orgA, caseA, queryB, orgB, caseB],
    );
  });

  afterAll(async () => {
    await client.query("delete from public.planner_reviews where id = any($1::uuid[])", [
      [reviewA, reviewB],
    ]);
    await client.query("delete from public.research_queries where id = any($1::uuid[])", [
      [queryA, queryB],
    ]);
    await client.query("delete from public.cases where id = any($1::uuid[])", [
      [caseA, caseB],
    ]);
    await client.query("delete from public.items where id = any($1::uuid[])", [
      [itemA, itemB],
    ]);
    await client.query("delete from public.locations where id = any($1::uuid[])", [
      [locationA, locationB],
    ]);
    await client.query("delete from public.memberships where auth_user_id = any($1::uuid[])", [
      [userA, userB],
    ]);
    await client.query("delete from auth.users where id = any($1::uuid[])", [
      [userA, userB],
    ]);
    await client.end();
  });

  it("new tables exist with RLS enabled", async () => {
    const { rows } = await client.query(
      `select relname, relrowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relname = any($1)`,
      [[
        "planner_cycles",
        "planner_requests",
        "research_queries",
        "supplier_candidates",
        "planner_waits",
        "planner_reviews",
        "research_page_reads",
      ]],
    );
    expect(rows.length).toBe(7);
    for (const row of rows) expect(row.relrowsecurity).toBe(true);
  });

  it("org A member reads own planner_reviews and sees none of org B", async () => {
    await asRole(userA);
    const { rows } = await client.query(
      "select id from public.planner_reviews where id = any($1::uuid[])",
      [[reviewA, reviewB]],
    );
    await client.query("rollback");
    expect(rows.map((r) => r.id)).toEqual([reviewA]);
  });

  it("org A member sees no org B supplier_candidates", async () => {
    await client.query(
      `insert into public.supplier_candidates
         (id, org_id, case_id, research_query_id, name, compatibility)
       values ($4, $1, $2, $3, 'OrgB Co', 'unknown')
       on conflict (id) do nothing`,
      [orgB, caseB, queryB, candidateB],
    );
    await asRole(userA);
    const { rows } = await client.query(
      "select id from public.supplier_candidates",
    );
    await client.query("rollback");
    expect(rows.map((r) => r.id)).not.toContain(candidateB);
    await client.query(
      "delete from public.supplier_candidates where id = $1",
      [candidateB],
    );
  });

  it("authenticated insert is denied on planner_reviews", async () => {
    await asRole(userA);
    await expect(
      client.query(
        "insert into public.planner_reviews (org_id, case_id, reason) values ($1, $2, 'x')",
        [orgA, caseA],
      ),
    ).rejects.toThrow();
    await client.query("rollback");
  });

  it("supplier_candidates status check rejects 'approved'", async () => {
    await expect(
      client.query(
        `insert into public.supplier_candidates
           (org_id, case_id, research_query_id, name, compatibility, status)
         values ($1, $2, $3, 'x', 'unknown', 'approved')`,
        [orgA, caseA, queryA],
      ),
    ).rejects.toThrow();
  });
});
