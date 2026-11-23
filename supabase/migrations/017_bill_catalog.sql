-- 017: product list with this restaurant's prices, for creating a bill from the backend (admins and coordinators)
create or replace function public.boh_bill_catalog(p_rest uuid)
returns table (product_id uuid, product_name text, display_name text, category_name text, unit text, price numeric, on_list boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not boh_is_team() then raise exception 'not allowed'; end if;
  return query
  select p.id, p.name, nullif(trim(rp.display_name), ''), c.name, p.unit, boh_selling_price(p_rest, p.id), coalesce(rp.active, false)
    from boh_products p
    join boh_categories c on c.id = p.category_id
    left join boh_restaurant_products rp on rp.restaurant_id = p_rest and rp.product_id = p.id
   where p.active and exists (select 1 from boh_product_best_rate b where b.product_id = p.id)
   order by coalesce(rp.active, false) desc, c.name, p.name;
end $$;
revoke execute on function public.boh_bill_catalog(uuid) from public, anon;
grant execute on function public.boh_bill_catalog(uuid) to authenticated;
