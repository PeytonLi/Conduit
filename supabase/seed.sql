insert into public.organizations (id, name, timezone, currency, environment_mode)
values
  ('00000000-0000-4000-8000-000000000001', 'Harbor Pack', 'America/Los_Angeles', 'USD', 'sandbox'),
  ('00000000-0000-4000-8000-000000000002', 'Other Co', 'America/Los_Angeles', 'USD', 'sandbox');

insert into public.locations (id, org_id, name, external_id, timezone, destination_address)
values
  (
    '10000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001',
    'Main Warehouse',
    'MAIN-WAREHOUSE',
    'America/Los_Angeles',
    '{}'::jsonb
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000002',
    'Other Co Warehouse',
    'OTHER-WAREHOUSE',
    'America/Los_Angeles',
    '{}'::jsonb
  );

insert into public.items (id, org_id, sku, description, base_unit, specification)
values
  (
    '20000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001',
    'CARTON-302015',
    'Shipping carton',
    'carton',
    '{"length_mm":300,"width_mm":200,"height_mm":150,"material_grade":"KRAFT-SW-DEMO"}'::jsonb
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000002',
    'OTHER-ITEM',
    'Other Co item',
    'unit',
    '{}'::jsonb
  );
