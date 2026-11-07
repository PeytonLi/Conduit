# Local Odoo for the Odoo connector contract

`./scripts/odoo-local/setup.sh` starts a throwaway Odoo Community 20.0 (official `odoo:20` and `postgres:17` images) on `127.0.0.1:8069`, installs purchase, stock and sale, and seeds the README example: 600 cartons on hand, a 4,000-carton PO due next Tuesday, and 400 cartons a day of confirmed sales Tuesday to Thursday. It writes a local API key to `scripts/odoo-local/.state/env` (gitignored).

Then run the real-system contract (skipped unless `ODOO_CONTRACT_URL` is set):

```
source scripts/odoo-local/.state/env
pnpm vitest run --project integration tests/integration/odoo-contract.test.ts
```

Rerunning `setup.sh` wipes and reseeds. Remove everything with `docker rm -f conduit-odoo conduit-odoo-db`.
