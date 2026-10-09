import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const organizationA = "00000000-0000-4000-8000-000000000001";
const organizationB = "00000000-0000-4000-8000-000000000002";
const itemA = "20000000-0000-4000-8000-000000000001";
const locationA = "10000000-0000-4000-8000-000000000001";
const itemB = "20000000-0000-4000-8000-000000000002";
const locationB = "10000000-0000-4000-8000-000000000002";
const userA = "30000000-0000-4000-8000-000000000001";
const userB = "30000000-0000-4000-8000-000000000002";
const caseA = "40000000-0000-4000-8000-000000000001";
const caseB = "40000000-0000-4000-8000-000000000002";

const client = new Client({
  connectionString:
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
});

async function setRole(role: "authenticated" | "anon", userId?: string) {
  await client.query("begin");
  await client.query(`set local role ${role}`);
  if (userId) {
    await client.query(
      "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [userId, JSON.stringify({ sub: userId, role })],
    );
  }
}

describe("tenant row-level security", () => {
  beforeAll(async () => {
    await client.connect();
    for (const [id, email] of [
      [userA, "rls-a@harbor.example"],
      [userB, "rls-b@other.example"],
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
      [organizationA, organizationB, userA, userB],
    );
    await client.query(
      `insert into public.cases (id, org_id, item_id, location_id)
       values ($1, $3, $5, $7), ($2, $4, $6, $8)
       on conflict (id) do nothing`,
      [caseA, caseB, organizationA, organizationB, itemA, itemB, locationA, locationB],
    );
  });

  afterAll(async () => {
    await client.query("delete from public.cases where id = any($1::uuid[])", [[caseA, caseB]]);
    await client.query("delete from public.memberships where auth_user_id = any($1::uuid[])", [
      [userA, userB],
    ]);
    await client.query("delete from auth.users where id = any($1::uuid[])", [[userA, userB]]);
    await client.end();
  });

  it("allows an org A member to read its case and returns no org B rows", async () => {
    await setRole("authenticated", userA);
    const result = await client.query(
      "select id from public.cases where id = any($1::uuid[]) order by id",
      [[caseA, caseB]],
    );
    await client.query("rollback");
    expect(result.rows.map((row) => row.id)).toEqual([caseA]);
  });

  it("does not grant anon access to tenant rows or private schema", async () => {
    await setRole("anon");
    await expect(client.query("select * from public.cases")).rejects.toThrow();
    await client.query("rollback");

    await setRole("authenticated", userA);
    await expect(client.query("select * from private.voice_grants")).rejects.toThrow();
    await client.query("rollback");
  });

  it("does not allow authenticated clients to insert cases", async () => {
    await setRole("authenticated", userA);
    await expect(
      client.query(
        `insert into public.cases (org_id, item_id, location_id) values ($1, $2, $3)`,
        [organizationA, itemA, locationA],
      ),
    ).rejects.toThrow();
    await client.query("rollback");
  });
});
