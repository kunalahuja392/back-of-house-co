-- 012: feature switches (super admin), restaurant stock + auto-order, vendor portal (POs + product offers),
--      online shop (listings, shoppers, shop orders), public website leads, self sign-up for vendors and shoppers.

-- =========================================================================== roles
alter table public.boh_users drop constraint if exists boh_users_role_check;
alter table public.boh_users add constraint boh_users_role_check
  check (role in ('super_admin','admin','coordinator','customer','vendor','shopper'));
alter table public.boh_users add column if not exists vendor_id uuid references public.boh_vendors(id) on delete set null;

alter table public.boh_vendors
  add column if not exists approval text not null default 'approved',
  add column if not exists signup_note text,
  add column if not exists approval_note text;
alter table public.boh_vendors drop constraint if exists boh_vendors_approval_check;
alter table public.boh_vendors add constraint boh_vendors_approval_check check (approval in ('pending','approved','rejected'));

create or replace function public.boh_my_vendor() returns uuid
language sql stable security definer set search_path = public as $$
  select vendor_id from public.boh_users where id = auth.uid() and active and role = 'vendor'
$$;
revoke execute on function public.boh_my_vendor() from public, anon;
grant execute on function public.boh_my_vendor() to authenticated;

-- internal staff/customer-only reads (vendors and shoppers use RPCs instead)
create or replace function public.boh_is_insider() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.boh_role() in ('super_admin','admin','coordinator','customer'), false)
$$;
revoke execute on function public.boh_is_insider() from public, anon;
grant execute on function public.boh_is_insider() to authenticated;

drop policy if exists boh_settings_read on public.boh_settings;
create policy boh_settings_read on public.boh_settings for select to authenticated using (boh_is_insider());
drop policy if exists boh_feat_read on public.boh_featured;
create policy boh_feat_read on public.boh_featured for select to authenticated using (boh_is_insider());
drop policy if exists boh_cat_read on public.boh_categories;
create policy boh_cat_read on public.boh_categories for select to authenticated using (boh_is_insider() or boh_role() = 'vendor');

-- products: b2b = shown to restaurants (catalogue / requests); shop-only products have b2b = false
alter table public.boh_products add column if not exists b2b boolean not null default true;
drop policy if exists boh_prod_read on public.boh_products;
create policy boh_prod_read on public.boh_products for select to authenticated
  using (boh_is_team() or (boh_role() = 'customer' and b2b));

-- vendors may read their own vendor row
drop policy if exists boh_vend_self on public.boh_vendors;
create policy boh_vend_self on public.boh_vendors for select to authenticated using (id = boh_my_vendor());

-- =========================================================================== notification helpers
create or replace function public.boh_notify_super(p_event text, p_subject text, p_body text, p_dedupe text default null)
returns void language plpgsql security definer set search_path = public as $$
declare u record;
begin
  for u in select id from boh_users where role = 'super_admin' and active loop
    perform boh_enqueue_user(u.id, p_event, p_subject, p_body, null, p_dedupe);
  end loop;
end $$;

create or replace function public.boh_notify_staff(p_event text, p_subject text, p_body text, p_dedupe text default null)
returns void language plpgsql security definer set search_path = public as $$
declare u record;
begin
  for u in select id from boh_users where role in ('admin','super_admin') and active loop
    perform boh_enqueue_user(u.id, p_event, p_subject, p_body, null, p_dedupe);
  end loop;
end $$;

create or replace function public.boh_notify_vendor(p_vendor uuid, p_event text, p_subject text, p_body text, p_order uuid default null, p_dedupe text default null)
returns void language plpgsql security definer set search_path = public as $$
declare u record;
begin
  for u in select id from boh_users where vendor_id = p_vendor and role = 'vendor' and active loop
    perform boh_enqueue_user(u.id, p_event, p_subject, p_body, p_order, p_dedupe);
  end loop;
end $$;
revoke execute on function public.boh_notify_super(text,text,text,text), public.boh_notify_staff(text,text,text,text),
  public.boh_notify_vendor(uuid,text,text,text,uuid,text) from public, anon, authenticated;

