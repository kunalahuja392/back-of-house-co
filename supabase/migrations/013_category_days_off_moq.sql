-- 013: category days off (no delivery on some weekdays, set by the super admin) and product MOQ.
--      Orders split by delivery date; auto-orders cover the extra day(s) and respect MOQ.

alter table public.boh_categories add column if not exists off_days smallint[] not null default '{}';
alter table public.boh_products add column if not exists moq numeric(12,3) check (moq is null or moq > 0);

-- only the super admin may change a category's days off
create or replace function public.boh_tr_category_off_days() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.off_days is distinct from old.off_days and coalesce(boh_role(), '') <> 'super_admin' and auth.uid() is not null then
    raise exception 'Only the super admin can change delivery days off';
  end if;
  if exists (select 1 from unnest(new.off_days) d where d not between 1 and 7) then raise exception 'Days off must be weekdays 1 (Mon) to 7 (Sun)'; end if;
  if coalesce(array_length(new.off_days, 1), 0) >= 7 then raise exception 'At least one delivery day is needed'; end if;
  return new;
end $$;
drop trigger if exists boh_tr_category_off_days on public.boh_categories;
create trigger boh_tr_category_off_days before update or insert on public.boh_categories for each row execute function public.boh_tr_category_off_days();

-- first delivery date on/after p_from that is not a day off for the category
create or replace function public.boh_next_delivery(p_cat uuid, p_from date) returns date
language plpgsql stable security definer set search_path = public as $$
declare offs smallint[]; d date := p_from; i int := 0;
begin
  select off_days into offs from boh_categories where id = p_cat;
  while coalesce(extract(isodow from d)::smallint = any (offs), false) and i < 7 loop d := d + 1; i := i + 1; end loop;
  return d;
end $$;

-- normal next delivery date from now (order before the cut-off → tomorrow, else day after)
create or replace function public.boh_base_delivery() returns date
language sql stable security definer set search_path = public as $$
  select case when (now() at time zone 'Asia/Kolkata')::time < order_cutoff then (now() at time zone 'Asia/Kolkata')::date + 1
              else (now() at time zone 'Asia/Kolkata')::date + 2 end from boh_settings where id = 1
$$;
grant execute on function public.boh_next_delivery(uuid, date), public.boh_base_delivery() to authenticated;

-- delivery date per category for an order placed now (for the ordering screen)
create or replace function public.boh_category_delivery()
returns table (category_id uuid, category_name text, delivery_date date, off_days smallint[])
language sql stable security definer set search_path = public as $$
  select c.id, c.name, boh_next_delivery(c.id, boh_base_delivery()), c.off_days from boh_categories c
$$;
revoke execute on function public.boh_category_delivery() from public, anon;
grant execute on function public.boh_category_delivery() to authenticated;

