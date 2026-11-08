-- Back of House Co — schema
-- All objects are prefixed boh_ so they can live alongside other apps in the same Supabase project.

-- ---------------------------------------------------------------- settings
create table if not exists public.boh_settings (
  id int primary key default 1 check (id = 1),
  company_name text not null default 'Back of House Co',
  support_phone text default '',
  order_cutoff time not null default '16:00',
  work_start time not null default '10:00',
  work_end time not null default '19:00',
  work_days int[] not null default '{1,2,3,4,5,6}',   -- ISO day of week, 1 = Monday
  sla_allocate_hrs numeric not null default 2,
  sla_ack_hrs numeric not null default 1,
  sla_vendor_order_hrs numeric not null default 2,
  sla_followup1_hrs numeric not null default 4,
  sla_followup2_hrs numeric not null default 2,
  sla_payment_hrs numeric not null default 4,         -- working hours after delivery
  updated_at timestamptz default now()
);
insert into public.boh_settings (id) values (1) on conflict do nothing;

-- ---------------------------------------------------------------- people & restaurants
create table if not exists public.boh_restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  outlet_type text default 'Restaurant',
  contact_name text,
  phone text,
  email text,
  address text,
  gstin text,
  coordinator_id uuid,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.boh_users (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null,
  phone text,
  role text not null check (role in ('super_admin','admin','coordinator','customer')),
  restaurant_id uuid references public.boh_restaurants(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.boh_restaurants
  drop constraint if exists boh_restaurants_coordinator_fk,
  add constraint boh_restaurants_coordinator_fk foreign key (coordinator_id) references public.boh_users(id) on delete set null;

-- ---------------------------------------------------------------- catalogue
create table if not exists public.boh_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  default_margin numeric(6,2) not null default 0,
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.boh_products (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.boh_categories(id),
  name text not null,
  sku text,
  unit text not null default 'pc',
  brand text,
  description text,
  image_url text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists boh_products_cat_idx on public.boh_products(category_id);

create table if not exists public.boh_vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_person text,
  phones text[] not null default '{}',
  email text,
  address text,
  gstin text,
  delivery_style text not null default 'vendor_delivers' check (delivery_style in ('vendor_delivers','porter','self_pickup')),
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.boh_vendor_rates (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.boh_vendors(id) on delete cascade,
  product_id uuid not null references public.boh_products(id) on delete cascade,
  rate numeric(12,2) not null check (rate >= 0),
  moq text,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (vendor_id, product_id)
);

-- lowest active rate from an active vendor = the vendor we order from
create or replace view public.boh_product_best_rate with (security_invoker = true) as
select distinct on (r.product_id)
  r.product_id, r.vendor_id, r.rate, v.name as vendor_name, v.phones as vendor_phones, v.delivery_style
from public.boh_vendor_rates r
join public.boh_vendors v on v.id = r.vendor_id
where r.active and v.active
order by r.product_id, r.rate asc, r.updated_at desc;

-- per-restaurant category mark-up and ordering list (allocated products)
create table if not exists public.boh_restaurant_category_margins (
  restaurant_id uuid not null references public.boh_restaurants(id) on delete cascade,
  category_id uuid not null references public.boh_categories(id) on delete cascade,
  margin_pct numeric(6,2) not null,
  primary key (restaurant_id, category_id)
);

create table if not exists public.boh_restaurant_products (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.boh_restaurants(id) on delete cascade,
  product_id uuid not null references public.boh_products(id) on delete cascade,
  margin_override numeric(6,2),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (restaurant_id, product_id)
);

-- slideshow / showcase products shown to all restaurants
create table if not exists public.boh_featured (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.boh_products(id) on delete cascade,
  title text not null,
  caption text,
  image_url text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- product requests (for catalogue items not on the ordering list, or new items)
create table if not exists public.boh_product_requests (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.boh_restaurants(id) on delete cascade,
  product_id uuid references public.boh_products(id) on delete set null,
  item_name text,
  note text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  margin_pct numeric(6,2),
  admin_note text,
  requested_by uuid references public.boh_users(id),
  reviewed_by uuid references public.boh_users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- orders
create table if not exists public.boh_orders (
  id uuid primary key default gen_random_uuid(),
  order_no bigserial unique,
  restaurant_id uuid not null references public.boh_restaurants(id),
  placed_by uuid references public.boh_users(id),
  status text not null default 'placed' check (status in
    ('placed','allocated','acknowledged','vendor_ordered','followup1','followup2','delivered','paid','cancelled')),
  delivery_date date not null,
  notes text,
  total numeric(14,2) not null default 0,
  cost_total numeric(14,2) not null default 0,
  coordinator_id uuid references public.boh_users(id),
  allocated_by uuid references public.boh_users(id),
  allocated_at timestamptz,
  acknowledged_at timestamptz,
  vendor_ordered_at timestamptz,
  followup1_at timestamptz,
  followup1_note text,
  followup2_at timestamptz,
  followup2_note text,
  delivered_at timestamptz,
  paid_at timestamptz,
  payment_ref text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists boh_orders_rest_idx on public.boh_orders(restaurant_id, created_at desc);
create index if not exists boh_orders_coord_idx on public.boh_orders(coordinator_id, status);

create table if not exists public.boh_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.boh_orders(id) on delete cascade,
  product_id uuid references public.boh_products(id),
  product_name text not null,
  category_name text,
  unit text,
  qty numeric(12,3) not null check (qty > 0),
  unit_cost numeric(12,2),
  margin_pct numeric(6,2),
  unit_price numeric(12,2) not null,
  line_total numeric(14,2) not null,
  vendor_id uuid references public.boh_vendors(id),
  vendor_name text,
  delivery_style text
);
create index if not exists boh_order_items_order_idx on public.boh_order_items(order_id);
create index if not exists boh_order_items_prod_idx on public.boh_order_items(product_id);

create table if not exists public.boh_order_events (
  id bigserial primary key,
  order_id uuid not null references public.boh_orders(id) on delete cascade,
  event text not null,
  note text,
  actor uuid references public.boh_users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.boh_complaints (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.boh_restaurants(id) on delete cascade,
  order_id uuid references public.boh_orders(id) on delete set null,
  category text default 'Other',
  subject text not null,
  description text,
  status text not null default 'open' check (status in ('open','in_progress','resolved')),
  resolution text,
  created_by uuid references public.boh_users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- role helpers
create or replace function public.boh_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.boh_users where id = auth.uid() and active
$$;

create or replace function public.boh_is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.boh_role() in ('super_admin','admin'), false)
$$;

create or replace function public.boh_is_team() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.boh_role() in ('super_admin','admin','coordinator'), false)
$$;

create or replace function public.boh_my_restaurant() returns uuid
language sql stable security definer set search_path = public as $$
  select restaurant_id from public.boh_users where id = auth.uid() and active and role = 'customer'
$$;

-- ---------------------------------------------------------------- pricing
create or replace function public.boh_effective_margin(p_restaurant uuid, p_product uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select margin_override from boh_restaurant_products where restaurant_id = p_restaurant and product_id = p_product),
    (select m.margin_pct from boh_restaurant_category_margins m join boh_products p on p.category_id = m.category_id
       where m.restaurant_id = p_restaurant and p.id = p_product),
    (select c.default_margin from boh_categories c join boh_products p on p.category_id = c.id where p.id = p_product),
    0)
$$;

-- full pricing breakdown for a restaurant's ordering list (staff only)
create or replace function public.boh_restaurant_catalog(p_restaurant uuid)
returns table (rp_id uuid, product_id uuid, product_name text, category_id uuid, category_name text, unit text,
               rp_active boolean, margin_override numeric, effective_margin numeric, cost numeric, price numeric,
               vendor_name text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not boh_is_staff() then raise exception 'not allowed'; end if;
  return query
  select rp.id, p.id, p.name, c.id, c.name, p.unit, rp.active, rp.margin_override,
         boh_effective_margin(p_restaurant, p.id),
         b.rate,
         round(b.rate * (1 + boh_effective_margin(p_restaurant, p.id) / 100), 2),
         b.vendor_name
  from boh_restaurant_products rp
  join boh_products p on p.id = rp.product_id
  join boh_categories c on c.id = p.category_id
  left join boh_product_best_rate b on b.product_id = p.id
  where rp.restaurant_id = p_restaurant
  order by c.sort, c.name, p.name;
end $$;

-- the logged-in customer's ordering list with selling prices only (no cost / margin exposed)
create or replace function public.boh_my_catalog()
returns table (product_id uuid, product_name text, category_id uuid, category_name text, unit text,
               brand text, image_url text, description text, price numeric)
language plpgsql stable security definer set search_path = public as $$
declare r uuid := boh_my_restaurant();
begin
  if r is null then raise exception 'not a customer'; end if;
  return query
  select p.id, p.name, c.id, c.name, p.unit, p.brand, p.image_url, p.description,
         round(b.rate * (1 + boh_effective_margin(r, p.id) / 100), 2)
  from boh_restaurant_products rp
  join boh_products p on p.id = rp.product_id and p.active
  join boh_categories c on c.id = p.category_id
  left join boh_product_best_rate b on b.product_id = p.id
  where rp.restaurant_id = r and rp.active
  order by c.sort, c.name, p.name;
end $$;

-- customer-facing info: coordinator contact
create or replace function public.boh_my_coordinator()
returns table (full_name text, phone text, email text)
language sql stable security definer set search_path = public as $$
  select u.full_name, u.phone, u.email
  from boh_restaurants r join boh_users u on u.id = r.coordinator_id
  where r.id = boh_my_restaurant()
$$;

-- customer-safe order lines
create or replace function public.boh_order_lines(p_order uuid)
returns table (product_id uuid, product_name text, category_name text, unit text, qty numeric, unit_price numeric, line_total numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (boh_is_team() or exists (select 1 from boh_orders where id = p_order and restaurant_id = boh_my_restaurant())) then
    raise exception 'not allowed';
  end if;
  return query select i.product_id, i.product_name, i.category_name, i.unit, i.qty, i.unit_price, i.line_total
    from boh_order_items i where i.order_id = p_order order by i.category_name, i.product_name;
end $$;

-- ---------------------------------------------------------------- order placement
create or replace function public.boh_place_order(p_items jsonb, p_notes text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  r uuid := boh_my_restaurant();
  s boh_settings;
  ist timestamp := (now() at time zone 'Asia/Kolkata');
  v_delivery date;
  v_order uuid;
  it jsonb;
  v_qty numeric;
  p record;
  v_margin numeric;
  v_price numeric;
  v_total numeric := 0;
  v_cost numeric := 0;
begin
  if r is null then raise exception 'Only restaurant users can place orders'; end if;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then raise exception 'Order is empty'; end if;
  select * into s from boh_settings where id = 1;
  v_delivery := case when ist::time < s.order_cutoff then ist::date + 1 else ist::date + 2 end;

  insert into boh_orders (restaurant_id, placed_by, delivery_date, notes, coordinator_id)
  values (r, auth.uid(), v_delivery, p_notes, null)
  returning id into v_order;

  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := (it->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then continue; end if;
    select pr.id, pr.name, pr.unit, c.name as cat, b.rate, b.vendor_id, b.vendor_name, b.delivery_style
      into p
      from boh_restaurant_products rp
      join boh_products pr on pr.id = rp.product_id and pr.active
      join boh_categories c on c.id = pr.category_id
      left join boh_product_best_rate b on b.product_id = pr.id
      where rp.restaurant_id = r and rp.active and rp.product_id = (it->>'product_id')::uuid;
    if not found then raise exception 'Product % is not on your ordering list', it->>'product_id'; end if;
    if p.rate is null then raise exception '% has no active price yet — please contact us', p.name; end if;
    v_margin := boh_effective_margin(r, p.id);
    v_price := round(p.rate * (1 + v_margin / 100), 2);
    insert into boh_order_items (order_id, product_id, product_name, category_name, unit, qty, unit_cost, margin_pct,
                                 unit_price, line_total, vendor_id, vendor_name, delivery_style)
    values (v_order, p.id, p.name, p.cat, p.unit, v_qty, p.rate, v_margin, v_price, round(v_price * v_qty, 2),
            p.vendor_id, p.vendor_name, p.delivery_style);
    v_total := v_total + round(v_price * v_qty, 2);
    v_cost := v_cost + round(p.rate * v_qty, 2);
  end loop;

  if v_total = 0 then raise exception 'Order is empty'; end if;
  update boh_orders set total = v_total, cost_total = v_cost where id = v_order;
  insert into boh_order_events (order_id, event, actor) values (v_order, 'placed', auth.uid());
  return v_order;
end $$;

-- ---------------------------------------------------------------- order workflow
create or replace function public.boh_allocate_order(p_order uuid, p_coordinator uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not boh_is_staff() then raise exception 'Only admins can allocate orders'; end if;
  if not exists (select 1 from boh_users where id = p_coordinator and role in ('coordinator','admin','super_admin') and active) then
    raise exception 'Invalid coordinator';
  end if;
  update boh_orders set coordinator_id = p_coordinator, allocated_by = auth.uid(),
    allocated_at = coalesce(allocated_at, now()),
    status = case when status = 'placed' then 'allocated' else status end
  where id = p_order and status <> 'cancelled';
  insert into boh_order_events (order_id, event, note, actor)
  values (p_order, 'allocated', (select full_name from boh_users where id = p_coordinator), auth.uid());
end $$;

create or replace function public.boh_advance_order(p_order uuid, p_step text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare o boh_orders;
  nxt text;
begin
  select * into o from boh_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if not (boh_is_staff() or (boh_role() = 'coordinator' and o.coordinator_id = auth.uid())) then
    raise exception 'This order is not allocated to you';
  end if;
  nxt := case o.status
    when 'allocated' then 'acknowledged'
    when 'acknowledged' then 'vendor_ordered'
    when 'vendor_ordered' then 'followup1'
    when 'followup1' then 'followup2'
    when 'followup2' then 'delivered'
    when 'delivered' then 'paid' end;
  if p_step = 'delivered' and o.status in ('vendor_ordered','followup1') then nxt := 'delivered'; end if; -- delivered early
  if p_step = 'cancelled' then
    if not boh_is_staff() then raise exception 'Only admins can cancel'; end if;
    update boh_orders set status = 'cancelled', cancelled_at = now() where id = p_order;
  elsif nxt is null or nxt <> p_step then
    raise exception 'Cannot move order from % to %', o.status, p_step;
  else
    update boh_orders set status = p_step,
      acknowledged_at = case when p_step = 'acknowledged' then now() else acknowledged_at end,
      vendor_ordered_at = case when p_step = 'vendor_ordered' then now() else vendor_ordered_at end,
      followup1_at = case when p_step = 'followup1' then now() else followup1_at end,
      followup1_note = case when p_step = 'followup1' then p_note else followup1_note end,
      followup2_at = case when p_step = 'followup2' then now() else followup2_at end,
      followup2_note = case when p_step = 'followup2' then p_note else followup2_note end,
      delivered_at = case when p_step = 'delivered' then now() else delivered_at end,
      paid_at = case when p_step = 'paid' then now() else paid_at end,
      payment_ref = case when p_step = 'paid' then p_note else payment_ref end
    where id = p_order;
  end if;
  insert into boh_order_events (order_id, event, note, actor) values (p_order, p_step, p_note, auth.uid());
end $$;

-- ---------------------------------------------------------------- requests
create or replace function public.boh_review_request(p_request uuid, p_approve boolean, p_margin numeric, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare q boh_product_requests;
begin
  if not boh_is_staff() then raise exception 'not allowed'; end if;
  select * into q from boh_product_requests where id = p_request;
  if not found then raise exception 'Request not found'; end if;
  if p_approve and q.product_id is null then raise exception 'Link the request to a catalogue product before approving'; end if;
  update boh_product_requests set status = case when p_approve then 'approved' else 'rejected' end,
    margin_pct = p_margin, admin_note = p_note, reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_request;
  if p_approve then
    insert into boh_restaurant_products (restaurant_id, product_id, margin_override, active)
    values (q.restaurant_id, q.product_id, p_margin, true)
    on conflict (restaurant_id, product_id) do update set active = true, margin_override = excluded.margin_override;
  end if;
end $$;

-- ---------------------------------------------------------------- RLS
alter table public.boh_settings enable row level security;
alter table public.boh_users enable row level security;
alter table public.boh_restaurants enable row level security;
alter table public.boh_categories enable row level security;
alter table public.boh_products enable row level security;
alter table public.boh_vendors enable row level security;
alter table public.boh_vendor_rates enable row level security;
alter table public.boh_restaurant_category_margins enable row level security;
alter table public.boh_restaurant_products enable row level security;
alter table public.boh_featured enable row level security;
alter table public.boh_product_requests enable row level security;
alter table public.boh_orders enable row level security;
alter table public.boh_order_items enable row level security;
alter table public.boh_order_events enable row level security;
alter table public.boh_complaints enable row level security;

-- settings
create policy boh_settings_read on public.boh_settings for select to authenticated using (boh_role() is not null);
create policy boh_settings_write on public.boh_settings for update to authenticated using (boh_role() = 'super_admin') with check (boh_role() = 'super_admin');

-- users
create policy boh_users_self on public.boh_users for select to authenticated using (id = auth.uid() or boh_is_team());
create policy boh_users_update on public.boh_users for update to authenticated
  using (boh_role() = 'super_admin' or (boh_is_staff() and role in ('coordinator','customer')))
  with check (boh_role() = 'super_admin' or (boh_is_staff() and role in ('coordinator','customer')));

-- restaurants
create policy boh_rest_read on public.boh_restaurants for select to authenticated using (boh_is_team() or id = boh_my_restaurant());
create policy boh_rest_write on public.boh_restaurants for all to authenticated using (boh_is_staff()) with check (boh_is_staff());

-- catalogue: everyone in the app can browse products/categories (no prices in these tables)
create policy boh_cat_read on public.boh_categories for select to authenticated using (boh_role() is not null);
create policy boh_cat_write on public.boh_categories for all to authenticated using (boh_is_staff()) with check (boh_is_staff());
create policy boh_prod_read on public.boh_products for select to authenticated using (boh_role() is not null);
create policy boh_prod_write on public.boh_products for all to authenticated using (boh_is_staff()) with check (boh_is_staff());
create policy boh_feat_read on public.boh_featured for select to authenticated using (boh_role() is not null);
create policy boh_feat_write on public.boh_featured for all to authenticated using (boh_is_staff()) with check (boh_is_staff());

-- vendors & rates: team only (coordinators need vendor numbers)
create policy boh_vend_read on public.boh_vendors for select to authenticated using (boh_is_team());
create policy boh_vend_write on public.boh_vendors for all to authenticated using (boh_is_staff()) with check (boh_is_staff());
create policy boh_rate_read on public.boh_vendor_rates for select to authenticated using (boh_is_team());
create policy boh_rate_write on public.boh_vendor_rates for all to authenticated using (boh_is_staff()) with check (boh_is_staff());

-- margins & ordering list: staff only (customers use boh_my_catalog)
create policy boh_rcm_all on public.boh_restaurant_category_margins for all to authenticated using (boh_is_staff()) with check (boh_is_staff());
create policy boh_rp_all on public.boh_restaurant_products for all to authenticated using (boh_is_staff()) with check (boh_is_staff());

-- requests
create policy boh_req_read on public.boh_product_requests for select to authenticated using (boh_is_team() or restaurant_id = boh_my_restaurant());
create policy boh_req_insert on public.boh_product_requests for insert to authenticated
  with check (boh_is_staff() or (restaurant_id = boh_my_restaurant() and status = 'pending'));
create policy boh_req_staff on public.boh_product_requests for update to authenticated using (boh_is_staff()) with check (boh_is_staff());
create policy boh_req_del on public.boh_product_requests for delete to authenticated using (boh_is_staff());

-- orders (writes go through functions)
create policy boh_ord_read on public.boh_orders for select to authenticated
  using (boh_is_staff() or coordinator_id = auth.uid() or restaurant_id = boh_my_restaurant());
create policy boh_ord_staff on public.boh_orders for update to authenticated using (boh_is_staff()) with check (boh_is_staff());
create policy boh_items_read on public.boh_order_items for select to authenticated
  using (boh_is_staff() or exists (select 1 from boh_orders o where o.id = order_id and o.coordinator_id = auth.uid()));
create policy boh_events_read on public.boh_order_events for select to authenticated
  using (boh_is_staff() or exists (select 1 from boh_orders o where o.id = order_id and (o.coordinator_id = auth.uid() or o.restaurant_id = boh_my_restaurant())));

-- complaints
create policy boh_comp_read on public.boh_complaints for select to authenticated using (boh_is_team() or restaurant_id = boh_my_restaurant());
create policy boh_comp_insert on public.boh_complaints for insert to authenticated
  with check (boh_is_team() or (restaurant_id = boh_my_restaurant() and status = 'open'));
create policy boh_comp_update on public.boh_complaints for update to authenticated using (boh_is_team()) with check (boh_is_team());

-- function grants
revoke execute on function public.boh_place_order(jsonb, text), public.boh_allocate_order(uuid, uuid),
  public.boh_advance_order(uuid, text, text), public.boh_review_request(uuid, boolean, numeric, text),
  public.boh_restaurant_catalog(uuid), public.boh_my_catalog(), public.boh_my_coordinator(), public.boh_order_lines(uuid),
  public.boh_effective_margin(uuid, uuid)
  from public, anon;
grant execute on function public.boh_place_order(jsonb, text), public.boh_allocate_order(uuid, uuid),
  public.boh_advance_order(uuid, text, text), public.boh_review_request(uuid, boolean, numeric, text),
  public.boh_restaurant_catalog(uuid), public.boh_my_catalog(), public.boh_my_coordinator(), public.boh_order_lines(uuid)
  to authenticated;

-- ---------------------------------------------------------------- storage for product / showcase images
insert into storage.buckets (id, name, public) values ('boh-images', 'boh-images', true) on conflict (id) do nothing;
create policy boh_img_insert on storage.objects for insert to authenticated with check (bucket_id = 'boh-images' and public.boh_is_staff());
create policy boh_img_update on storage.objects for update to authenticated using (bucket_id = 'boh-images' and public.boh_is_staff());
create policy boh_img_delete on storage.objects for delete to authenticated using (bucket_id = 'boh-images' and public.boh_is_staff());

revoke execute on function public.boh_role(), public.boh_is_staff(), public.boh_is_team(), public.boh_my_restaurant() from public, anon;
grant execute on function public.boh_role(), public.boh_is_staff(), public.boh_is_team(), public.boh_my_restaurant() to authenticated;
revoke execute on function public.boh_effective_margin(uuid, uuid) from authenticated, anon, public;
revoke all on public.boh_product_best_rate from anon;

insert into public.boh_categories (name, default_margin, sort) values
  ('Vegetables & Fruits', 8, 1),
  ('Dairy', 6, 2),
  ('Bakery', 5, 3),
  ('Meat, Poultry & Seafood', 6, 4),
  ('Grocery & Dry Goods', 7, 5),
  ('Spices & Masalas', 8, 6),
  ('Frozen Foods', 7, 7),
  ('Beverages', 8, 8),
  ('Disposables', 12, 9),
  ('Packaging', 12, 10),
  ('Cleaning & Housekeeping', 10, 11),
  ('Kitchen Equipment & Machines', 10, 12),
  ('Smallwares & Utensils', 10, 13)
on conflict (name) do nothing;
