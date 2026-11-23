-- Per-restaurant display name for a product (e.g. "11 mm Fries" shown as "Fries" to one
-- restaurant and "Poptato" to another). Staff keep seeing the real product name.
alter table public.boh_restaurant_products add column if not exists display_name text;

create or replace function public.boh_my_display_names()
returns table (product_id uuid, display_name text)
language sql stable security definer set search_path = public as $$
  select rp.product_id, btrim(rp.display_name)
  from boh_restaurant_products rp
  where rp.restaurant_id = boh_my_restaurant()
    and rp.display_name is not null and btrim(rp.display_name) <> '';
$$;
revoke all on function public.boh_my_display_names() from public, anon;
grant execute on function public.boh_my_display_names() to authenticated;