-- =========================================================================== feature switches
create table if not exists public.boh_feature_access (
  id uuid primary key default gen_random_uuid(),
  feature text not null check (feature in ('auto_order','vendor_orders','vendor_products')),
  restaurant_id uuid references public.boh_restaurants(id) on delete cascade,
  vendor_id uuid references public.boh_vendors(id) on delete cascade,
  status text not null default 'requested' check (status in ('requested','active','declined','off')),
  request_note text,
  decision_note text,
  requested_by uuid references public.boh_users(id),
  requested_at timestamptz,
  decided_by uuid references public.boh_users(id),
  decided_at timestamptz,
  check ((restaurant_id is not null) <> (vendor_id is not null)),
  check ((feature = 'auto_order') = (restaurant_id is not null))
);
create unique index if not exists boh_feature_access_uq on public.boh_feature_access
  (feature, coalesce(restaurant_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table public.boh_feature_access enable row level security;
drop policy if exists boh_fa_read on public.boh_feature_access;
create policy boh_fa_read on public.boh_feature_access for select to authenticated
  using (boh_is_staff() or restaurant_id = boh_my_restaurant() or vendor_id = boh_my_vendor());

create or replace function public.boh_has_feature(p_feature text, p_restaurant uuid, p_vendor uuid default null) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from boh_feature_access where feature = p_feature and status = 'active'
    and (restaurant_id = p_restaurant or vendor_id = p_vendor))
$$;
revoke execute on function public.boh_has_feature(text, uuid, uuid) from public, anon;
grant execute on function public.boh_has_feature(text, uuid, uuid) to authenticated;

create or replace function public.boh_request_feature(p_feature text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r uuid := boh_my_restaurant(); v uuid := boh_my_vendor(); cur boh_feature_access; who text; label text;
begin
  if p_feature = 'auto_order' then
    if r is null then raise exception 'Only restaurant logins can request this'; end if; v := null;
  elsif p_feature in ('vendor_orders','vendor_products') then
    if v is null then raise exception 'Only vendor logins can request this'; end if; r := null;
    if (select approval from boh_vendors where id = v) <> 'approved' then raise exception 'Your vendor account is waiting for approval'; end if;
  else raise exception 'Unknown feature'; end if;
  select * into cur from boh_feature_access where feature = p_feature and restaurant_id is not distinct from r and vendor_id is not distinct from v;
  if found and cur.status = 'active' then return; end if;
  if found then
    update boh_feature_access set status = 'requested', request_note = p_note, requested_by = auth.uid(), requested_at = now() where id = cur.id;
  else
    insert into boh_feature_access (feature, restaurant_id, vendor_id, status, request_note, requested_by, requested_at)
    values (p_feature, r, v, 'requested', p_note, auth.uid(), now());
  end if;
  who := coalesce((select name from boh_restaurants where id = r), (select name from boh_vendors where id = v));
  label := case p_feature when 'auto_order' then 'Stock & auto-order' when 'vendor_orders' then 'Vendor portal — orders' else 'Vendor portal — sell products' end;
  perform boh_notify_super('feature_request', 'Feature request: ' || label || ' — ' || who,
    '🔓 *Feature request* from ' || who || E'\nFeature: ' || label || coalesce(E'\nNote: ' || p_note, '') ||
    E'\nApprove in Settings → Feature access.', 'feat:' || p_feature || ':' || coalesce(r, v) || ':' || now()::date);
end $$;
revoke execute on function public.boh_request_feature(text, text) from public, anon;
grant execute on function public.boh_request_feature(text, text) to authenticated;

create or replace function public.boh_set_feature(p_feature text, p_restaurant uuid, p_vendor uuid, p_on boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare cur boh_feature_access; st text; label text; body text;
begin
  if coalesce(boh_role(), '') <> 'super_admin' then raise exception 'Only the super admin can switch features on or off'; end if;
  if p_feature = 'auto_order' then p_vendor := null; if p_restaurant is null then raise exception 'Pick a restaurant'; end if;
  elsif p_feature in ('vendor_orders','vendor_products') then p_restaurant := null; if p_vendor is null then raise exception 'Pick a vendor'; end if;
  else raise exception 'Unknown feature'; end if;
  select * into cur from boh_feature_access where feature = p_feature and restaurant_id is not distinct from p_restaurant and vendor_id is not distinct from p_vendor;
  st := case when p_on then 'active' when found and cur.status = 'requested' then 'declined' else 'off' end;
  if found then
    update boh_feature_access set status = st, decision_note = p_note, decided_by = auth.uid(), decided_at = now() where id = cur.id;
  else
    insert into boh_feature_access (feature, restaurant_id, vendor_id, status, decision_note, decided_by, decided_at)
    values (p_feature, p_restaurant, p_vendor, st, p_note, auth.uid(), now());
  end if;
  label := case p_feature when 'auto_order' then 'Stock & auto-order' when 'vendor_orders' then 'Vendor portal — orders' else 'Vendor portal — sell products' end;
  body := case st when 'active' then '✅ *' || label || '* is now switched on for you. Open the Back of House app to use it.'
                  when 'declined' then 'Your request for *' || label || '* was not approved this time.' || coalesce(E'\nNote: ' || p_note, '')
                  else '*' || label || '* has been switched off for your account.' end;
  if p_restaurant is not null then
    perform boh_notify_restaurant(p_restaurant, 'feature', label || ' — ' || st, body, null, 'featdec:' || p_feature || ':' || p_restaurant || ':' || st || ':' || now()::date);
  else
    perform boh_notify_vendor(p_vendor, 'feature', label || ' — ' || st, body, null, 'featdec:' || p_feature || ':' || p_vendor || ':' || st || ':' || now()::date);
  end if;
end $$;
revoke execute on function public.boh_set_feature(text, uuid, uuid, boolean, text) from public, anon;
grant execute on function public.boh_set_feature(text, uuid, uuid, boolean, text) to authenticated;

-- =========================================================================== orders: shared core + source
alter table public.boh_orders add column if not exists source text not null default 'manual';
alter table public.boh_orders drop constraint if exists boh_orders_source_check;
alter table public.boh_orders add constraint boh_orders_source_check check (source in ('manual','auto'));

create or replace function public.boh_place_order_core(p_rest uuid, p_user uuid, p_items jsonb, p_notes text, p_payment_mode text, p_source text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  s boh_settings; ist timestamp := (now() at time zone 'Asia/Kolkata');
  v_delivery date; v_order uuid; it jsonb; v_qty numeric; p record; v_margin numeric; v_price numeric;
  v_total numeric := 0; v_cost numeric := 0;
begin
  if p_rest is null then raise exception 'Only restaurant users can place orders'; end if;
  if p_payment_mode not in ('prepaid','cod') then raise exception 'Choose pre-pay or pay on delivery'; end if;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then raise exception 'Order is empty'; end if;
  select * into s from boh_settings where id = 1;
  v_delivery := case when ist::time < s.order_cutoff then ist::date + 1 else ist::date + 2 end;
  insert into boh_orders (restaurant_id, placed_by, delivery_date, notes, payment_mode, source)
  values (p_rest, p_user, v_delivery, p_notes, p_payment_mode, p_source) returning id into v_order;
  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := (it->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then continue; end if;
    select pr.id, pr.name, pr.unit, c.id as cat_id, c.name as cat, b.rate, b.vendor_id, b.vendor_name, b.delivery_style into p
      from boh_restaurant_products rp
      join boh_products pr on pr.id = rp.product_id and pr.active
      join boh_categories c on c.id = pr.category_id
      left join boh_product_best_rate b on b.product_id = pr.id
      where rp.restaurant_id = p_rest and rp.active and rp.product_id = (it->>'product_id')::uuid and boh_category_on(p_rest, c.id);
    if not found then raise exception 'Product % is not on your ordering list', it->>'product_id'; end if;
    if p.rate is null then raise exception '% has no active price yet — please contact us', p.name; end if;
    v_price := boh_selling_price(p_rest, p.id);
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
  insert into boh_order_events (order_id, event, note, actor) values (v_order, 'placed',
    case when p_source = 'auto' then 'Auto order · ' else '' end || case when p_payment_mode = 'prepaid' then 'Pre-pay' else 'Pay on delivery' end, p_user);
  return v_order;
end $$;
revoke execute on function public.boh_place_order_core(uuid, uuid, jsonb, text, text, text) from public, anon, authenticated;

create or replace function public.boh_place_order(p_items jsonb, p_notes text default null, p_payment_mode text default 'cod') returns uuid
language plpgsql security definer set search_path = public as $$
begin
  return boh_place_order_core(boh_my_restaurant(), auth.uid(), p_items, p_notes, p_payment_mode, 'manual');
end $$;

-- =========================================================================== stock & auto-order
create table if not exists public.boh_stock_settings (
  restaurant_id uuid not null references public.boh_restaurants(id) on delete cascade,
  product_id uuid not null references public.boh_products(id) on delete cascade,
  method text not null default 'topup' check (method in ('topup','fixed')),
  reorder_level numeric(12,3) not null default 0 check (reorder_level >= 0),
  target_level numeric(12,3) check (target_level is null or target_level >= 0),
  reorder_qty numeric(12,3) check (reorder_qty is null or reorder_qty > 0),
  auto boolean not null default true,
  updated_by uuid references public.boh_users(id),
  updated_at timestamptz not null default now(),
  primary key (restaurant_id, product_id)
);
create table if not exists public.boh_stock_counts (
  restaurant_id uuid not null references public.boh_restaurants(id) on delete cascade,
  product_id uuid not null references public.boh_products(id) on delete cascade,
  count_date date not null,
  qty numeric(12,3) not null check (qty >= 0),
  counted_by uuid references public.boh_users(id),
  counted_at timestamptz not null default now(),
  primary key (restaurant_id, product_id, count_date)
);
create table if not exists public.boh_auto_order_config (
  restaurant_id uuid primary key references public.boh_restaurants(id) on delete cascade,
  enabled boolean not null default false,
  order_time time not null default '22:00',
  payment_mode text not null default 'cod' check (payment_mode in ('prepaid','cod')),
  notes text,
  last_run_date date,
  last_result text,
  last_order_id uuid references public.boh_orders(id) on delete set null,
  updated_by uuid references public.boh_users(id),
  updated_at timestamptz not null default now()
);
alter table public.boh_stock_settings enable row level security;
alter table public.boh_stock_counts enable row level security;
alter table public.boh_auto_order_config enable row level security;
drop policy if exists boh_ss_read on public.boh_stock_settings;
create policy boh_ss_read on public.boh_stock_settings for select to authenticated using (boh_is_team() or restaurant_id = boh_my_restaurant());
drop policy if exists boh_sc_read on public.boh_stock_counts;
create policy boh_sc_read on public.boh_stock_counts for select to authenticated using (boh_is_team() or restaurant_id = boh_my_restaurant());
drop policy if exists boh_aoc_read on public.boh_auto_order_config;
create policy boh_aoc_read on public.boh_auto_order_config for select to authenticated using (boh_is_team() or restaurant_id = boh_my_restaurant());

create or replace function public.boh_need_auto(p_rest uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  if p_rest is null then raise exception 'Only restaurant logins can do this'; end if;
  if not boh_has_feature('auto_order', p_rest) then raise exception 'Stock & auto-order is not switched on for your restaurant — tap Request access'; end if;
  return p_rest;
end $$;
revoke execute on function public.boh_need_auto(uuid) from public, anon, authenticated;

-- one row per product on the restaurant's ordering list, with settings and recent counts
create or replace function public.boh_stock_list(p_date date default null)
returns table (product_id uuid, product_name text, brand text, unit text, category_name text, price numeric,
  method text, reorder_level numeric, target_level numeric, reorder_qty numeric, auto boolean,
  count_qty numeric, last_qty numeric, last_date date)
language plpgsql stable security definer set search_path = public as $$
declare r uuid := coalesce(boh_my_restaurant(), null); d date := coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date);
begin
  if r is null then raise exception 'Only restaurant logins can do this'; end if;
  return query
  select pr.id, pr.name, pr.brand, pr.unit, c.name, boh_selling_price(r, pr.id),
         coalesce(ss.method, 'topup'), ss.reorder_level, ss.target_level, ss.reorder_qty, coalesce(ss.auto, false),
         (select sc.qty from boh_stock_counts sc where sc.restaurant_id = r and sc.product_id = pr.id and sc.count_date = d),
         l.qty, l.count_date
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

create or replace function public.boh_save_stock_settings(p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare r uuid := boh_need_auto(boh_my_restaurant()); x jsonb; n int := 0; m text; rl numeric; tl numeric; rq numeric;
begin
  for x in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    if not exists (select 1 from boh_restaurant_products where restaurant_id = r and product_id = (x->>'product_id')::uuid and active) then
      raise exception 'Product is not on your ordering list'; end if;
    m := coalesce(nullif(x->>'method', ''), 'topup');
    rl := nullif(x->>'reorder_level', '')::numeric; tl := nullif(x->>'target_level', '')::numeric; rq := nullif(x->>'reorder_qty', '')::numeric;
    if coalesce((x->>'auto')::boolean, false) then
      if rl is null then raise exception 'Set the reorder level for every product marked auto'; end if;
      if m = 'topup' and (tl is null or tl <= rl) then raise exception 'Target level must be more than the reorder level (top-up method)'; end if;
      if m = 'fixed' and coalesce(rq, 0) <= 0 then raise exception 'Set the reorder quantity (fixed method)'; end if;
    end if;
    insert into boh_stock_settings (restaurant_id, product_id, method, reorder_level, target_level, reorder_qty, auto, updated_by, updated_at)
    values (r, (x->>'product_id')::uuid, m, coalesce(rl, 0), tl, rq, coalesce((x->>'auto')::boolean, false), auth.uid(), now())
    on conflict (restaurant_id, product_id) do update set method = excluded.method, reorder_level = excluded.reorder_level,
      target_level = excluded.target_level, reorder_qty = excluded.reorder_qty, auto = excluded.auto, updated_by = excluded.updated_by, updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.boh_save_stock_settings(jsonb) from public, anon;
grant execute on function public.boh_save_stock_settings(jsonb) to authenticated;

create or replace function public.boh_save_stock_count(p_rows jsonb, p_date date default null) returns int
language plpgsql security definer set search_path = public as $$
declare r uuid := boh_need_auto(boh_my_restaurant()); d date := coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date); x jsonb; n int := 0; q numeric;
begin
  if d > (now() at time zone 'Asia/Kolkata')::date then raise exception 'Cannot count stock for a future date'; end if;
  for x in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    q := nullif(x->>'qty', '')::numeric;
    if q is null then
      delete from boh_stock_counts where restaurant_id = r and product_id = (x->>'product_id')::uuid and count_date = d;
      continue;
    end if;
    if q < 0 then raise exception 'Stock cannot be negative'; end if;
    insert into boh_stock_counts (restaurant_id, product_id, count_date, qty, counted_by, counted_at)
    values (r, (x->>'product_id')::uuid, d, q, auth.uid(), now())
    on conflict (restaurant_id, product_id, count_date) do update set qty = excluded.qty, counted_by = excluded.counted_by, counted_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.boh_save_stock_count(jsonb, date) from public, anon;
grant execute on function public.boh_save_stock_count(jsonb, date) to authenticated;

create or replace function public.boh_save_auto_config(p_enabled boolean, p_time time, p_payment_mode text, p_notes text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r uuid := boh_need_auto(boh_my_restaurant());
begin
  if p_payment_mode not in ('prepaid','cod') then raise exception 'Choose pre-pay or pay on delivery'; end if;
  insert into boh_auto_order_config (restaurant_id, enabled, order_time, payment_mode, notes, updated_by, updated_at)
  values (r, p_enabled, coalesce(p_time, '22:00'), p_payment_mode, nullif(trim(p_notes), ''), auth.uid(), now())
  on conflict (restaurant_id) do update set enabled = excluded.enabled, order_time = excluded.order_time, payment_mode = excluded.payment_mode,
    notes = excluded.notes, updated_by = excluded.updated_by, updated_at = now();
end $$;
revoke execute on function public.boh_save_auto_config(boolean, time, text, text) from public, anon;
grant execute on function public.boh_save_auto_config(boolean, time, text, text) to authenticated;

-- lines the auto order would contain for a restaurant, based on the count of that day
create or replace function public.boh_auto_lines(p_rest uuid, p_date date)
returns table (product_id uuid, product_name text, unit text, stock numeric, reorder_level numeric, method text, order_qty numeric)
language sql stable security definer set search_path = public as $$
  select pr.id, pr.name, pr.unit, sc.qty, ss.reorder_level, ss.method,
         case when ss.method = 'fixed' then ss.reorder_qty else ss.target_level - sc.qty end
    from boh_stock_settings ss
    join boh_stock_counts sc on sc.restaurant_id = ss.restaurant_id and sc.product_id = ss.product_id and sc.count_date = p_date
    join boh_products pr on pr.id = ss.product_id and pr.active
    join boh_restaurant_products rp on rp.restaurant_id = ss.restaurant_id and rp.product_id = ss.product_id and rp.active
   where ss.restaurant_id = p_rest and ss.auto and sc.qty <= ss.reorder_level and boh_category_on(p_rest, pr.category_id)
     and (case when ss.method = 'fixed' then ss.reorder_qty else ss.target_level - sc.qty end) > 0
   order by pr.name
$$;
revoke execute on function public.boh_auto_lines(uuid, date) from public, anon, authenticated;

create or replace function public.boh_auto_order_preview(p_date date default null)
returns table (product_id uuid, product_name text, unit text, stock numeric, reorder_level numeric, method text, order_qty numeric, price numeric, line_total numeric)
language plpgsql stable security definer set search_path = public as $$
declare r uuid := boh_need_auto(boh_my_restaurant());
begin
  return query select l.*, boh_selling_price(r, l.product_id), round(boh_selling_price(r, l.product_id) * l.order_qty, 2)
    from boh_auto_lines(r, coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date)) l;
end $$;
revoke execute on function public.boh_auto_order_preview(date) from public, anon;
grant execute on function public.boh_auto_order_preview(date) to authenticated;

-- runs from cron every 5 minutes: places today's auto order for each restaurant once its order time has passed
create or replace function public.boh_run_auto_orders() returns int
language plpgsql security definer set search_path = public as $$
declare ist timestamp := now() at time zone 'Asia/Kolkata'; d date := ist::date; c record; items jsonb; o uuid; n int := 0; placer uuid; res text; ord boh_orders; cnt int;
begin
  for c in select a.*, rr.name rname from boh_auto_order_config a join boh_restaurants rr on rr.id = a.restaurant_id and rr.active
     where a.enabled and ist::time >= a.order_time and (a.last_run_date is null or a.last_run_date < d)
       and boh_has_feature('auto_order', a.restaurant_id) loop
    begin
      select count(*) into cnt from boh_stock_counts where restaurant_id = c.restaurant_id and count_date = d;
      placer := coalesce((select id from boh_users where id = c.updated_by and role = 'customer' and active and restaurant_id = c.restaurant_id),
                         (select id from boh_users where role = 'customer' and active and restaurant_id = c.restaurant_id order by created_at limit 1));
      if cnt = 0 then
        res := 'No stock count for today — auto order not placed';
        perform boh_notify_restaurant(c.restaurant_id, 'auto_order', 'Auto order skipped — no stock count',
          '⚠️ *Auto order skipped* for ' || c.rname || E'\nNo end-of-day stock count was saved for today. Count stock in the app (Stock & auto-order) and place the order manually if needed.',
          null, 'autoskip:' || c.restaurant_id || ':' || d);
      else
        select jsonb_agg(jsonb_build_object('product_id', l.product_id, 'qty', l.order_qty)) into items from boh_auto_lines(c.restaurant_id, d) l;
        if items is null then
          res := 'Stock is above reorder levels — nothing to order';
        elsif placer is null then
          res := 'No active restaurant login to place the order';
        else
          o := boh_place_order_core(c.restaurant_id, placer, items, coalesce(c.notes, 'Auto order from end-of-day stock'), c.payment_mode, 'auto');
          select * into ord from boh_orders where id = o;
          res := 'Placed order #' || ord.order_no || ' · ' || jsonb_array_length(items) || ' items · ' || boh_inr(ord.total);
          n := n + 1;
        end if;
      end if;
      update boh_auto_order_config set last_run_date = d, last_result = res, last_order_id = coalesce(o, last_order_id) where restaurant_id = c.restaurant_id;
    exception when others then
      update boh_auto_order_config set last_run_date = d, last_result = 'Failed: ' || sqlerrm where restaurant_id = c.restaurant_id;
      perform boh_notify_restaurant(c.restaurant_id, 'auto_order', 'Auto order failed',
        '⚠️ *Auto order could not be placed* for ' || c.rname || E'\nReason: ' || sqlerrm || E'\nPlease place today''s order manually.', null, 'autofail:' || c.restaurant_id || ':' || d);
    end;
    o := null;
  end loop;
  return n;
end $$;
revoke execute on function public.boh_run_auto_orders() from public, anon, authenticated;

-- =========================================================================== vendor purchase orders (portal)
create table if not exists public.boh_vendor_pos (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.boh_vendors(id) on delete cascade,
  order_id uuid references public.boh_orders(id) on delete cascade,
  shop_order_id uuid,
  status text not null default 'sent' check (status in ('sent','accepted','rejected','dispatched','delivered','cancelled')),
  note text,
  sent_at timestamptz not null default now(),
  accepted_at timestamptz, dispatched_at timestamptz, delivered_at timestamptz, updated_at timestamptz not null default now(),
  check ((order_id is not null) <> (shop_order_id is not null))
);
create unique index if not exists boh_vendor_pos_ord on public.boh_vendor_pos(vendor_id, order_id) where order_id is not null;
create unique index if not exists boh_vendor_pos_shop on public.boh_vendor_pos(vendor_id, shop_order_id) where shop_order_id is not null;
alter table public.boh_vendor_pos enable row level security;
drop policy if exists boh_po_read on public.boh_vendor_pos;
create policy boh_po_read on public.boh_vendor_pos for select to authenticated
  using (boh_is_staff() or vendor_id = boh_my_vendor() or (order_id is not null and boh_on_order(order_id)));

-- create / cancel POs so they match the vendors on an order (only vendors with the portal switched on)
create or replace function public.boh_sync_vendor_pos(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o boh_orders; v record; r boh_restaurants; lines text; co boh_users;
begin
  select * into o from boh_orders where id = p_order;
  if not found then return; end if;
  if o.status = 'cancelled' then
    update boh_vendor_pos set status = 'cancelled', updated_at = now() where order_id = p_order and status not in ('delivered','cancelled');
    return;
  end if;
  if o.status not in ('acknowledged','vendor_ordered','followup1','followup2') then return; end if;
  select * into r from boh_restaurants where id = o.restaurant_id;
  select * into co from boh_users where id = o.coordinator_id;
  -- vendors no longer on the order
  update boh_vendor_pos p set status = 'cancelled', note = coalesce(p.note || ' · ', '') || 'Items moved to another vendor', updated_at = now()
   where p.order_id = p_order and p.status in ('sent','accepted')
     and not exists (select 1 from boh_order_items i where i.order_id = p_order and i.vendor_id = p.vendor_id);
  for v in select distinct i.vendor_id, i.delivery_style from boh_order_items i
            where i.order_id = p_order and i.vendor_id is not null and boh_has_feature('vendor_orders', null, i.vendor_id) loop
    if exists (select 1 from boh_vendor_pos where vendor_id = v.vendor_id and order_id = p_order and status <> 'cancelled') then continue; end if;
    if exists (select 1 from boh_vendor_pos where vendor_id = v.vendor_id and order_id = p_order) then
      update boh_vendor_pos set status = 'sent', sent_at = now(), accepted_at = null, dispatched_at = null, delivered_at = null, updated_at = now()
       where vendor_id = v.vendor_id and order_id = p_order;
    else
      insert into boh_vendor_pos (vendor_id, order_id) values (v.vendor_id, p_order);
    end if;
    select string_agg('• ' || i.product_name || ' — ' || trim(to_char(i.qty, 'FM999999990.###')) || ' ' || coalesce(i.unit, '') || ' @ ' || boh_inr(i.unit_cost), E'\n' order by i.product_name)
      into lines from boh_order_items i where i.order_id = p_order and i.vendor_id = v.vendor_id;
    perform boh_notify_vendor(v.vendor_id, 'vendor_po', 'New order from Back of House Co — #' || o.order_no,
      '📦 *New order #' || o.order_no || '* from Back of House Co' || E'\nDelivery: ' || to_char(o.delivery_date, 'Dy DD Mon') ||
      case when v.delivery_style = 'vendor_delivers' then E'\nDeliver to: ' || r.name || coalesce(', ' || r.address, '') else E'\nOur porter will pick up.' end ||
      E'\n\n' || coalesce(lines, '') || coalesce(E'\n\nCoordinator: ' || co.full_name || coalesce(' · ' || co.phone, ''), '') ||
      E'\n\nPlease accept it in the vendor portal.', p_order, 'po:' || p_order || ':' || v.vendor_id || ':' || now()::date);
  end loop;
end $$;
revoke execute on function public.boh_sync_vendor_pos(uuid) from public, anon, authenticated;

create or replace function public.boh_tr_po_sync_order() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'boh_orders' then
    if new.status is distinct from old.status then perform boh_sync_vendor_pos(new.id); end if;
  else
    if new.vendor_id is distinct from old.vendor_id then perform boh_sync_vendor_pos(new.order_id); end if;
  end if;
  return new;
end $$;
drop trigger if exists boh_tr_po_sync_order on public.boh_orders;
create trigger boh_tr_po_sync_order after update of status on public.boh_orders for each row execute function public.boh_tr_po_sync_order();
drop trigger if exists boh_tr_po_sync_items on public.boh_order_items;
create trigger boh_tr_po_sync_items after update of vendor_id on public.boh_order_items for each row execute function public.boh_tr_po_sync_order();

-- =========================================================================== shop
alter table public.boh_settings
  add column if not exists shop_enabled boolean not null default false,
  add column if not exists shop_delivery_fee numeric(12,2) not null default 0,
  add column if not exists shop_free_above numeric(12,2),
  add column if not exists shop_min_order numeric(12,2) not null default 0,
  add column if not exists shop_area text,
  add column if not exists site_phone text,
  add column if not exists site_email text,
  add column if not exists site_whatsapp text,
  add column if not exists site_address text;

create table if not exists public.boh_shop_listings (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null unique references public.boh_products(id) on delete cascade,
  title text not null check (length(trim(title)) >= 3),
  description text not null check (length(trim(description)) >= 20),
  images text[] not null check (coalesce(array_length(images, 1), 0) >= 1),
  price numeric(12,2) not null check (price > 0),
  mrp numeric(12,2),
  unit_label text,
  min_qty numeric(12,3) not null default 1 check (min_qty > 0),
  active boolean not null default true,
  featured boolean not null default false,
  sort int not null default 0,
  updated_by uuid references public.boh_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.boh_shop_listings enable row level security;
drop policy if exists boh_sl_staff on public.boh_shop_listings;
create policy boh_sl_staff on public.boh_shop_listings for all to authenticated using (boh_is_staff()) with check (boh_is_staff());

-- price must never be below our lowest active vendor rate
create or replace function public.boh_check_shop_listing() returns trigger
language plpgsql security definer set search_path = public as $$
declare b numeric;
begin
  if new.mrp is not null and new.mrp < new.price then raise exception 'MRP cannot be lower than the selling price'; end if;
  select rate into b from boh_product_best_rate where product_id = new.product_id;
  if new.active then
    if b is null then raise exception 'This product has no active vendor rate — add a vendor rate before selling it online'; end if;
    if new.price < b then raise exception 'Price % is below our lowest vendor rate % — not allowed', boh_inr(new.price), boh_inr(b); end if;
  elsif b is not null and new.price < b then
    raise exception 'Price % is below our lowest vendor rate % — not allowed', boh_inr(new.price), boh_inr(b);
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists boh_tr_check_shop_listing on public.boh_shop_listings;
create trigger boh_tr_check_shop_listing before insert or update on public.boh_shop_listings for each row execute function public.boh_check_shop_listing();

create table if not exists public.boh_shoppers (
  user_id uuid primary key references public.boh_users(id) on delete cascade,
  full_name text, phone text, email text, business_name text, gstin text,
  address text, city text, pincode text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.boh_shoppers enable row level security;
drop policy if exists boh_shopper_read on public.boh_shoppers;
create policy boh_shopper_read on public.boh_shoppers for select to authenticated using (user_id = auth.uid() or boh_is_staff());

create sequence if not exists public.boh_shop_order_no start 5001;
create table if not exists public.boh_shop_orders (
  id uuid primary key default gen_random_uuid(),
  order_no bigint not null unique default nextval('public.boh_shop_order_no'),
  user_id uuid not null references public.boh_users(id),
  ship_name text not null, ship_phone text not null, ship_email text,
  ship_address text not null, ship_city text, ship_pincode text, business_name text, gstin text, notes text,
  payment_mode text not null check (payment_mode in ('upi','cod')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','under_review','paid')),
  payment_ref text, payment_method text, payment_claimed_at timestamptz, payment_confirmed_by uuid references public.boh_users(id),
  payment_confirmed_at timestamptz, payment_rejected_note text,
  status text not null default 'placed' check (status in ('placed','confirmed','dispatched','delivered','cancelled')),
  subtotal numeric(12,2) not null default 0, delivery_fee numeric(12,2) not null default 0, total numeric(12,2) not null default 0,
  cost_total numeric(12,2) not null default 0,
  confirmed_at timestamptz, dispatched_at timestamptz, delivered_at timestamptz, cancelled_at timestamptz, staff_note text,
  created_at timestamptz not null default now()
);
create table if not exists public.boh_shop_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.boh_shop_orders(id) on delete cascade,
  listing_id uuid references public.boh_shop_listings(id) on delete set null,
  product_id uuid references public.boh_products(id),
  title text not null, unit text, qty numeric(12,3) not null check (qty > 0),
  price numeric(12,2) not null, line_total numeric(12,2) not null,
  unit_cost numeric(12,2), vendor_id uuid references public.boh_vendors(id), vendor_name text, delivery_style text
);
alter table public.boh_vendor_pos drop constraint if exists boh_vendor_pos_shop_fk;
alter table public.boh_vendor_pos add constraint boh_vendor_pos_shop_fk foreign key (shop_order_id) references public.boh_shop_orders(id) on delete cascade;
alter table public.boh_shop_orders enable row level security;
alter table public.boh_shop_order_items enable row level security;
drop policy if exists boh_so_read on public.boh_shop_orders;
create policy boh_so_read on public.boh_shop_orders for select to authenticated using (user_id = auth.uid() or boh_is_staff());
drop policy if exists boh_soi_read on public.boh_shop_order_items;
create policy boh_soi_read on public.boh_shop_order_items for select to authenticated
  using (boh_is_staff() or exists (select 1 from boh_shop_orders o where o.id = order_id and o.user_id = auth.uid()));

-- public (no login) shop catalogue
create or replace function public.boh_shop_catalog()
returns table (id uuid, product_id uuid, title text, description text, images text[], price numeric, mrp numeric, unit text,
  category text, min_qty numeric, featured boolean, brand text)
language sql stable security definer set search_path = public as $$
  select l.id, l.product_id, l.title, l.description, l.images, l.price, l.mrp, coalesce(l.unit_label, p.unit), c.name, l.min_qty, l.featured, p.brand
    from boh_shop_listings l
    join boh_products p on p.id = l.product_id and p.active
    join boh_categories c on c.id = p.category_id
    join boh_product_best_rate b on b.product_id = l.product_id
   where l.active and (select shop_enabled from boh_settings where id = 1)
   order by l.featured desc, l.sort, l.title
$$;
grant execute on function public.boh_shop_catalog() to anon, authenticated;

-- public website info (no login)
create or replace function public.boh_site_info() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('company_name', company_name, 'phone', site_phone, 'email', site_email, 'whatsapp', site_whatsapp,
    'address', site_address, 'shop_enabled', shop_enabled, 'delivery_fee', shop_delivery_fee, 'free_above', shop_free_above,
    'min_order', shop_min_order, 'shop_area', shop_area, 'order_cutoff', order_cutoff)
  from boh_settings where id = 1
$$;
grant execute on function public.boh_site_info() to anon, authenticated;

-- payment details for logged-in buyers / vendors (QR, UPI, bank)
create or replace function public.boh_pay_info() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('qr', pay_qr_url, 'upi', pay_upi_id, 'bank_name', bank_name, 'account_name', bank_account_name,
    'account_no', bank_account_no, 'ifsc', bank_ifsc, 'branch', bank_branch, 'company_name', company_name)
  from boh_settings where id = 1 and auth.uid() is not null
$$;
revoke execute on function public.boh_pay_info() from public, anon;
grant execute on function public.boh_pay_info() to authenticated;

create or replace function public.boh_save_shopper(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if boh_role() is null then raise exception 'Please sign in'; end if;
  insert into boh_shoppers (user_id, full_name, phone, email, business_name, gstin, address, city, pincode)
  values (auth.uid(), nullif(trim(p->>'full_name'), ''), nullif(trim(p->>'phone'), ''), (select email from boh_users where id = auth.uid()),
          nullif(trim(p->>'business_name'), ''), nullif(trim(p->>'gstin'), ''), nullif(trim(p->>'address'), ''), nullif(trim(p->>'city'), ''), nullif(trim(p->>'pincode'), ''))
  on conflict (user_id) do update set full_name = coalesce(excluded.full_name, boh_shoppers.full_name), phone = coalesce(excluded.phone, boh_shoppers.phone),
    business_name = excluded.business_name, gstin = excluded.gstin, address = coalesce(excluded.address, boh_shoppers.address),
    city = coalesce(excluded.city, boh_shoppers.city), pincode = coalesce(excluded.pincode, boh_shoppers.pincode), updated_at = now();
  update boh_users set full_name = coalesce(nullif(trim(p->>'full_name'), ''), full_name), phone = coalesce(nullif(trim(p->>'phone'), ''), phone)
   where id = auth.uid() and role = 'shopper';
end $$;
revoke execute on function public.boh_save_shopper(jsonb) from public, anon;
grant execute on function public.boh_save_shopper(jsonb) to authenticated;

create or replace function public.boh_shop_place_order(p_items jsonb, p_ship jsonb, p_payment_mode text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s boh_settings; o boh_shop_orders; it jsonb; l record; q numeric; sub numeric := 0; cost numeric := 0; fee numeric; n int := 0; lines text;
begin
  if boh_role() is null then raise exception 'Please sign in to place an order'; end if;
  select * into s from boh_settings where id = 1;
  if not s.shop_enabled then raise exception 'The online shop is closed right now'; end if;
  if p_payment_mode not in ('upi','cod') then raise exception 'Choose UPI / bank transfer or cash on delivery'; end if;
  if coalesce(trim(p_ship->>'name'), '') = '' or coalesce(trim(p_ship->>'phone'), '') = '' or coalesce(trim(p_ship->>'address'), '') = '' then
    raise exception 'Enter name, phone and delivery address'; end if;
  if length(regexp_replace(p_ship->>'phone', '\D', '', 'g')) < 10 then raise exception 'Enter a valid phone number'; end if;
  if jsonb_array_length(coalesce(p_items, '[]')) = 0 then raise exception 'Your cart is empty'; end if;
  insert into boh_shop_orders (user_id, ship_name, ship_phone, ship_email, ship_address, ship_city, ship_pincode, business_name, gstin, notes, payment_mode)
  values (auth.uid(), trim(p_ship->>'name'), trim(p_ship->>'phone'), (select email from boh_users where id = auth.uid()), trim(p_ship->>'address'),
          nullif(trim(p_ship->>'city'), ''), nullif(trim(p_ship->>'pincode'), ''), nullif(trim(p_ship->>'business_name'), ''), nullif(trim(p_ship->>'gstin'), ''),
          nullif(trim(p_ship->>'notes'), ''), p_payment_mode)
  returning * into o;
  for it in select * from jsonb_array_elements(p_items) loop
    q := (it->>'qty')::numeric;
    if q is null or q <= 0 then continue; end if;
    select sl.id, sl.title, sl.price, sl.min_qty, coalesce(sl.unit_label, p.unit) unit, p.id pid, b.rate, b.vendor_id, b.vendor_name, b.delivery_style into l
      from boh_shop_listings sl join boh_products p on p.id = sl.product_id and p.active
      join boh_product_best_rate b on b.product_id = sl.product_id
     where sl.id = (it->>'listing_id')::uuid and sl.active;
    if not found then raise exception 'An item in your cart is no longer available — please refresh the shop'; end if;
    if q < l.min_qty then raise exception 'Minimum quantity for % is %', l.title, l.min_qty; end if;
    insert into boh_shop_order_items (order_id, listing_id, product_id, title, unit, qty, price, line_total, unit_cost, vendor_id, vendor_name, delivery_style)
    values (o.id, l.id, l.pid, l.title, l.unit, q, l.price, round(l.price * q, 2), l.rate, l.vendor_id, l.vendor_name, l.delivery_style);
    sub := sub + round(l.price * q, 2); cost := cost + round(l.rate * q, 2); n := n + 1;
  end loop;
  if n = 0 then raise exception 'Your cart is empty'; end if;
  if sub < s.shop_min_order then raise exception 'Minimum order value is %', boh_inr(s.shop_min_order); end if;
  fee := case when s.shop_free_above is not null and sub >= s.shop_free_above then 0 else s.shop_delivery_fee end;
  update boh_shop_orders set subtotal = sub, delivery_fee = fee, total = sub + fee, cost_total = cost where id = o.id returning * into o;
  perform boh_save_shopper(jsonb_build_object('full_name', p_ship->>'name', 'phone', p_ship->>'phone', 'address', p_ship->>'address',
    'city', p_ship->>'city', 'pincode', p_ship->>'pincode', 'business_name', p_ship->>'business_name', 'gstin', p_ship->>'gstin'));
  select string_agg('• ' || title || ' × ' || trim(to_char(qty, 'FM999999990.###')) || ' — ' || boh_inr(line_total), E'\n') into lines from boh_shop_order_items where order_id = o.id;
  perform boh_enqueue_user(auth.uid(), 'shop_placed', 'Order W' || o.order_no || ' received — Back of House Co',
    '✅ *Order W' || o.order_no || ' received*' || E'\n' || lines || E'\nTotal: ' || boh_inr(o.total) ||
    case when p_payment_mode = 'upi' then E'\n\nPlease pay by UPI / bank transfer and tap “I''ve paid” in My orders.' else E'\n\nPay cash on delivery.' end ||
    E'\n— ' || s.company_name, null, 'shopplaced:' || o.id);
  perform boh_notify_staff('shop_new', 'New shop order W' || o.order_no || ' — ' || boh_inr(o.total),
    '🛒 *New shop order W' || o.order_no || '* · ' || boh_inr(o.total) || ' · ' || case when p_payment_mode = 'upi' then 'UPI / bank' else 'Cash on delivery' end ||
    E'\n' || o.ship_name || ' · ' || o.ship_phone || E'\n' || o.ship_address || coalesce(', ' || o.ship_city, '') || E'\n\n' || lines ||
    E'\n\nConfirm it in Shop → Orders.', 'shopnew:' || o.id);
  return jsonb_build_object('id', o.id, 'order_no', o.order_no, 'total', o.total);
end $$;
revoke execute on function public.boh_shop_place_order(jsonb, jsonb, text) from public, anon;
grant execute on function public.boh_shop_place_order(jsonb, jsonb, text) to authenticated;

create or replace function public.boh_shop_claim_payment(p_order uuid, p_ref text, p_method text default null) returns void
language plpgsql security definer set search_path = public as $$
declare o boh_shop_orders;
begin
  select * into o from boh_shop_orders where id = p_order and user_id = auth.uid() for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status = 'cancelled' then raise exception 'This order is cancelled'; end if;
  if o.payment_status = 'paid' then raise exception 'Already marked paid'; end if;
  if coalesce(trim(p_ref), '') = '' then raise exception 'Enter the UPI / bank reference number'; end if;
  update boh_shop_orders set payment_status = 'under_review', payment_ref = trim(p_ref), payment_method = p_method, payment_claimed_at = now(), payment_rejected_note = null
   where id = p_order;
  perform boh_notify_staff('shop_pay', 'Payment to verify — shop order W' || o.order_no,
    '💰 Shop order W' || o.order_no || ': buyer says paid ' || boh_inr(o.total) || coalesce(' via ' || p_method, '') || ' · ref ' || trim(p_ref) || E'\nVerify in Shop → Orders.',
    'shoppay:' || o.id || ':' || trim(p_ref));
end $$;
revoke execute on function public.boh_shop_claim_payment(uuid, text, text) from public, anon;
grant execute on function public.boh_shop_claim_payment(uuid, text, text) to authenticated;

create or replace function public.boh_shop_update(p_order uuid, p_action text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare o boh_shop_orders; s boh_settings; msg text; v record; lines text;
begin
  if not boh_is_staff() then raise exception 'Only admins can update shop orders'; end if;
  select * into o from boh_shop_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  select * into s from boh_settings where id = 1;
  if p_action = 'confirm' then
    if o.status <> 'placed' then raise exception 'Order is already %', o.status; end if;
    update boh_shop_orders set status = 'confirmed', confirmed_at = now(), staff_note = coalesce(p_note, staff_note) where id = p_order;
    msg := '👍 Order W' || o.order_no || ' is confirmed. We''ll let you know when it''s dispatched.';
    -- purchase orders to portal vendors
    for v in select distinct vendor_id, delivery_style from boh_shop_order_items where order_id = p_order and vendor_id is not null
              and boh_has_feature('vendor_orders', null, vendor_id) loop
      insert into boh_vendor_pos (vendor_id, shop_order_id) values (v.vendor_id, p_order) on conflict do nothing;
      select string_agg('• ' || title || ' — ' || trim(to_char(qty, 'FM999999990.###')) || ' ' || coalesce(unit, '') || ' @ ' || boh_inr(unit_cost), E'\n') into lines
        from boh_shop_order_items where order_id = p_order and vendor_id = v.vendor_id;
      perform boh_notify_vendor(v.vendor_id, 'vendor_po', 'New order from Back of House Co — W' || o.order_no,
        '📦 *New order W' || o.order_no || '* from Back of House Co' ||
        case when v.delivery_style = 'vendor_delivers' then E'\nDeliver to: ' || o.ship_name || ', ' || o.ship_address || coalesce(', ' || o.ship_city, '') || ' · ' || o.ship_phone
             else E'\nOur porter will pick up.' end || E'\n\n' || coalesce(lines, '') || E'\n\nPlease accept it in the vendor portal.', null, 'shoppo:' || p_order || ':' || v.vendor_id);
    end loop;
  elsif p_action = 'dispatch' then
    if o.status not in ('placed','confirmed') then raise exception 'Order is already %', o.status; end if;
    update boh_shop_orders set status = 'dispatched', dispatched_at = now(), confirmed_at = coalesce(confirmed_at, now()), staff_note = coalesce(p_note, staff_note) where id = p_order;
    msg := '🚚 Order W' || o.order_no || ' is on the way.' || coalesce(E'\n' || p_note, '');
  elsif p_action = 'deliver' then
    if o.status in ('delivered','cancelled') then raise exception 'Order is already %', o.status; end if;
    update boh_shop_orders set status = 'delivered', delivered_at = now(), staff_note = coalesce(p_note, staff_note) where id = p_order;
    msg := '📦 Order W' || o.order_no || ' delivered. Thank you!' ||
      case when o.payment_status <> 'paid' then E'\nAmount due: ' || boh_inr(o.total) else '' end;
  elsif p_action = 'cancel' then
    if o.status = 'delivered' then raise exception 'Delivered orders cannot be cancelled'; end if;
    update boh_shop_orders set status = 'cancelled', cancelled_at = now(), staff_note = coalesce(p_note, staff_note) where id = p_order;
    update boh_vendor_pos set status = 'cancelled', updated_at = now() where shop_order_id = p_order and status not in ('delivered','cancelled');
    msg := 'Order W' || o.order_no || ' has been cancelled.' || coalesce(E'\nReason: ' || p_note, '');
  elsif p_action = 'paid' then
    update boh_shop_orders set payment_status = 'paid', payment_confirmed_by = auth.uid(), payment_confirmed_at = now(), payment_rejected_note = null where id = p_order;
    msg := '✅ Payment received for order W' || o.order_no || ' — ' || boh_inr(o.total) || '. Thank you!';
  elsif p_action = 'reject_payment' then
    if o.payment_status <> 'under_review' then raise exception 'There is no payment to reject'; end if;
    update boh_shop_orders set payment_status = 'unpaid', payment_rejected_note = coalesce(nullif(trim(p_note), ''), 'Payment not found') where id = p_order;
    msg := '⚠️ We could not find your payment for order W' || o.order_no || '. ' || coalesce(nullif(trim(p_note), ''), 'Please check and try again.');
  else raise exception 'Unknown action';
  end if;
  perform boh_enqueue_user(o.user_id, 'shop_' || p_action, 'Order W' || o.order_no || ' — update', msg || E'\n— ' || s.company_name, null,
    'shop:' || p_action || ':' || o.id || ':' || now());
end $$;
revoke execute on function public.boh_shop_update(uuid, text, text) from public, anon;
grant execute on function public.boh_shop_update(uuid, text, text) to authenticated;

-- =========================================================================== vendor portal RPCs
create or replace function public.boh_vendor_po_list(p_open_only boolean default true) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v uuid := boh_my_vendor();
begin
  if v is null then raise exception 'Vendor login only'; end if;
  return coalesce((
    select jsonb_agg(x order by x->>'sent_at' desc) from (
      select jsonb_build_object(
        'id', p.id, 'status', p.status, 'note', p.note, 'sent_at', p.sent_at, 'accepted_at', p.accepted_at, 'dispatched_at', p.dispatched_at, 'delivered_at', p.delivered_at,
        'kind', case when p.order_id is not null then 'restaurant' else 'shop' end,
        'ref', case when p.order_id is not null then '#' || o.order_no else 'W' || so.order_no end,
        'delivery_date', o.delivery_date,
        'deliver', case when p.order_id is not null then
            case when (select bool_or(i.delivery_style = 'vendor_delivers') from boh_order_items i where i.order_id = p.order_id and i.vendor_id = v)
                 then jsonb_build_object('name', r.name, 'address', r.address, 'phone', r.phone) end
          else case when (select bool_or(i.delivery_style = 'vendor_delivers') from boh_shop_order_items i where i.order_id = p.shop_order_id and i.vendor_id = v)
                 then jsonb_build_object('name', so.ship_name, 'address', concat_ws(', ', so.ship_address, so.ship_city, so.ship_pincode), 'phone', so.ship_phone) end end,
        'coordinator', case when co.id is not null then jsonb_build_object('name', co.full_name, 'phone', co.phone) end,
        'items', case when p.order_id is not null then
            (select jsonb_agg(jsonb_build_object('name', i.product_name, 'qty', i.qty, 'unit', i.unit, 'rate', i.unit_cost, 'total', round(i.unit_cost * i.qty, 2)) order by i.product_name)
               from boh_order_items i where i.order_id = p.order_id and i.vendor_id = v)
          else (select jsonb_agg(jsonb_build_object('name', i.title, 'qty', i.qty, 'unit', i.unit, 'rate', i.unit_cost, 'total', round(i.unit_cost * i.qty, 2)) order by i.title)
               from boh_shop_order_items i where i.order_id = p.shop_order_id and i.vendor_id = v) end
      ) x
      from boh_vendor_pos p
      left join boh_orders o on o.id = p.order_id
      left join boh_restaurants r on r.id = o.restaurant_id
      left join boh_users co on co.id = o.coordinator_id
      left join boh_shop_orders so on so.id = p.shop_order_id
      where p.vendor_id = v and (not p_open_only or p.status in ('sent','accepted','dispatched'))
        and (p_open_only or p.sent_at > now() - interval '90 days')
    ) t), '[]'::jsonb);
end $$;
revoke execute on function public.boh_vendor_po_list(boolean) from public, anon;
grant execute on function public.boh_vendor_po_list(boolean) to authenticated;

create or replace function public.boh_vendor_po_update(p_po uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v uuid := boh_my_vendor(); p boh_vendor_pos; vname text; ref text; o boh_orders;
begin
  if v is null then raise exception 'Vendor login only'; end if;
  if not boh_has_feature('vendor_orders', null, v) then raise exception 'Orders in the vendor portal are not switched on for you'; end if;
  select * into p from boh_vendor_pos where id = p_po and vendor_id = v for update;
  if not found then raise exception 'Order not found'; end if;
  if not ((p.status = 'sent' and p_status in ('accepted','rejected')) or (p.status = 'accepted' and p_status in ('dispatched','delivered','rejected'))
          or (p.status = 'dispatched' and p_status = 'delivered')) then
    raise exception 'Cannot change from % to %', p.status, p_status;
  end if;
  if p_status = 'rejected' and coalesce(trim(p_note), '') = '' then raise exception 'Tell us why you cannot supply this order'; end if;
  update boh_vendor_pos set status = p_status, note = coalesce(nullif(trim(p_note), ''), note), updated_at = now(),
    accepted_at = case when p_status = 'accepted' then now() else accepted_at end,
    dispatched_at = case when p_status = 'dispatched' then now() else dispatched_at end,
    delivered_at = case when p_status = 'delivered' then now() else delivered_at end
   where id = p_po;
  select name into vname from boh_vendors where id = v;
  if p.order_id is not null then
    select * into o from boh_orders where id = p.order_id;
    ref := '#' || o.order_no;
    insert into boh_order_events (order_id, event, note, actor) values (p.order_id, 'vendor_po', vname || ': ' || p_status || coalesce(' · ' || nullif(trim(p_note), ''), ''), auth.uid());
    if p_status in ('rejected','delivered','dispatched') then
      perform boh_notify_coordinators(p.order_id, 'vendor_po', 'Vendor ' || p_status || ': order ' || ref,
        case when p_status = 'rejected' then '⛔ *' || vname || ' rejected* order ' || ref || coalesce(E'\nReason: ' || p_note, '') || E'\nOpen the order → Change vendor.'
             else '📦 ' || vname || ' marked order ' || ref || ' as *' || p_status || '*.' end, 'vpo:' || p_po || ':' || p_status);
    end if;
  else
    select 'W' || order_no into ref from boh_shop_orders where id = p.shop_order_id;
    perform boh_notify_staff('vendor_po', 'Vendor ' || p_status || ': shop order ' || ref,
      '📦 ' || vname || ' marked shop order ' || ref || ' as *' || p_status || '*' || coalesce(E'\nNote: ' || p_note, ''), 'vpo:' || p_po || ':' || p_status);
  end if;
end $$;
revoke execute on function public.boh_vendor_po_update(uuid, text, text) from public, anon;
grant execute on function public.boh_vendor_po_update(uuid, text, text) to authenticated;

-- the vendor's own rates (never other vendors' rates); is_best tells them whether they are currently our cheapest
create or replace function public.boh_vendor_my_rates() returns table (product_id uuid, product_name text, unit text, category text, rate numeric, active boolean, is_best boolean, updated_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare v uuid := boh_my_vendor();
begin
  if v is null then raise exception 'Vendor login only'; end if;
  return query select p.id, p.name, p.unit, c.name, r.rate, r.active, coalesce(b.vendor_id = v, false), r.updated_at
    from boh_vendor_rates r join boh_products p on p.id = r.product_id join boh_categories c on c.id = p.category_id
    left join boh_product_best_rate b on b.product_id = p.id
   where r.vendor_id = v order by c.name, p.name;
end $$;
revoke execute on function public.boh_vendor_my_rates() from public, anon;
grant execute on function public.boh_vendor_my_rates() to authenticated;

-- products / rate changes offered by vendors
create table if not exists public.boh_vendor_offers (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.boh_vendors(id) on delete cascade,
  product_id uuid references public.boh_products(id) on delete set null,
  name text not null, category_id uuid references public.boh_categories(id), unit text not null, brand text,
  description text, image_url text, rate numeric(12,2) not null check (rate > 0), min_qty numeric(12,3),
  for_clients boolean not null default true, for_shop boolean not null default false,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  admin_note text, created_by uuid references public.boh_users(id), created_at timestamptz not null default now(),
  decided_by uuid references public.boh_users(id), decided_at timestamptz
);
alter table public.boh_vendor_offers enable row level security;
drop policy if exists boh_vo_read on public.boh_vendor_offers;
create policy boh_vo_read on public.boh_vendor_offers for select to authenticated using (boh_is_staff() or vendor_id = boh_my_vendor());

create or replace function public.boh_vendor_submit_offer(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid := boh_my_vendor(); v_id uuid; pr boh_products; vname text;
begin
  if v is null then raise exception 'Vendor login only'; end if;
  if not boh_has_feature('vendor_products', null, v) then raise exception 'Selling products through the portal is not switched on for you — tap Request access'; end if;
  if coalesce((p->>'rate')::numeric, 0) <= 0 then raise exception 'Enter your rate'; end if;
  if nullif(p->>'product_id', '') is not null then
    select * into pr from boh_products where id = (p->>'product_id')::uuid;
    if not found then raise exception 'Product not found'; end if;
  else
    if coalesce(trim(p->>'name'), '') = '' or coalesce(trim(p->>'unit'), '') = '' then raise exception 'Enter product name and unit'; end if;
  end if;
  insert into boh_vendor_offers (vendor_id, product_id, name, category_id, unit, brand, description, image_url, rate, min_qty, for_clients, for_shop, created_by)
  values (v, pr.id, coalesce(pr.name, trim(p->>'name')), coalesce(pr.category_id, nullif(p->>'category_id', '')::uuid), coalesce(pr.unit, trim(p->>'unit')),
          nullif(trim(p->>'brand'), ''), nullif(trim(p->>'description'), ''), nullif(p->>'image_url', ''), (p->>'rate')::numeric,
          nullif(p->>'min_qty', '')::numeric, coalesce((p->>'for_clients')::boolean, true), coalesce((p->>'for_shop')::boolean, false), auth.uid())
  returning boh_vendor_offers.id into v_id;
  select bv.name into vname from boh_vendors bv where bv.id = v;
  perform boh_notify_staff('vendor_offer', 'Vendor offer: ' || coalesce(pr.name, p->>'name') || ' — ' || vname,
    '🏷️ *' || vname || '* ' || case when pr.id is not null then 'updated their rate for ' else 'offers a new product: ' end || '*' || coalesce(pr.name, p->>'name') || '*' ||
    E'\nRate: ' || boh_inr((p->>'rate')::numeric) || ' / ' || coalesce(pr.unit, p->>'unit') || E'\nReview in Vendors → Vendor offers.', 'voffer:' || v_id);
  return v_id;
end $$;
revoke execute on function public.boh_vendor_submit_offer(jsonb) from public, anon;
grant execute on function public.boh_vendor_submit_offer(jsonb) to authenticated;

create or replace function public.boh_review_offer(p_offer uuid, p_approve boolean, p_category uuid default null, p_name text default null,
  p_unit text default null, p_rate numeric default null, p_for_clients boolean default null, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare o boh_vendor_offers; pid uuid;
begin
  if not boh_is_staff() then raise exception 'Admins only'; end if;
  select * into o from boh_vendor_offers where id = p_offer for update;
  if not found then raise exception 'Offer not found'; end if;
  if o.status <> 'pending' then raise exception 'Already %', o.status; end if;
  if not p_approve then
    update boh_vendor_offers set status = 'rejected', admin_note = p_note, decided_by = auth.uid(), decided_at = now() where id = p_offer;
    perform boh_notify_vendor(o.vendor_id, 'vendor_offer', 'Product offer not approved — ' || o.name,
      'Your offer for *' || o.name || '* was not approved.' || coalesce(E'\nNote: ' || p_note, ''), null, 'voffdec:' || p_offer);
    return null;
  end if;
  pid := o.product_id;
  if pid is null then
    if coalesce(p_category, o.category_id) is null then raise exception 'Pick a category'; end if;
    insert into boh_products (category_id, name, unit, brand, description, image_url, active, b2b)
    values (coalesce(p_category, o.category_id), coalesce(nullif(trim(p_name), ''), o.name), coalesce(nullif(trim(p_unit), ''), o.unit), o.brand, o.description, o.image_url, true,
            coalesce(p_for_clients, o.for_clients))
    returning id into pid;
  end if;
  insert into boh_vendor_rates (vendor_id, product_id, rate, active, updated_at)
  values (o.vendor_id, pid, coalesce(p_rate, o.rate), true, now())
  on conflict (vendor_id, product_id) do update set rate = excluded.rate, active = true, updated_at = now();
  update boh_vendor_offers set status = 'approved', product_id = pid, admin_note = p_note, decided_by = auth.uid(), decided_at = now() where id = p_offer;
  perform boh_notify_vendor(o.vendor_id, 'vendor_offer', 'Product offer approved — ' || o.name,
    '✅ Your offer for *' || o.name || '* at ' || boh_inr(coalesce(p_rate, o.rate)) || ' was approved.' || coalesce(E'\nNote: ' || p_note, ''), null, 'voffdec:' || p_offer);
  return pid;
end $$;
revoke execute on function public.boh_review_offer(uuid, boolean, uuid, text, text, numeric, boolean, text) from public, anon;
grant execute on function public.boh_review_offer(uuid, boolean, uuid, text, text, numeric, boolean, text) to authenticated;

-- approve / reject a vendor that signed up on the website
create or replace function public.boh_review_vendor(p_vendor uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare vn text;
begin
  if not boh_is_staff() then raise exception 'Admins only'; end if;
  update boh_vendors set approval = case when p_approve then 'approved' else 'rejected' end, active = p_approve, approval_note = p_note
   where id = p_vendor returning name into vn;
  if vn is null then raise exception 'Vendor not found'; end if;
  perform boh_notify_vendor(p_vendor, 'vendor_approval', 'Back of House Co — vendor registration ' || case when p_approve then 'approved' else 'not approved' end,
    case when p_approve then '✅ Welcome! *' || vn || '* is now an approved Back of House Co vendor. Sign in to the vendor portal to request order access and to offer your products.'
         else 'Your vendor registration for *' || vn || '* was not approved.' || coalesce(E'\nNote: ' || p_note, '') end, null, 'vappr:' || p_vendor || ':' || p_approve);
end $$;
revoke execute on function public.boh_review_vendor(uuid, boolean, text) from public, anon;
grant execute on function public.boh_review_vendor(uuid, boolean, text) to authenticated;

-- =========================================================================== website leads (contact / services form)
create table if not exists public.boh_leads (
  id uuid primary key default gen_random_uuid(),
  name text not null, phone text not null, email text, company text, city text, service text, message text,
  status text not null default 'new' check (status in ('new','contacted','converted','dropped')),
  admin_note text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.boh_leads enable row level security;
drop policy if exists boh_leads_staff on public.boh_leads;
create policy boh_leads_staff on public.boh_leads for all to authenticated using (boh_is_staff()) with check (boh_is_staff());

create or replace function public.boh_submit_lead(p_name text, p_phone text, p_email text, p_company text, p_city text, p_service text, p_message text) returns void
language plpgsql security definer set search_path = public as $$
declare v_id uuid; digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  if coalesce(trim(p_name), '') = '' or length(digits) < 10 then raise exception 'Please enter your name and a valid phone number'; end if;
  if length(coalesce(p_message, '')) > 2000 or length(coalesce(p_name, '')) > 120 then raise exception 'Message is too long'; end if;
  if (select count(*) from boh_leads where regexp_replace(phone, '\D', '', 'g') = digits and created_at > now() - interval '1 hour') >= 3 then
    raise exception 'Thanks — we already have your request and will call you shortly'; end if;
  if (select count(*) from boh_leads where created_at > now() - interval '10 minutes') >= 30 then raise exception 'Please try again in a few minutes'; end if;
  insert into boh_leads (name, phone, email, company, city, service, message)
  values (trim(p_name), trim(p_phone), nullif(trim(p_email), ''), nullif(trim(p_company), ''), nullif(trim(p_city), ''), nullif(trim(p_service), ''), nullif(trim(p_message), ''))
  returning boh_leads.id into v_id;
  perform boh_notify_staff('lead', 'Website enquiry — ' || trim(p_name) || coalesce(' · ' || nullif(trim(p_service), ''), ''),
    '🌐 *Website enquiry*' || E'\n' || trim(p_name) || coalesce(' · ' || nullif(trim(p_company), ''), '') || E'\n📞 ' || trim(p_phone) || coalesce(' · ' || nullif(trim(p_email), ''), '') ||
    coalesce(E'\nService: ' || nullif(trim(p_service), ''), '') || coalesce(E'\nCity: ' || nullif(trim(p_city), ''), '') || coalesce(E'\n\n' || nullif(trim(p_message), ''), '') ||
    E'\n\nSee Enquiries → Website leads.', 'lead:' || v_id);
end $$;
grant execute on function public.boh_submit_lead(text, text, text, text, text, text, text) to anon, authenticated;

-- =========================================================================== self sign-up (website): shoppers and vendors
create or replace function public.boh_handle_signup() returns trigger
language plpgsql security definer set search_path = public as $$
declare m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb); t text := m->>'signup_type'; vid uuid; nm text;
begin
  if t is null or exists (select 1 from public.boh_users where id = new.id) then return new; end if;
  nm := coalesce(nullif(trim(m->>'full_name'), ''), split_part(new.email, '@', 1));
  if t = 'shopper' then
    insert into public.boh_users (id, full_name, email, phone, role, active) values (new.id, nm, new.email, nullif(trim(m->>'phone'), ''), 'shopper', true);
    insert into public.boh_shoppers (user_id, full_name, phone, email, business_name) values (new.id, nm, nullif(trim(m->>'phone'), ''), new.email, nullif(trim(m->>'business_name'), ''));
  elsif t = 'vendor' then
    insert into public.boh_vendors (name, contact_person, phones, email, address, gstin, delivery_style, active, approval, signup_note)
    values (coalesce(nullif(trim(m->>'business_name'), ''), nm), nm, array_remove(array[nullif(trim(m->>'phone'), '')], null), new.email,
            nullif(trim(m->>'address'), ''), nullif(trim(m->>'gstin'), ''),
            case when m->>'delivery_style' in ('vendor_delivers','porter','self_pickup') then m->>'delivery_style' else 'vendor_delivers' end,
            false, 'pending', nullif(trim(m->>'supplies'), ''))
    returning id into vid;
    insert into public.boh_users (id, full_name, email, phone, role, vendor_id, active) values (new.id, nm, new.email, nullif(trim(m->>'phone'), ''), 'vendor', vid, true);
    perform public.boh_notify_staff('vendor_signup', 'New vendor registration — ' || coalesce(nullif(trim(m->>'business_name'), ''), nm),
      '🏪 *New vendor registration*' || E'\n' || coalesce(nullif(trim(m->>'business_name'), ''), nm) || ' · ' || nm || coalesce(' · ' || nullif(trim(m->>'phone'), ''), '') ||
      E'\n' || new.email || coalesce(E'\nSupplies: ' || nullif(trim(m->>'supplies'), ''), '') || E'\n\nApprove in Vendors (filter: Waiting approval).', 'vsignup:' || vid);
  end if;
  return new;
exception when others then
  raise warning 'boh_handle_signup: %', sqlerrm;
  return new;
end $$;
drop trigger if exists boh_on_auth_signup on auth.users;
create trigger boh_on_auth_signup after insert on auth.users for each row execute function public.boh_handle_signup();

-- admins can (de)activate vendor and shopper logins too
drop policy if exists boh_users_update on public.boh_users;
create policy boh_users_update on public.boh_users for update to authenticated
  using ((boh_role() = 'super_admin') or (boh_is_staff() and role in ('coordinator','customer','vendor','shopper')))
  with check ((boh_role() = 'super_admin') or (boh_is_staff() and role in ('coordinator','customer','vendor','shopper')));

-- =========================================================================== cron: auto orders every 5 minutes
do $$
begin
  perform cron.unschedule('boh-auto-orders') where exists (select 1 from cron.job where jobname = 'boh-auto-orders');
  perform cron.schedule('boh-auto-orders', '*/5 * * * *', 'select public.boh_run_auto_orders()');
end $$;
