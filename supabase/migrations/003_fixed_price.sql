-- Fixed selling price per restaurant per product (overrides mark-up)
alter table public.boh_restaurant_products add column if not exists fixed_price numeric(12,2);

create or replace function public.boh_check_fixed_price() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_rate numeric;
begin
  if new.fixed_price is null then return new; end if;
  if new.fixed_price <= 0 then raise exception 'Fixed price must be more than 0'; end if;
  if tg_op = 'UPDATE' and new.fixed_price is not distinct from old.fixed_price then return new; end if;
  select rate into v_rate from boh_product_best_rate where product_id = new.product_id;
  if v_rate is not null and new.fixed_price < v_rate then
    raise exception 'Fixed price ₹% is below the lowest active vendor rate ₹%', new.fixed_price, v_rate;
  end if;
  return new;
end $$;
drop trigger if exists boh_check_fixed_price on public.boh_restaurant_products;
create trigger boh_check_fixed_price before insert or update of fixed_price on public.boh_restaurant_products
  for each row execute function public.boh_check_fixed_price();

create or replace function public.boh_selling_price(p_restaurant uuid, p_product uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select fixed_price from boh_restaurant_products where restaurant_id = p_restaurant and product_id = p_product),
    (select round(b.rate * (1 + boh_effective_margin(p_restaurant, p_product) / 100), 2) from boh_product_best_rate b where b.product_id = p_product))
$$;
revoke execute on function public.boh_selling_price(uuid, uuid) from public, anon, authenticated;

create or replace function public.boh_my_catalog()
returns table (product_id uuid, product_name text, category_id uuid, category_name text, unit text,
               brand text, image_url text, description text, price numeric)
language plpgsql stable security definer set search_path = public as $$
declare r uuid := boh_my_restaurant();
begin
  if r is null then raise exception 'not a customer'; end if;
  return query
  select p.id, p.name, c.id, c.name, p.unit, p.brand, case when p.show_image then p.image_url end, p.description,
         case when b.rate is null then null else boh_selling_price(r, p.id) end
  from boh_restaurant_products rp
  join boh_products p on p.id = rp.product_id and p.active
  join boh_categories c on c.id = p.category_id
  left join boh_product_best_rate b on b.product_id = p.id
  where rp.restaurant_id = r and rp.active and boh_category_on(r, c.id)
  order by c.sort, c.name, p.name;
end $$;

drop function if exists public.boh_restaurant_catalog(uuid);
create function public.boh_restaurant_catalog(p_restaurant uuid)
returns table (rp_id uuid, product_id uuid, product_name text, category_id uuid, category_name text, unit text,
               rp_active boolean, category_active boolean, margin_override numeric, fixed_price numeric, effective_margin numeric,
               cost numeric, price numeric, vendor_name text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not boh_is_staff() then raise exception 'not allowed'; end if;
  return query
  select rp.id, p.id, p.name, c.id, c.name, p.unit, rp.active, boh_category_on(p_restaurant, c.id), rp.margin_override, rp.fixed_price,
         case when rp.fixed_price is not null and b.rate > 0 then round((rp.fixed_price / b.rate - 1) * 100, 2) else boh_effective_margin(p_restaurant, p.id) end,
         b.rate, case when b.rate is null then rp.fixed_price else boh_selling_price(p_restaurant, p.id) end, b.vendor_name
  from boh_restaurant_products rp
  join boh_products p on p.id = rp.product_id
  join boh_categories c on c.id = p.category_id
  left join boh_product_best_rate b on b.product_id = p.id
  where rp.restaurant_id = p_restaurant
  order by c.sort, c.name, p.name;
end $$;
revoke execute on function public.boh_restaurant_catalog(uuid) from public, anon;
grant execute on function public.boh_restaurant_catalog(uuid) to authenticated;

create or replace function public.boh_place_order(p_items jsonb, p_notes text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  r uuid := boh_my_restaurant();
  s boh_settings;
  ist timestamp := (now() at time zone 'Asia/Kolkata');
  v_delivery date; v_order uuid; it jsonb; v_qty numeric; p record; v_margin numeric; v_price numeric;
  v_total numeric := 0; v_cost numeric := 0;
begin
  if r is null then raise exception 'Only restaurant users can place orders'; end if;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then raise exception 'Order is empty'; end if;
  select * into s from boh_settings where id = 1;
  v_delivery := case when ist::time < s.order_cutoff then ist::date + 1 else ist::date + 2 end;
  insert into boh_orders (restaurant_id, placed_by, delivery_date, notes) values (r, auth.uid(), v_delivery, p_notes) returning id into v_order;
  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := (it->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then continue; end if;
    select pr.id, pr.name, pr.unit, c.id as cat_id, c.name as cat, b.rate, b.vendor_id, b.vendor_name, b.delivery_style into p
      from boh_restaurant_products rp
      join boh_products pr on pr.id = rp.product_id and pr.active
      join boh_categories c on c.id = pr.category_id
      left join boh_product_best_rate b on b.product_id = pr.id
      where rp.restaurant_id = r and rp.active and rp.product_id = (it->>'product_id')::uuid and boh_category_on(r, c.id);
    if not found then raise exception 'Product % is not on your ordering list', it->>'product_id'; end if;
    if p.rate is null then raise exception '% has no active price yet — please contact us', p.name; end if;
    v_price := boh_selling_price(r, p.id);
    v_margin := case when p.rate > 0 then round((v_price / p.rate - 1) * 100, 2) else null end;
    insert into boh_order_items (order_id, product_id, product_name, category_id, category_name, unit, qty, unit_cost, margin_pct,
                                 unit_price, line_total, vendor_id, vendor_name, delivery_style)
    values (v_order, p.id, p.name, p.cat_id, p.cat, p.unit, v_qty, p.rate, v_margin, v_price, round(v_price * v_qty, 2),
            p.vendor_id, p.vendor_name, p.delivery_style);
    v_total := v_total + round(v_price * v_qty, 2);
    v_cost := v_cost + round(p.rate * v_qty, 2);
  end loop;
  if v_total = 0 then raise exception 'Order is empty'; end if;
  update boh_orders set total = v_total, cost_total = v_cost where id = v_order;
  insert into boh_order_events (order_id, event, actor) values (v_order, 'placed', auth.uid());
  return v_order;
end $$;
