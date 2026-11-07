# Runs inside `odoo shell`. Seeds the README example: 600 cartons on hand, a 4,000-carton PO due
# next Tuesday and 400 cartons/day of confirmed sales Tuesday to Thursday.
import json
from datetime import datetime, timedelta, time

today = datetime.utcnow().date()
tuesday = today + timedelta(days=((1 - today.weekday()) % 7) or 7)
at = lambda d: datetime.combine(d, time(17, 0))

company = env.company
company.write({"name": "Conduit Contract Test Co (local)"})
warehouse = env["stock.warehouse"].search([("company_id", "=", company.id)], limit=1)
uom_unit = env.ref("uom.product_uom_unit")

vendor = env["res.partner"].create({"name": "Bay Carton Supply", "email": "orders@baycarton.example", "phone": "+1 555 0100"})
customer = env["res.partner"].create({"name": "Harbor Foods", "email": "ops@harborfoods.example"})
product = env["product.product"].create({
    "name": "Shipping carton 30x20x15",
    "default_code": "CARTON-302015",
    "type": "consu",
    "is_storable": True,
    "uom_id": uom_unit.id,
    "standard_price": 0.42,
    "list_price": 0.95,
    "purchase_method": "receive",
})

env["stock.quant"].with_context(inventory_mode=True).create({
    "product_id": product.id,
    "location_id": warehouse.lot_stock_id.id,
    "inventory_quantity": 600,
}).action_apply_inventory()

po = env["purchase.order"].create({
    "partner_id": vendor.id,
    "picking_type_id": warehouse.in_type_id.id,
    "order_line": [(0, 0, {
        "product_id": product.id,
        "product_qty": 4000,
        "price_unit": 0.42,
        "date_planned": at(tuesday),
    })],
})
po.button_confirm()

for offset in range(3):
    so = env["sale.order"].create({
        "partner_id": customer.id,
        "commitment_date": at(tuesday + timedelta(days=offset)),
        "warehouse_id": warehouse.id,
        "order_line": [(0, 0, {"product_id": product.id, "product_uom_qty": 400, "price_unit": 0.95})],
    })
    so.action_confirm()

admin = env.ref("base.user_admin")
api_key = env["res.users.apikeys"].with_user(admin)._generate("rpc", "conduit-contract", datetime.now() + timedelta(days=30))
env.cr.commit()

print("CONDUIT_SEED " + json.dumps({
    "api_key": api_key,
    "po_id": po.id,
    "po_name": po.name,
    "line_id": po.order_line[0].id,
    "product_id": product.id,
    "warehouse_id": warehouse.id,
    "tuesday": tuesday.isoformat(),
}))
