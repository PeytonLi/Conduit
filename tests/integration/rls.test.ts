import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const organizationA = "00000000-0000-4000-8000-000000000001";
const organizationB = "00000000-0000-4000-8000-000000000002";
const itemA = randomUUID();
const locationA = randomUUID();
const itemB = randomUUID();
const locationB = randomUUID();
const userA = "30000000-0000-4000-8000-000000000001";
const userB = "30000000-0000-4000-8000-000000000002";
const caseA = randomUUID();
const caseB = randomUUID();

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
           confirmation_token,
           raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
         values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated',
           'authenticated', $2, '', now(), '', '{"provider":"email","providers":["email"]}',
           '{}', now(), now())
         on conflict (id) do nothing`,
        [id, email],
      );
      await client.query(
        `update auth.users set recovery_token = '', email_change_token_new = '',
          email_change = '', phone_change = '', phone_change_token = '',
          email_change_token_current = '', reauthentication_token = '' where id = $1`,
        [id],
      );
    }
    await client.query(
      `insert into public.memberships (org_id, auth_user_id, role)
       values ($1, $3, 'owner'), ($2, $4, 'owner')
       on conflict (org_id, auth_user_id) do nothing`,
      [organizationA, organizationB, userA, userB],
    );
    await client.query(
      `insert into public.items (id, org_id, sku, description, base_unit)
       values ($1, $3, $5, 'RLS fixture', 'each'), ($2, $4, $6, 'RLS fixture', 'each')`,
      [itemA, itemB, organizationA, organizationB, `RLS-${itemA}`, `RLS-${itemB}`],
    );
    await client.query(
      `insert into public.locations (id, org_id, name, timezone)
       values ($1, $3, $5, 'UTC'), ($2, $4, $6, 'UTC')`,
      [locationA, locationB, organizationA, organizationB, `RLS-${locationA}`, `RLS-${locationB}`],
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
    await client.query("delete from public.items where id = any($1::uuid[])", [[itemA, itemB]]);
    await client.query("delete from public.locations where id = any($1::uuid[])", [[locationA, locationB]]);
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
