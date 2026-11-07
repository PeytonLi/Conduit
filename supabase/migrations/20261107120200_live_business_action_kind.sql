-- Approved delivery-schedule write to a connected business system (Odoo, Zoho
-- Inventory, QuickBooks Online, Shopify). Added alone so later migrations can use it.
alter type public.action_kind add value if not exists 'live_business_amendment';
