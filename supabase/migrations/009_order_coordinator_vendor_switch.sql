-- 009: one coordinator per order, order-level steps, vendor change / skip / disable,
--      "found it cheaper" reports from restaurants, pending balances.

-- ---------------------------------------------------------------- vendors: who disabled and why
alter table public.boh_vendors
  add column if not exists disabled_reason text,
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_by uuid references public.boh_users(id);

-- vendors skipped for one order only (not responding this time)
create table if not exists public.boh_order_vendor_skips (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.boh_orders(id) on delete cascade,
  vendor_id uuid not null references public.boh_vendors(id) on delete cascade,
  mode text not null default 'skip' check (mode in ('skip','disable','manual')),
  reason text,
  created_by uuid references public.boh_users(id),
  created_at timestamptz not null default now(),
  unique (order_id, vendor_id)
);
alter table public.boh_order_vendor_skips enable row level security;
drop policy if exists boh_skip_read on public.boh_order_vendor_skips;
create policy boh_skip_read on public.boh_order_vendor_skips for select to authenticated using (boh_is_staff() or boh_on_order(order_id));

-- ---------------------------------------------------------------- allocate the whole order to one coordinator
create or replace function public.boh_allocate_order_to(p_order uuid, p_coordinator uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o boh_orders; v_name text;
begin
  if not boh_is_staff() then raise exception 'Only admins can allocate orders'; end if;
  select * into o from boh_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status in ('cancelled','paid','delivered') then raise exception 'Order is closed'; end if;
  select full_name into v_name from boh_users where id = p_coordinator and role in ('coordinator','admin','super_admin') and active;
  if v_name is null then raise exception 'Invalid coordinator'; end if;
  if o.coordinator_id = p_coordinator
     and not exists (select 1 from boh_order_items i where i.order_id = p_order and not exists
       (select 1 from boh_order_allocations a where a.order_id = p_order and a.category_id = i.category_id and a.coordinator_id = p_coordinator)) then
    return; -- nothing changes
  end if;
  insert into boh_order_allocations (order_id, category_id, category_name, coordinator_id, allocated_by)
  select distinct on (i.category_id) p_order, i.category_id, coalesce(i.category_name, 'Items'), p_coordinator, auth.uid()
    from boh_order_items i where i.order_id = p_order and i.category_id is not null
  on conflict (order_id, category_id) do update set coordinator_id = excluded.coordinator_id, allocated_by = excluded.allocated_by,
    allocated_at = case when boh_order_allocations.coordinator_id is distinct from excluded.coordinator_id then now() else boh_order_allocations.allocated_at end;
  update boh_orders set coordinator_id = p_coordinator, allocated_by = auth.uid() where id = p_order;
  insert into boh_order_events (order_id, event, note, actor) values (p_order, 'allocated', 'ALL → ' || v_name, auth.uid());
  perform boh_sync_order(p_order);
end $$;
revoke execute on function public.boh_allocate_order_to(uuid, uuid) from public, anon;
grant execute on function public.boh_allocate_order_to(uuid, uuid) to authenticated;

-- the coordinator on an order also counts when coordinator_id is set on the order itself
create or replace function public.boh_on_order(p_order uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from boh_order_allocations where order_id = p_order and coordinator_id = auth.uid())
      or exists (select 1 from boh_orders where id = p_order and coordinator_id = auth.uid())
$$;

-- ---------------------------------------------------------------- move the whole order one step
create or replace function public.boh_advance_order_all(p_order uuid, p_step text, p_note text default null, p_overheads jsonb default '[]')
returns void language plpgsql security definer set search_path = public as $$
declare o boh_orders; a record; oh jsonb; moved int := 0;
  steps text[] := array['allocated','acknowledged','vendor_ordered','followup1','followup2','delivered'];
  want int := array_position(array['allocated','acknowledged','vendor_ordered','followup1','followup2','delivered'], p_step);
  cur int;
begin
  select * into o from boh_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if not (boh_is_staff() or boh_on_order(p_order)) then raise exception 'This order is not allocated to you'; end if;
  if o.status = 'cancelled' then raise exception 'Order is cancelled'; end if;
  if want is null or want < 2 then raise exception 'Unknown step %', p_step; end if;
  if (select count(distinct category_id) from boh_order_items where order_id = p_order)
     > (select count(*) from boh_order_allocations where order_id = p_order) then
    raise exception 'Allocate the order to a coordinator first';
  end if;
  for a in select * from boh_order_allocations where order_id = p_order for update loop
    cur := array_position(steps, a.status);
    if cur >= want then continue; end if;
    -- delivery may skip remaining follow-ups once the vendor order is placed
    if not (cur = want - 1 or (p_step = 'delivered' and cur >= 3)) then
      raise exception 'Cannot move to % yet — % is at %', p_step, a.category_name, a.status;
    end if;
    update boh_order_allocations set status = p_step,
      acknowledged_at = case when p_step = 'acknowledged' then now() else acknowledged_at end,
      vendor_ordered_at = case when p_step = 'vendor_ordered' then now() else vendor_ordered_at end,
      followup1_at = case when p_step = 'followup1' then now() else followup1_at end,
      followup1_note = case when p_step = 'followup1' then p_note else followup1_note end,
      followup2_at = case when p_step = 'followup2' then now() else followup2_at end,
      followup2_note = case when p_step = 'followup2' then p_note else followup2_note end,
      delivered_at = case when p_step = 'delivered' then now() else delivered_at end
    where id = a.id;
    moved := moved + 1;
  end loop;
  if moved = 0 then raise exception 'Order is already past this step'; end if;
  if p_step = 'delivered' then
    for oh in select * from jsonb_array_elements(coalesce(p_overheads, '[]')) loop
      if coalesce((oh->>'amount')::numeric, 0) > 0 then
        insert into boh_order_overheads (order_id, kind, amount, note, created_by)
        values (p_order, coalesce(nullif(oh->>'kind',''), 'Other'), (oh->>'amount')::numeric, nullif(oh->>'note',''), auth.uid());
      end if;
    end loop;
  end if;
  insert into boh_order_events (order_id, event, note, actor) values (p_order, p_step, 'Whole order' || coalesce(' · ' || p_note, ''), auth.uid());
  perform boh_sync_order(p_order);
end $$;
revoke execute on function public.boh_advance_order_all(uuid, text, text, jsonb) from public, anon;
grant execute on function public.boh_advance_order_all(uuid, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------- vendor alternatives for an order line
create or replace function public.boh_vendor_options(p_order uuid)
returns table (product_id uuid, vendor_id uuid, vendor_name text, phones text[], delivery_style text, rate numeric, skipped boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (boh_is_staff() or boh_on_order(p_order)) then raise exception 'not allowed'; end if;
  return query
  select r.product_id, v.id, v.name, v.phones, v.delivery_style, r.rate,
         exists (select 1 from boh_order_vendor_skips s where s.order_id = p_order and s.vendor_id = v.id)
    from boh_vendor_rates r join boh_vendors v on v.id = r.vendor_id
   where r.active and v.active and r.product_id in (select i.product_id from boh_order_items i where i.order_id = p_order)
   order by r.product_id, r.rate;
end $$;
revoke execute on function public.boh_vendor_options(uuid) from public, anon;
grant execute on function public.boh_vendor_options(uuid) to authenticated;

-- move every line of p_vendor on this order to another vendor.
-- p_mode: 'skip' = not for this order only, 'disable' = make the vendor inactive (never used again until re-activated)
-- p_target: a specific vendor, or null = next cheapest active vendor not skipped.
-- returns lines that could not be moved (no other vendor has a rate).
create or replace function public.boh_reassign_vendor(p_order uuid, p_vendor uuid, p_mode text, p_target uuid default null, p_reason text default null)
returns table (product_name text) language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare o boh_orders; it boh_order_items; alt record; vname text; moved int := 0; who text;
begin
  select * into o from boh_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if not (boh_is_staff() or boh_on_order(p_order)) then raise exception 'This order is not allocated to you'; end if;
  if o.status in ('cancelled','delivered','paid') then raise exception 'Order is closed'; end if;
  if p_mode not in ('skip','disable') then raise exception 'Choose skip or disable'; end if;
  if p_target = p_vendor then raise exception 'Pick a different vendor'; end if;
  select name into vname from boh_vendors where id = p_vendor;
  select full_name into who from boh_users where id = auth.uid();

  insert into boh_order_vendor_skips (order_id, vendor_id, mode, reason, created_by)
  values (p_order, p_vendor, p_mode, p_reason, auth.uid())
  on conflict (order_id, vendor_id) do update set mode = excluded.mode, reason = coalesce(excluded.reason, boh_order_vendor_skips.reason);

  if p_mode = 'disable' then
    update boh_vendors set active = false, disabled_reason = coalesce(p_reason, 'Not responding'), disabled_at = now(), disabled_by = auth.uid()
     where id = p_vendor;
  end if;

  for it in select * from boh_order_items where order_id = p_order and vendor_id = p_vendor loop
    select v.id, v.name, v.delivery_style, r.rate into alt
      from boh_vendor_rates r join boh_vendors v on v.id = r.vendor_id
     where r.product_id = it.product_id and r.active and v.active and v.id <> p_vendor
       and (p_target is null or v.id = p_target)
       and (p_target is not null or not exists (select 1 from boh_order_vendor_skips s where s.order_id = p_order and s.vendor_id = v.id))
     order by r.rate, r.updated_at desc limit 1;
    if not found then
      product_name := it.product_name; return next;
      continue;
    end if;
    update boh_order_items set vendor_id = alt.id, vendor_name = alt.name, delivery_style = alt.delivery_style, unit_cost = alt.rate,
      margin_pct = case when alt.rate > 0 then round((unit_price / alt.rate - 1) * 100, 2) else null end
     where id = it.id;
    moved := moved + 1;
  end loop;

  update boh_orders set cost_total = coalesce((select sum(coalesce(unit_cost, 0) * qty) from boh_order_items where order_id = p_order), 0)
   where id = p_order;
  insert into boh_order_events (order_id, event, note, actor)
  values (p_order, 'vendor_changed', coalesce(vname, 'Vendor') || ' ' || case when p_mode = 'disable' then 'disabled' else 'skipped for this order' end ||
    ' · ' || moved || ' line(s) moved' || coalesce(' · ' || p_reason, ''), auth.uid());
  if p_mode = 'disable' then
    perform boh_notify_admins(o.restaurant_id, 'vendor_disabled', 'Vendor disabled: ' || coalesce(vname, ''),
      '🚫 *Vendor disabled:* ' || coalesce(vname, '') || E'\nBy ' || coalesce(who, 'team') || ' on order #' || o.order_no ||
      coalesce(E'\nReason: ' || p_reason, '') || E'\nRe-activate it in Vendors if this was a mistake.', p_order, 'vdis:' || p_vendor || ':' || p_order);
  end if;
end $$;
revoke execute on function public.boh_reassign_vendor(uuid, uuid, text, uuid, text) from public, anon;
grant execute on function public.boh_reassign_vendor(uuid, uuid, text, uuid, text) to authenticated;

-- ---------------------------------------------------------------- "found it cheaper" from restaurants
create table if not exists public.boh_price_reports (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.boh_restaurants(id) on delete cascade,
  product_id uuid references public.boh_products(id) on delete set null,
  product_name text not null,
  unit text,
  our_price numeric(12,2),
  reported_price numeric(12,2) not null check (reported_price > 0),
  vendor_name text not null,
  vendor_contact text not null,
  note text,
  status text not null default 'new' check (status in ('new','reviewing','matched','rejected')),
  admin_note text,
  created_by uuid references public.boh_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists boh_price_reports_idx on public.boh_price_reports(status, created_at desc);
alter table public.boh_price_reports enable row level security;
drop policy if exists boh_pr_read on public.boh_price_reports;
create policy boh_pr_read on public.boh_price_reports for select to authenticated using (boh_is_staff() or restaurant_id = boh_my_restaurant());
drop policy if exists boh_pr_staff on public.boh_price_reports;
create policy boh_pr_staff on public.boh_price_reports for update to authenticated using (boh_is_staff()) with check (boh_is_staff());
drop policy if exists boh_pr_del on public.boh_price_reports;
create policy boh_pr_del on public.boh_price_reports for delete to authenticated using (boh_is_staff());

create or replace function public.boh_report_cheaper(p_product uuid, p_price numeric, p_vendor text, p_contact text, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare r uuid := boh_my_restaurant(); p boh_products; v_id uuid;
begin
  if r is null then raise exception 'Only restaurant logins can report prices'; end if;
  if coalesce(p_price, 0) <= 0 then raise exception 'Enter the price you were offered'; end if;
  if coalesce(trim(p_vendor), '') = '' then raise exception 'Enter the vendor name'; end if;
  if coalesce(trim(p_contact), '') = '' then raise exception 'Enter the vendor contact number'; end if;
  select * into p from boh_products where id = p_product;
  if not found then raise exception 'Product not found'; end if;
  if not exists (select 1 from boh_restaurant_products where restaurant_id = r and product_id = p_product and active) then
    raise exception 'This product is not on your ordering list';
  end if;
  insert into boh_price_reports (restaurant_id, product_id, product_name, unit, our_price, reported_price, vendor_name, vendor_contact, note, created_by)
  values (r, p.id, p.name, p.unit, boh_selling_price(r, p.id), p_price, trim(p_vendor), trim(p_contact), nullif(trim(p_note), ''), auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.boh_report_cheaper(uuid, numeric, text, text, text) from public, anon;
grant execute on function public.boh_report_cheaper(uuid, numeric, text, text, text) to authenticated;

create or replace function public.boh_tr_price_report() returns trigger
language plpgsql security definer set search_path = public as $$
declare rname text;
begin
  select name into rname from boh_restaurants where id = new.restaurant_id;
  perform boh_notify_admins(new.restaurant_id, 'price_report', 'Cheaper vendor reported — ' || new.product_name,
    '💡 *Cheaper vendor reported* by ' || coalesce(rname, 'a restaurant') ||
    E'\nProduct: ' || new.product_name ||
    E'\nTheir price: ' || boh_inr(new.reported_price) || coalesce(' / ' || new.unit, '') || ' · Ours: ' || coalesce(boh_inr(new.our_price), '—') ||
    E'\nVendor: ' || new.vendor_name || ' · ' || new.vendor_contact || coalesce(E'\nNote: ' || new.note, '') ||
    E'\nReview in Requests → Cheaper vendors.', null, 'price:' || new.id);
  return new;
end $$;
drop trigger if exists boh_tr_price_report on public.boh_price_reports;
create trigger boh_tr_price_report after insert on public.boh_price_reports for each row execute function public.boh_tr_price_report();

-- ---------------------------------------------------------------- pending balances
-- due = delivered (or pre-pay) and not paid; under_review = restaurant says paid; upcoming = pay on delivery, not yet delivered
create or replace function public.boh_balances(p_restaurant uuid default null)
returns table (restaurant_id uuid, due numeric, due_orders int, overdue numeric, under_review numeric, upcoming numeric, pending numeric)
language plpgsql stable security definer set search_path = public as $$
declare s boh_settings; mine uuid := boh_my_restaurant();
begin
  if not boh_is_team() then
    if mine is null then raise exception 'not allowed'; end if;
    p_restaurant := mine;
  end if;
  select * into s from boh_settings where id = 1;
  return query
  select o.restaurant_id,
    coalesce(sum(o.total) filter (where o.payment_status = 'unpaid' and (o.delivered_at is not null or o.payment_mode = 'prepaid')), 0),
    (count(*) filter (where o.payment_status = 'unpaid' and (o.delivered_at is not null or o.payment_mode = 'prepaid')))::int,
    coalesce(sum(o.total) filter (where o.payment_status = 'unpaid' and o.delivered_at is not null
      and now() > boh_add_working_hours(o.delivered_at, s.sla_payment_hrs)), 0),
    coalesce(sum(o.total) filter (where o.payment_status = 'under_review'), 0),
    coalesce(sum(o.total) filter (where o.payment_status = 'unpaid' and o.delivered_at is null and o.payment_mode <> 'prepaid'), 0),
    coalesce(sum(o.total) filter (where o.payment_status <> 'paid'), 0)
  from boh_orders o
  where o.status <> 'cancelled' and o.payment_status <> 'paid'
    and (p_restaurant is null or o.restaurant_id = p_restaurant)
  group by o.restaurant_id;
end $$;
revoke execute on function public.boh_balances(uuid) from public, anon;
grant execute on function public.boh_balances(uuid) to authenticated;

-- ---------------------------------------------------------------- notifications: one message per order
create or replace function public.boh_tr_order_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare o boh_orders; r boh_restaurants; s boh_settings; a boh_order_allocations; co boh_users; cat text; items text; n int; body text;
begin
  select * into o from boh_orders where id = new.order_id;
  select * into r from boh_restaurants where id = o.restaurant_id;
  select * into s from boh_settings where id = 1;

  if new.event = 'placed' then
    select count(*) into n from boh_order_items where order_id = o.id;
    perform boh_notify_restaurant(o.restaurant_id, 'order_placed', 'Order #' || o.order_no || ' received',
      '✅ *Order #' || o.order_no || ' received*' || E'\n' || n || ' items · ' || boh_inr(o.total) ||
      E'\nDelivery: ' || to_char(o.delivery_date, 'Dy DD Mon') ||
      E'\nPayment: ' || case when o.payment_mode = 'prepaid' then 'Pre-pay — please pay now from the app (My orders → Pay now)' else 'Pay on delivery' end ||
      E'\n\nYour coordinator details will follow shortly.\n— ' || s.company_name, o.id, 'placed:' || o.id);
    perform boh_notify_admins(o.restaurant_id, 'order_new', 'New order #' || o.order_no || ' — ' || r.name,
      '🆕 *New order #' || o.order_no || '* — ' || r.name || E'\n' || n || ' items · ' || boh_inr(o.total) ||
      ' · ' || case when o.payment_mode = 'prepaid' then 'Pre-pay' else 'Pay on delivery' end ||
      E'\nDelivery: ' || to_char(o.delivery_date, 'Dy DD Mon') ||
      E'\nAllocate by ' || boh_ist(boh_add_working_hours(o.created_at, s.sla_allocate_hrs)) || ' (Orders & allocation).', o.id, 'new:' || o.id);

  elsif new.event = 'allocated' and new.note like 'ALL → %' then
    select * into co from boh_users where id = o.coordinator_id;
    if not found then return new; end if;
    -- vendor-wise list with phone numbers so the coordinator knows whom to call
    select string_agg(vline, E'\n\n' order by vname) into items from (
      select coalesce(i.vendor_name, 'No vendor yet') vname,
             '🏪 *' || coalesce(i.vendor_name, 'No vendor yet') || '*' || coalesce(' · ' || nullif(array_to_string(v.phones, ' / '), ''), '') ||
             coalesce(' · ' || replace(i.delivery_style, '_', ' '), '') || E'\n' ||
             string_agg('• ' || i.product_name || ' — ' || trim(to_char(i.qty, 'FM999999990.###')) || ' ' || coalesce(i.unit, ''), E'\n' order by i.product_name) vline
        from boh_order_items i left join boh_vendors v on v.id = i.vendor_id
       where i.order_id = o.id
       group by i.vendor_name, v.phones, i.delivery_style) t;
    perform boh_enqueue_user(co.id, 'allocated', 'Allocated: order #' || o.order_no || ' — ' || r.name,
      '📋 *Allocated to you: order #' || o.order_no || '*' || E'\n' || r.name || coalesce(' · ' || r.phone, '') ||
      E'\nDelivery: ' || to_char(o.delivery_date, 'Dy DD Mon') || coalesce(E'\nAddress: ' || r.address, '') ||
      E'\n\n' || coalesce(items, '') ||
      E'\n\nVendor not responding? Open the order → Change vendor.' ||
      E'\nAcknowledge by ' || boh_ist(boh_add_working_hours(now(), s.sla_ack_hrs)) || ' (My assigned orders).', o.id,
      'alloc:' || o.id || ':' || co.id);
    perform boh_notify_restaurant(o.restaurant_id, 'coordinator', 'Order #' || o.order_no || ' — your coordinator',
      '👤 Order #' || o.order_no || ' is handled by *' || co.full_name || '*' || coalesce(' (' || co.phone || ')', '') || E'\n— ' || s.company_name,
      o.id, 'coord:' || o.id || ':' || co.id);

  elsif new.event = 'allocated' then
    -- older per-category allocation
    cat := split_part(new.note, ' → ', 1);
    select * into a from boh_order_allocations where order_id = o.id and category_name = cat;
    if not found then return new; end if;
    select * into co from boh_users where id = a.coordinator_id;
    select string_agg('• ' || i.product_name || ' — ' || trim(to_char(i.qty, 'FM999999990.###')) || ' ' || coalesce(i.unit, '') ||
        coalesce(' (' || i.vendor_name || coalesce(' ' || array_to_string(v.phones, '/'), '') || ')', ''), E'\n' order by i.vendor_name, i.product_name)
      into items
      from boh_order_items i left join boh_vendors v on v.id = i.vendor_id
      where i.order_id = o.id and i.category_id = a.category_id;
    perform boh_enqueue_user(a.coordinator_id, 'allocated', 'Allocated: order #' || o.order_no || ' · ' || cat,
      '📋 *Allocated to you: order #' || o.order_no || '*' || E'\n' || r.name || coalesce(' · ' || r.phone, '') || E'\nCategory: ' || cat ||
      E'\nDelivery: ' || to_char(o.delivery_date, 'Dy DD Mon') || coalesce(E'\nAddress: ' || r.address, '') ||
      E'\n\n' || coalesce(items, '') ||
      E'\n\nAcknowledge by ' || boh_ist(boh_add_working_hours(a.allocated_at, s.sla_ack_hrs)) || ' (My assigned orders).', o.id,
      'alloc:' || a.id || ':' || a.coordinator_id);
    perform boh_notify_restaurant(o.restaurant_id, 'coordinator', 'Order #' || o.order_no || ' — your coordinator for ' || cat,
      '👤 Order #' || o.order_no || ' — *' || cat || '* is handled by ' || co.full_name || coalesce(' (' || co.phone || ')', '') || E'\n— ' || s.company_name,
      o.id, 'coord:' || a.id || ':' || a.coordinator_id);

  elsif new.event = 'delivered' and new.note not like 'Whole order%' then
    cat := split_part(new.note, ' · ', 1);
    perform boh_notify_restaurant(o.restaurant_id, 'cat_delivered', 'Order #' || o.order_no || ' — ' || cat || ' delivered',
      '📦 Order #' || o.order_no || ' — *' || cat || '* delivered.' || E'\n— ' || s.company_name, o.id, 'catdel:' || o.id || ':' || cat);

  elsif new.event = 'cancelled' then
    body := '🚫 *Order #' || o.order_no || ' cancelled* — ' || r.name || ' · ' || boh_inr(o.total);
    perform boh_notify_restaurant(o.restaurant_id, 'cancelled', 'Order #' || o.order_no || ' cancelled', body || E'\nPlease contact us if this is unexpected.\n— ' || s.company_name, o.id, 'cancel:' || o.id);
    perform boh_notify_coordinators(o.id, 'cancelled', 'Order #' || o.order_no || ' cancelled', body, 'cancel:' || o.id);
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- SLA reminders per order (not per category)
create or replace function public.boh_sla_scan() returns void
language plpgsql security definer set search_path = public as $$
declare s boh_settings; ist timestamp := now() at time zone 'Asia/Kolkata'; mins numeric; in_hours boolean; rec record; due timestamptz; nxt text; coname text;
begin
  select * into s from boh_settings where id = 1;
  if ist::time >= s.report_time and not exists (select 1 from boh_notifications where dedupe_key = 'report:' || ist::date) then
    perform boh_send_daily_report(ist::date, false);
  end if;
  mins := extract(hour from ist) * 60 + extract(minute from ist);
  in_hours := extract(isodow from ist)::int = any (s.work_days)
    and mins >= extract(hour from s.work_start) * 60 + extract(minute from s.work_start)
    and mins < extract(hour from s.work_end) * 60 + extract(minute from s.work_end);
  if not in_hours then return; end if;

  for rec in select o.*, rr.name rname from boh_orders o join boh_restaurants rr on rr.id = o.restaurant_id where o.status = 'placed' loop
    due := boh_add_working_hours(rec.created_at, s.sla_allocate_hrs);
    if now() > due then
      perform boh_notify_admins(rec.restaurant_id, 'sla_overdue', 'OVERDUE: allocate order #' || rec.order_no,
        '⏰ *Overdue:* order #' || rec.order_no || ' (' || rec.rname || ') is not allocated to a coordinator. Was due ' || boh_ist(due) || '.', rec.id, 'alloc-over:' || rec.id);
    elsif due - now() <= interval '30 minutes' then
      perform boh_notify_admins(rec.restaurant_id, 'sla_soon', 'Allocate order #' || rec.order_no || ' by ' || boh_ist(due),
        '⏳ Allocate order #' || rec.order_no || ' (' || rec.rname || ') by ' || boh_ist(due) || '.', rec.id, 'alloc-soon:' || rec.id);
    end if;
  end loop;

  -- one reminder per order and step (the order status is the slowest category)
  for rec in select o.id order_id, o.order_no, o.restaurant_id, o.delivery_date, o.status, rr.name rname,
        max(a.allocated_at) allocated_at, max(a.acknowledged_at) acknowledged_at, max(a.vendor_ordered_at) vendor_ordered_at,
        max(a.followup1_at) followup1_at
      from boh_orders o join boh_restaurants rr on rr.id = o.restaurant_id join boh_order_allocations a on a.order_id = o.id
      where o.status in ('allocated','acknowledged','vendor_ordered','followup1','followup2')
      group by o.id, rr.name loop
    due := case rec.status
      when 'allocated' then boh_add_working_hours(rec.allocated_at, s.sla_ack_hrs)
      when 'acknowledged' then boh_add_working_hours(rec.acknowledged_at, s.sla_vendor_order_hrs)
      when 'vendor_ordered' then boh_add_working_hours(rec.vendor_ordered_at, s.sla_followup1_hrs)
      when 'followup1' then boh_add_working_hours(rec.followup1_at, s.sla_followup2_hrs)
      else (rec.delivery_date + s.work_end) at time zone 'Asia/Kolkata' end;
    if due is null then continue; end if;
    nxt := case rec.status when 'allocated' then 'acknowledge' when 'acknowledged' then 'place the order with the vendor'
      when 'vendor_ordered' then 'take the 1st follow-up' when 'followup1' then 'take the 2nd follow-up' else 'deliver' end;
    select string_agg(distinct u.full_name, ', ') into coname from boh_order_allocations a join boh_users u on u.id = a.coordinator_id where a.order_id = rec.order_id;
    if now() > due then
      perform boh_notify_coordinators(rec.order_id, 'sla_overdue', 'OVERDUE: order #' || rec.order_no,
        '⏰ *Overdue:* ' || nxt || ' — order #' || rec.order_no || ' (' || rec.rname || '). Was due ' || boh_ist(due) || '.',
        'sla-over:' || rec.order_id || ':' || rec.status);
      perform boh_notify_admins(rec.restaurant_id, 'sla_overdue', 'OVERDUE: order #' || rec.order_no,
        '⏰ *Overdue:* ' || nxt || ' — order #' || rec.order_no || ' (' || rec.rname || ') · coordinator ' || coalesce(coname, '—') ||
        '. Was due ' || boh_ist(due) || '.', rec.order_id, 'sla-over:' || rec.order_id || ':' || rec.status);
    elsif due - now() <= interval '30 minutes' then
      perform boh_notify_coordinators(rec.order_id, 'sla_soon', 'Due soon: order #' || rec.order_no,
        '⏳ Please ' || nxt || ' for order #' || rec.order_no || ' (' || rec.rname || ') by ' || boh_ist(due) || '.',
        'sla-soon:' || rec.order_id || ':' || rec.status);
    end if;
  end loop;

  for rec in select o.* from boh_orders o where o.status <> 'cancelled' and o.payment_status = 'unpaid'
      and (o.delivered_at is not null or o.payment_mode = 'prepaid') loop
    due := case when rec.delivered_at is not null then boh_add_working_hours(rec.delivered_at, s.sla_payment_hrs)
                else boh_add_working_hours(rec.created_at, 2) end;
    if now() > due then
      perform boh_notify_restaurant(rec.restaurant_id, 'payment_reminder', 'Payment reminder — order #' || rec.order_no,
        '🔔 *Payment reminder* — order #' || rec.order_no || ': ' || boh_inr(rec.total) || ' is due.' ||
        E'\nApp → My orders → Pay now, then tap “I''ve already paid”.\n— ' || s.company_name, rec.id, 'payrem:' || rec.id || ':' || (now() at time zone 'Asia/Kolkata')::date);
      if rec.delivered_at is not null then
        perform boh_notify_coordinators(rec.id, 'payment_overdue', 'Payment overdue — order #' || rec.order_no,
          '💰 *Payment overdue* — order #' || rec.order_no || ': ' || boh_inr(rec.total) || '. Please follow up with the restaurant.', 'payover:' || rec.id);
      end if;
    end if;
  end loop;
end $$;
