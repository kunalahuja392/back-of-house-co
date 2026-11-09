-- v2: categories switched on per restaurant, category-wise allocation to coordinators,
--     delivery overheads, password vault (super admin only), payment SLA after delivery.

-- ---------------------------------------------------------------- per-restaurant category switch
alter table public.boh_restaurant_category_margins add column if not exists active boolean not null default true;

create or replace function public.boh_category_on(p_restaurant uuid, p_category uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select active from boh_restaurant_category_margins where restaurant_id = p_restaurant and category_id = p_category), false)
$$;
revoke execute on function public.boh_category_on(uuid, uuid) from public, anon, authenticated;

-- categories the logged-in restaurant may see
create or replace function public.boh_my_categories() returns table (id uuid, name text)
language sql stable security definer set search_path = public as $$
  select c.id, c.name from boh_categories c
  join boh_restaurant_category_margins m on m.category_id = c.id and m.restaurant_id = boh_my_restaurant() and m.active
  where c.active order by c.sort, c.name
$$;

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
  where rp.restaurant_id = r and rp.active and boh_category_on(r, c.id)
  order by c.sort, c.name, p.name;
end $$;

drop function if exists public.boh_restaurant_catalog(uuid);
create function public.boh_restaurant_catalog(p_restaurant uuid)
returns table (rp_id uuid, product_id uuid, product_name text, category_id uuid, category_name text, unit text,
               rp_active boolean, category_active boolean, margin_override numeric, effective_margin numeric, cost numeric, price numeric,
               vendor_name text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not boh_is_staff() then raise exception 'not allowed'; end if;
  return query
  select rp.id, p.id, p.name, c.id, c.name, p.unit, rp.active, boh_category_on(p_restaurant, c.id), rp.margin_override,
         boh_effective_margin(p_restaurant, p.id), b.rate,
         round(b.rate * (1 + boh_effective_margin(p_restaurant, p.id) / 100), 2), b.vendor_name
  from boh_restaurant_products rp
  join boh_products p on p.id = rp.product_id
  join boh_categories c on c.id = p.category_id
  left join boh_product_best_rate b on b.product_id = p.id
  where rp.restaurant_id = p_restaurant
  order by c.sort, c.name, p.name;
end $$;

-- ---------------------------------------------------------------- category-wise allocation
alter table public.boh_order_items add column if not exists category_id uuid references public.boh_categories(id);

create table if not exists public.boh_order_allocations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.boh_orders(id) on delete cascade,
  category_id uuid not null references public.boh_categories(id),
  category_name text not null,
  coordinator_id uuid not null references public.boh_users(id),
  allocated_by uuid references public.boh_users(id),
  allocated_at timestamptz not null default now(),
  status text not null default 'allocated' check (status in ('allocated','acknowledged','vendor_ordered','followup1','followup2','delivered')),
  acknowledged_at timestamptz,
  vendor_ordered_at timestamptz,
  followup1_at timestamptz,
  followup1_note text,
  followup2_at timestamptz,
  followup2_note text,
  delivered_at timestamptz,
  unique (order_id, category_id)
);
create index if not exists boh_alloc_coord_idx on public.boh_order_allocations(coordinator_id, status);

create table if not exists public.boh_order_overheads (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.boh_orders(id) on delete cascade,
  allocation_id uuid references public.boh_order_allocations(id) on delete cascade,
  kind text not null,
  amount numeric(12,2) not null check (amount >= 0),
  note text,
  created_by uuid references public.boh_users(id),
  created_at timestamptz not null default now()
);
create index if not exists boh_overheads_order_idx on public.boh_order_overheads(order_id);

-- is the current user a coordinator on this order?
create or replace function public.boh_on_order(p_order uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from boh_order_allocations where order_id = p_order and coordinator_id = auth.uid())
$$;
revoke execute on function public.boh_on_order(uuid) from public, anon;
grant execute on function public.boh_on_order(uuid) to authenticated;