-- order core: one order per delivery date (a category with a day off moves to its next delivery day); MOQ enforced
create or replace function public.boh_place_order_core(p_rest uuid, p_user uuid, p_items jsonb, p_notes text, p_payment_mode text, p_source text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  base date := boh_base_delivery(); it jsonb; v_qty numeric; p record; lines jsonb := '[]'; dd date; v_order uuid; first_order uuid;
  x jsonb; v_price numeric; v_margin numeric; v_total numeric; v_cost numeric; moved text;
begin
  if p_rest is null then raise exception 'Only restaurant users can place orders'; end if;
  if p_payment_mode not in ('prepaid','cod') then raise exception 'Choose pre-pay or pay on delivery'; end if;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then raise exception 'Order is empty'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := (it->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then continue; end if;
    select pr.id, pr.name, pr.unit, pr.moq, c.id as cat_id, c.name as cat, b.rate, b.vendor_id, b.vendor_name, b.delivery_style into p
      from boh_restaurant_products rp
      join boh_products pr on pr.id = rp.product_id and pr.active
      join boh_categories c on c.id = pr.category_id
      left join boh_product_best_rate b on b.product_id = pr.id
      where rp.restaurant_id = p_rest and rp.active and rp.product_id = (it->>'product_id')::uuid and boh_category_on(p_rest, c.id);
    if not found then raise exception 'Product % is not on your ordering list', it->>'product_id'; end if;
    if p.rate is null then raise exception '% has no active price yet — please contact us', p.name; end if;
    if p.moq is not null and v_qty < p.moq then
      if p_source = 'auto' then v_qty := p.moq;
      else raise exception 'Minimum order quantity for % is % %', p.name, trim(to_char(p.moq, 'FM999999990.###')), coalesce(p.unit, ''); end if;
    end if;
    v_price := boh_selling_price(p_rest, p.id);
    lines := lines || jsonb_build_object('pid', p.id, 'name', p.name, 'unit', p.unit, 'cat_id', p.cat_id, 'cat', p.cat, 'qty', v_qty,
      'rate', p.rate, 'price', v_price, 'vendor_id', p.vendor_id, 'vendor_name', p.vendor_name, 'style', p.delivery_style,
      'd', boh_next_delivery(p.cat_id, base));
  end loop;
  if jsonb_array_length(lines) = 0 then raise exception 'Order is empty'; end if;

  for dd in select distinct (l->>'d')::date from jsonb_array_elements(lines) l order by 1 loop
    insert into boh_orders (restaurant_id, placed_by, delivery_date, notes, payment_mode, source)
    values (p_rest, p_user, dd, p_notes, p_payment_mode, p_source) returning id into v_order;
    v_total := 0; v_cost := 0;
    for x in select l from jsonb_array_elements(lines) l where (l->>'d')::date = dd loop
      v_margin := case when (x->>'rate')::numeric > 0 then round(((x->>'price')::numeric / (x->>'rate')::numeric - 1) * 100, 2) end;
      insert into boh_order_items (order_id, product_id, product_name, category_id, category_name, unit, qty, unit_cost, margin_pct,
                                   unit_price, line_total, vendor_id, vendor_name, delivery_style)
      values (v_order, (x->>'pid')::uuid, x->>'name', (x->>'cat_id')::uuid, x->>'cat', x->>'unit', (x->>'qty')::numeric, (x->>'rate')::numeric, v_margin,
              (x->>'price')::numeric, round((x->>'price')::numeric * (x->>'qty')::numeric, 2), nullif(x->>'vendor_id', '')::uuid, x->>'vendor_name', x->>'style');
      v_total := v_total + round((x->>'price')::numeric * (x->>'qty')::numeric, 2);
      v_cost := v_cost + round((x->>'rate')::numeric * (x->>'qty')::numeric, 2);
    end loop;
    update boh_orders set total = v_total, cost_total = v_cost where id = v_order;
    select string_agg(distinct l->>'cat', ', ') into moved from jsonb_array_elements(lines) l where (l->>'d')::date = dd and dd > base;
    insert into boh_order_events (order_id, event, note, actor) values (v_order, 'placed',
      case when p_source = 'auto' then 'Auto order · ' else '' end || case when p_payment_mode = 'prepaid' then 'Pre-pay' else 'Pay on delivery' end ||
      coalesce(' · ' || moved || ' delivered ' || to_char(dd, 'Dy DD Mon') || ' (day off)', ''), p_user);
    first_order := coalesce(first_order, v_order);
  end loop;
  return first_order;
end $$;
revoke execute on function public.boh_place_order_core(uuid, uuid, jsonb, text, text, text) from public, anon, authenticated;

-- auto-order lines: cover every day until the category's next delivery (days off), MOQ applied
drop function if exists public.boh_auto_order_preview(date);
drop function if exists public.boh_auto_lines(uuid, date);
create function public.boh_auto_lines(p_rest uuid, p_date date)
returns table (product_id uuid, product_name text, unit text, stock numeric, reorder_level numeric, method text,
  delivery_date date, days_covered int, moq numeric, order_qty numeric)
language sql stable security definer set search_path = public as $$
  with b as (select boh_base_delivery() base),
  rws as (
    select pr.id, pr.name, pr.unit, pr.category_id cat, sc.qty stock, ss.reorder_level, ss.method, ss.target_level, ss.reorder_qty, pr.moq,
           boh_next_delivery(pr.category_id, b.base) dd
      from b, boh_stock_settings ss
      join boh_stock_counts sc on sc.restaurant_id = ss.restaurant_id and sc.product_id = ss.product_id and sc.count_date = p_date
      join boh_products pr on pr.id = ss.product_id and pr.active
      join boh_restaurant_products rp on rp.restaurant_id = ss.restaurant_id and rp.product_id = ss.product_id and rp.active
     where ss.restaurant_id = p_rest and ss.auto and sc.qty <= ss.reorder_level and boh_category_on(p_rest, pr.category_id)),
  cov as (select r.*, greatest(1, (boh_next_delivery(r.cat, r.dd + 1) - r.dd))::int k from rws r),
  q as (select c.*, case when c.method = 'fixed' then c.reorder_qty * c.k else c.target_level * c.k - c.stock end raw from cov c)
  select q.id, q.name, q.unit, q.stock, q.reorder_level, q.method, q.dd, q.k, q.moq,
         case when q.moq is not null then greatest(q.raw, q.moq) else q.raw end
    from q where q.raw > 0
   order by q.name
$$;
revoke execute on function public.boh_auto_lines(uuid, date) from public, anon, authenticated;

create function public.boh_auto_order_preview(p_date date default null)
returns table (product_id uuid, product_name text, unit text, stock numeric, reorder_level numeric, method text,
  delivery_date date, days_covered int, moq numeric, order_qty numeric, price numeric, line_total numeric)
language plpgsql stable security definer set search_path = public as $$
declare r uuid := boh_need_auto(boh_my_restaurant());
begin
  return query select l.*, boh_selling_price(r, l.product_id), round(boh_selling_price(r, l.product_id) * l.order_qty, 2)
    from boh_auto_lines(r, coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date)) l;
end $$;
revoke execute on function public.boh_auto_order_preview(date) from public, anon;
grant execute on function public.boh_auto_order_preview(date) to authenticated;

-- stock list also shows MOQ
drop function if exists public.boh_stock_list(date);
create function public.boh_stock_list(p_date date default null)
returns table (product_id uuid, product_name text, brand text, unit text, category_name text, price numeric,
  method text, reorder_level numeric, target_level numeric, reorder_qty numeric, auto boolean,
  count_qty numeric, last_qty numeric, last_date date, moq numeric)
language plpgsql stable security definer set search_path = public as $$
declare r uuid := boh_my_restaurant(); d date := coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date);
begin
  if r is null then raise exception 'Only restaurant logins can do this'; end if;
  return query
  select pr.id, pr.name, pr.brand, pr.unit, c.name, boh_selling_price(r, pr.id),
         coalesce(ss.method, 'topup'), ss.reorder_level, ss.target_level, ss.reorder_qty, coalesce(ss.auto, false),
         (select sc.qty from boh_stock_counts sc where sc.restaurant_id = r and sc.product_id = pr.id and sc.count_date = d),
         l.qty, l.count_date, pr.moq
    from boh_restaurant_products rp
    join boh_products pr on pr.id = rp.product_id and pr.active
    join boh_categories c on c.id = pr.category_id
    left join boh_stock_settings ss on ss.restaurant_id = r and ss.product_id = pr.id
    left join lateral (select sc.qty, sc.count_date from boh_stock_counts sc where sc.restaurant_id = r and sc.product_id = pr.id and sc.count_date < d
                       order by sc.count_date desc limit 1) l on true
   where rp.restaurant_id = r and rp.active and boh_category_on(r, c.id)
   order by c.sort nulls last, c.name, pr.name;
end $$;
revoke execute on function public.boh_stock_list(date) from public, anon;
grant execute on function public.boh_stock_list(date) to authenticated;
