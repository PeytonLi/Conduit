-- Approved internal stock transfer executed in a connected business system (Shopify).
-- Added alone so the next migration can use the value.
alter type public.action_kind add value if not exists 'live_business_transfer';