-- recompute order status / timestamps from its allocations
create or replace function public.boh_sync_order(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o boh_orders; n_cat int; n_alloc int; rnk int;
  st text;
begin
  select * into o from boh_orders where id = p_order;
  if o.status in ('cancelled','paid') then return; end if;
  select count(distinct category_id) into n_cat from boh_order_items where order_id = p_order;
  select count(*) into n_alloc from boh_order_allocations where order_id = p_order;
  if n_alloc < n_cat then
    update boh_orders set status = 'placed' where id = p_order;
    return;
  end if;
  select min(case status when 'allocated' then 1 when 'acknowledged' then 2 when 'vendor_ordered' then 3
                         when 'followup1' then 4 when 'followup2' then 5 when 'delivered' then 6 end)
    into rnk from boh_order_allocations where order_id = p_order;
  st := (array['allocated','acknowledged','vendor_ordered','followup1','followup2','delivered'])[rnk];
  update boh_orders o2 set
    status = st,
    allocated_at = (select max(allocated_at) from boh_order_allocations where order_id = p_order),
    acknowledged_at = case when rnk >= 2 then (select max(acknowledged_at) from boh_order_allocations where order_id = p_order) end,
    vendor_ordered_at = case when rnk >= 3 then (select max(vendor_ordered_at) from boh_order_allocations where order_id = p_order) end,
    delivered_at = case when rnk >= 6 then (select max(delivered_at) from boh_order_allocations where order_id = p_order) end
  where id = p_order;
end $$;
revoke execute on function public.boh_sync_order(uuid) from public, anon, authenticated;

-- p_map: [{"category_id": "...", "coordinator_id": "..."}]
drop function if exists public.boh_allocate_order(uuid, uuid);
create function public.boh_allocate_order(p_order uuid, p_map jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare it jsonb; v_cat uuid; v_co uuid; v_name text;
begin
  if not boh_is_staff() then raise exception 'Only admins can allocate orders'; end if;
  if (select status from boh_orders where id = p_order) in ('cancelled','paid') then raise exception 'Order is closed'; end if;
  for it in select * from jsonb_array_elements(p_map) loop
    v_cat := (it->>'category_id')::uuid; v_co := (it->>'coordinator_id')::uuid;
    if v_co is null then continue; end if;
    if not exists (select 1 from boh_users where id = v_co and role in ('coordinator','admin','super_admin') and active) then
      raise exception 'Invalid coordinator';
    end if;
    select category_name into v_name from boh_order_items where order_id = p_order and category_id = v_cat limit 1;
    if v_name is null then continue; end if;
    insert into boh_order_allocations (order_id, category_id, category_name, coordinator_id, allocated_by)
    values (p_order, v_cat, v_name, v_co, auth.uid())
    on conflict (order_id, category_id) do update set coordinator_id = excluded.coordinator_id, allocated_by = excluded.allocated_by
      where boh_order_allocations.coordinator_id is distinct from excluded.coordinator_id;
    insert into boh_order_events (order_id, event, note, actor)
    values (p_order, 'allocated', v_name || ' → ' || (select full_name from boh_users where id = v_co), auth.uid());
  end loop;
  -- first coordinator chosen is kept on the order for quick filtering
  update boh_orders set coordinator_id = coalesce(coordinator_id, (select coordinator_id from boh_order_allocations where order_id = p_order limit 1)),
    allocated_by = auth.uid() where id = p_order;
  perform boh_sync_order(p_order);
end $$;

-- move one category allocation forward; on delivery, record overheads [{"kind":"Porter","amount":250,"note":""}]
drop function if exists public.boh_advance_order(uuid, text, text);
create or replace function public.boh_advance_allocation(p_alloc uuid, p_step text, p_note text default null, p_overheads jsonb default '[]')
returns void language plpgsql security definer set search_path = public as $$
declare a boh_order_allocations; nxt text; oh jsonb;
begin
  select * into a from boh_order_allocations where id = p_alloc for update;
  if not found then raise exception 'Allocation not found'; end if;
  if not (boh_is_staff() or a.coordinator_id = auth.uid()) then raise exception 'This category is not allocated to you'; end if;
  if (select status from boh_orders where id = a.order_id) = 'cancelled' then raise exception 'Order is cancelled'; end if;
  nxt := case a.status when 'allocated' then 'acknowledged' when 'acknowledged' then 'vendor_ordered'
    when 'vendor_ordered' then 'followup1' when 'followup1' then 'followup2' when 'followup2' then 'delivered' end;
  if p_step = 'delivered' and a.status in ('vendor_ordered','followup1') then nxt := 'delivered'; end if;
  if nxt is null or nxt <> p_step then raise exception 'Cannot move % from % to %', a.category_name, a.status, p_step; end if;
  update boh_order_allocations set status = p_step,
    acknowledged_at = case when p_step = 'acknowledged' then now() else acknowledged_at end,
    vendor_ordered_at = case when p_step = 'vendor_ordered' then now() else vendor_ordered_at end,
    followup1_at = case when p_step = 'followup1' then now() else followup1_at end,
    followup1_note = case when p_step = 'followup1' then p_note else followup1_note end,
    followup2_at = case when p_step = 'followup2' then now() else followup2_at end,
    followup2_note = case when p_step = 'followup2' then p_note else followup2_note end,
    delivered_at = case when p_step = 'delivered' then now() else delivered_at end
  where id = p_alloc;
  if p_step = 'delivered' then
    for oh in select * from jsonb_array_elements(coalesce(p_overheads, '[]')) loop
      if coalesce((oh->>'amount')::numeric, 0) > 0 then
        insert into boh_order_overheads (order_id, allocation_id, kind, amount, note, created_by)
        values (a.order_id, a.id, coalesce(nullif(oh->>'kind',''), 'Other'), (oh->>'amount')::numeric, nullif(oh->>'note',''), auth.uid());
      end if;
    end loop;
  end if;
  insert into boh_order_events (order_id, event, note, actor) values (a.order_id, p_step, a.category_name || coalesce(' · ' || p_note, ''), auth.uid());
  perform boh_sync_order(a.order_id);
end $$;

-- extra overhead added later (e.g. bill came after delivery)
create or replace function public.boh_add_overhead(p_order uuid, p_kind text, p_amount numeric, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (boh_is_staff() or boh_on_order(p_order)) then raise exception 'not allowed'; end if;
  insert into boh_order_overheads (order_id, kind, amount, note, created_by) values (p_order, p_kind, p_amount, p_note, auth.uid());
end $$;

create or replace function public.boh_mark_paid(p_order uuid, p_ref text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (boh_is_staff() or boh_on_order(p_order)) then raise exception 'not allowed'; end if;
  if (select status from boh_orders where id = p_order) <> 'delivered' then raise exception 'Order must be fully delivered first'; end if;
  update boh_orders set status = 'paid', paid_at = now(), payment_ref = p_ref where id = p_order;
  insert into boh_order_events (order_id, event, note, actor) values (p_order, 'paid', p_ref, auth.uid());
end $$;

create or replace function public.boh_cancel_order(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not boh_is_staff() then raise exception 'Only admins can cancel'; end if;
  update boh_orders set status = 'cancelled', cancelled_at = now() where id = p_order and status <> 'paid';
  insert into boh_order_events (order_id, event, actor) values (p_order, 'cancelled', auth.uid());
end $$;

-- who is handling each category of my order (restaurant view)
create or replace function public.boh_order_coordinators(p_order uuid)
returns table (category_name text, full_name text, phone text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (boh_is_team() or exists (select 1 from boh_orders where id = p_order and restaurant_id = boh_my_restaurant())) then
    raise exception 'not allowed';
  end if;
  return query select a.category_name, u.full_name, u.phone from boh_order_allocations a join boh_users u on u.id = a.coordinator_id
    where a.order_id = p_order order by a.category_name;
end $$;

-- place order: now stores category_id and only allows switched-on categories
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
    v_margin := boh_effective_margin(r, p.id);
    v_price := round(p.rate * (1 + v_margin / 100), 2);
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

-- ---------------------------------------------------------------- password vault (super admin only)
create table if not exists public.boh_user_secrets (
  user_id uuid primary key references public.boh_users(id) on delete cascade,
  password text not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS
alter table public.boh_order_allocations enable row level security;
alter table public.boh_order_overheads enable row level security;
alter table public.boh_user_secrets enable row level security;

create policy boh_alloc_read on public.boh_order_allocations for select to authenticated
  using (boh_is_staff() or coordinator_id = auth.uid() or boh_on_order(order_id));
create policy boh_oh_read on public.boh_order_overheads for select to authenticated
  using (boh_is_staff() or boh_on_order(order_id));
create policy boh_oh_staff on public.boh_order_overheads for all to authenticated using (boh_is_staff()) with check (boh_is_staff());
create policy boh_secret_read on public.boh_user_secrets for select to authenticated using (boh_role() = 'super_admin');

drop policy if exists boh_ord_read on public.boh_orders;
create policy boh_ord_read on public.boh_orders for select to authenticated
  using (boh_is_staff() or boh_on_order(id) or restaurant_id = boh_my_restaurant());
drop policy if exists boh_items_read on public.boh_order_items;
create policy boh_items_read on public.boh_order_items for select to authenticated
  using (boh_is_staff() or exists (select 1 from boh_order_allocations a where a.order_id = boh_order_items.order_id
                                   and a.category_id = boh_order_items.category_id and a.coordinator_id = auth.uid()));
drop policy if exists boh_events_read on public.boh_order_events;
create policy boh_events_read on public.boh_order_events for select to authenticated
  using (boh_is_staff() or boh_on_order(order_id) or exists (select 1 from boh_orders o where o.id = order_id and o.restaurant_id = boh_my_restaurant()));

revoke execute on function public.boh_allocate_order(uuid, jsonb), public.boh_advance_allocation(uuid, text, text, jsonb),
  public.boh_add_overhead(uuid, text, numeric, text), public.boh_mark_paid(uuid, text), public.boh_cancel_order(uuid),
  public.boh_order_coordinators(uuid), public.boh_my_categories(), public.boh_restaurant_catalog(uuid), public.boh_place_order(jsonb, text),
  public.boh_my_catalog() from public, anon;
grant execute on function public.boh_allocate_order(uuid, jsonb), public.boh_advance_allocation(uuid, text, text, jsonb),
  public.boh_add_overhead(uuid, text, numeric, text), public.boh_mark_paid(uuid, text), public.boh_cancel_order(uuid),
  public.boh_order_coordinators(uuid), public.boh_my_categories(), public.boh_restaurant_catalog(uuid), public.boh_place_order(jsonb, text),
  public.boh_my_catalog() to authenticated;

-- ---------------------------------------------------------------- admins assigned to restaurants (internal only)
create table if not exists public.boh_restaurant_admins (
  restaurant_id uuid not null references public.boh_restaurants(id) on delete cascade,
  user_id uuid not null references public.boh_users(id) on delete cascade,
  primary key (restaurant_id, user_id)
);
alter table public.boh_restaurant_admins enable row level security;
create policy boh_radmin_all on public.boh_restaurant_admins for all to authenticated using (boh_is_staff()) with check (boh_is_staff());

-- product image shown on the restaurant ordering screen
alter table public.boh_products add column if not exists show_image boolean not null default true;

-- product images only reach restaurants when "show image" is ticked
create or replace function public.boh_my_catalog()
returns table (product_id uuid, product_name text, category_id uuid, category_name text, unit text,
               brand text, image_url text, description text, price numeric)
language plpgsql stable security definer set search_path = public as $$
declare r uuid := boh_my_restaurant();
begin
  if r is null then raise exception 'not a customer'; end if;
  return query
  select p.id, p.name, c.id, c.name, p.unit, p.brand, case when p.show_image then p.image_url end, p.description,
         round(b.rate * (1 + boh_effective_margin(r, p.id) / 100), 2)
  from boh_restaurant_products rp
  join boh_products p on p.id = rp.product_id and p.active
  join boh_categories c on c.id = p.category_id
  left join boh_product_best_rate b on b.product_id = p.id
  where rp.restaurant_id = r and rp.active and boh_category_on(r, c.id)
  order by c.sort, c.name, p.name;
end $$;

-- approving a request also switches on the product's category for that restaurant
create or replace function public.boh_review_request(p_request uuid, p_approve boolean, p_margin numeric, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare q boh_product_requests; v_cat uuid; v_default numeric;
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
    select p.category_id, c.default_margin into v_cat, v_default
      from boh_products p join boh_categories c on c.id = p.category_id where p.id = q.product_id;
    insert into boh_restaurant_category_margins (restaurant_id, category_id, margin_pct, active)
    values (q.restaurant_id, v_cat, v_default, true)
    on conflict (restaurant_id, category_id) do update set active = true;
  end if;
end $$;

