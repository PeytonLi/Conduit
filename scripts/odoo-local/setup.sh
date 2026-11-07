#!/usr/bin/env bash
# Starts a throwaway local Odoo Community (official odoo + postgres images), installs
# purchase/stock/sale, seeds the README example and prints the env vars for the contract test.
# Rerun safely: it recreates the containers and database. Nothing here talks to a hosted Odoo.
set -euo pipefail

ODOO_IMAGE="${ODOO_IMAGE:-odoo:20}"
PG_IMAGE="${PG_IMAGE:-postgres:17}"
PORT="${ODOO_LOCAL_PORT:-8069}"
DB="${ODOO_LOCAL_DB:-conduit_contract}"
NET=conduit-odoo
PG_PASS="$(openssl rand -hex 16)"
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="$HERE/.state"

docker rm -f conduit-odoo conduit-odoo-db >/dev/null 2>&1 || true
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

docker run -d --name conduit-odoo-db --network "$NET" \
  -e POSTGRES_USER=odoo -e POSTGRES_PASSWORD="$PG_PASS" -e POSTGRES_DB=postgres "$PG_IMAGE" >/dev/null
until docker exec conduit-odoo-db pg_isready -U odoo >/dev/null 2>&1; do sleep 1; done

echo "Installing purchase, stock and sale into $DB (takes a few minutes)..."
DB_ENV=(-e HOST=conduit-odoo-db -e USER=odoo -e PASSWORD="$PG_PASS")
docker run --rm --network "$NET" "${DB_ENV[@]}" "$ODOO_IMAGE" \
  -d "$DB" -i purchase_stock,sale_stock --stop-after-init --log-level=warn

docker run -d --name conduit-odoo --network "$NET" "${DB_ENV[@]}" -p "127.0.0.1:$PORT:8069" "$ODOO_IMAGE" \
  -d "$DB" --db-filter="^$DB\$" >/dev/null

mkdir -p "$STATE"
docker exec -i conduit-odoo odoo shell --db_host=conduit-odoo-db --db_user=odoo --db_password="$PG_PASS" \
  -d "$DB" --no-http --log-level=warn < "$HERE/seed.py" | grep '^CONDUIT_SEED ' | sed 's/^CONDUIT_SEED //' > "$STATE/seed.json"

until curl -sf "http://127.0.0.1:$PORT/web/version" >/dev/null; do sleep 1; done

API_KEY=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["api_key"])' "$STATE/seed.json")
cat > "$STATE/env" <<ENV
export ODOO_CONTRACT_URL=http://127.0.0.1:$PORT
export ODOO_CONTRACT_DB=$DB
export ODOO_CONTRACT_LOGIN=admin
export ODOO_CONTRACT_API_KEY=$API_KEY
ENV
echo "Seeded: $(cat "$STATE/seed.json" | python3 -c 'import json,sys; d=json.load(sys.stdin); d.pop("api_key"); print(d)')"
echo "Run the contract test with:"
echo "  source $STATE/env && pnpm vitest run --project integration tests/integration/odoo-contract.test.ts"
