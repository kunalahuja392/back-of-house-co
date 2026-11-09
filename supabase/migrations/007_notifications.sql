-- =====================================================================
-- Notifications: email (Brevo, free tier) + WhatsApp (self-hosted WhatsApp Web bot)
-- Everything is queued in boh_notifications; senders pick rows up from there.
-- =====================================================================

alter table public.boh_settings
  add column if not exists notify_email boolean not null default true,
  add column if not exists notify_whatsapp boolean not null default true,
  add column if not exists report_time time not null default '21:00',
  add column if not exists report_emails text,
  add column if not exists report_phones text,
  add column if not exists email_from text,
  add column if not exists email_from_name text default 'Back of House Co',
  add column if not exists bot_last_seen timestamptz;

-- private key/value store (cron secret, bot secret, Brevo API key). No policies: only server-side code can read it.
create table if not exists public.boh_private (key text primary key, value text not null, updated_at timestamptz not null default now());
alter table public.boh_private enable row level security;
revoke all on public.boh_private from anon, authenticated;
insert into public.boh_private (key, value) values
  ('cron_secret', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  ('bot_secret', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

create table if not exists public.boh_notifications (
  id bigserial primary key,
  channel text not null check (channel in ('email','whatsapp')),
  user_id uuid references public.boh_users(id) on delete set null,
  address text not null,
  name text,
  event text not null,
  subject text,
  body text not null,
  order_id uuid references public.boh_orders(id) on delete set null,
  dedupe_key text,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','skipped')),
  attempts int not null default 0,
  error text,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists boh_notif_pending_idx on public.boh_notifications(channel, status, id);
create unique index if not exists boh_notif_dedupe_idx on public.boh_notifications(dedupe_key, channel, address) where dedupe_key is not null;
alter table public.boh_notifications enable row level security;
create policy boh_notif_read on public.boh_notifications for select to authenticated using (boh_is_staff());
create policy boh_notif_update on public.boh_notifications for update to authenticated using (boh_is_staff()) with check (boh_is_staff());

-- ---------------------------------------------------------------- helpers
create or replace function public.boh_norm_phone(p text) returns text
language sql immutable as $$
  select case
    when d is null or length(d) < 10 then null
    when length(d) = 10 then '91' || d
    when length(d) = 11 and left(d, 1) = '0' then '91' || substr(d, 2)
    else d end
  from (select nullif(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '') as d) x
$$;

create or replace function public.boh_inr(n numeric) returns text
language sql immutable as $$ select '₹' || to_char(coalesce(n, 0), 'FM99,99,99,99,990.00') $$;

create or replace function public.boh_ist(ts timestamptz) returns text
language sql stable as $$ select to_char(ts at time zone 'Asia/Kolkata', 'DD Mon, HH12:MI AM') $$;

-- working-hours arithmetic (same rules as the app): Asia/Kolkata, work days + work start/end from settings
create or replace function public.boh_add_working_hours(p_ts timestamptz, p_hrs numeric) returns timestamptz
language plpgsql stable set search_path = public as $$
declare s boh_settings; t timestamp; remaining numeric; startm numeric; endm numeric; mins numeric; avail numeric; i int := 0;
begin
  if p_ts is null or p_hrs is null then return null; end if;
  select * into s from boh_settings where id = 1;
  t := p_ts at time zone 'Asia/Kolkata';
  remaining := p_hrs * 60;
  startm := extract(hour from s.work_start) * 60 + extract(minute from s.work_start);
  endm := extract(hour from s.work_end) * 60 + extract(minute from s.work_end);
  while remaining > 0 and i < 400 loop
    i := i + 1;
    mins := extract(epoch from (t - date_trunc('day', t))) / 60;
    if not (extract(isodow from t)::int = any (s.work_days)) or mins >= endm then
      t := date_trunc('day', t) + interval '1 day' + make_interval(mins => startm::int); continue;
    end if;
    if mins < startm then t := date_trunc('day', t) + make_interval(mins => startm::int); continue; end if;
    avail := endm - mins;
    if remaining <= avail then t := t + make_interval(secs => remaining * 60); remaining := 0;
    else remaining := remaining - avail; t := date_trunc('day', t) + interval '1 day' + make_interval(mins => startm::int); end if;
  end loop;
  return t at time zone 'Asia/Kolkata';
end $$;

-- ---------------------------------------------------------------- enqueue
create or replace function public.boh_enqueue_addr(p_channel text, p_address text, p_name text, p_event text, p_subject text, p_body text,
  p_order uuid default null, p_dedupe text default null, p_user uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare s boh_settings; addr text;
begin
  select * into s from boh_settings where id = 1;
  if p_channel = 'email' then
    if not s.notify_email then return; end if;
    addr := lower(trim(p_address));
    if addr is null or addr !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return; end if;
  else
    if not s.notify_whatsapp then return; end if;
    addr := boh_norm_phone(p_address);
    if addr is null then return; end if;
  end if;
  insert into boh_notifications (channel, user_id, address, name, event, subject, body, order_id, dedupe_key)
  values (p_channel, p_user, addr, p_name, p_event, p_subject, p_body, p_order, p_dedupe)
  on conflict do nothing;
end $$;

create or replace function public.boh_enqueue_user(p_user uuid, p_event text, p_subject text, p_body text,
  p_order uuid default null, p_dedupe text default null) returns void
language plpgsql security definer set search_path = public as $$
declare u boh_users;
begin
  select * into u from boh_users where id = p_user and active;
  if not found then return; end if;
  perform boh_enqueue_addr('email', u.email, u.full_name, p_event, p_subject, p_body, p_order, p_dedupe, u.id);
  perform boh_enqueue_addr('whatsapp', u.phone, u.full_name, p_event, p_subject, p_body, p_order, p_dedupe, u.id);
end $$;

-- every active login of a restaurant; falls back to the restaurant's own phone / email
create or replace function public.boh_notify_restaurant(p_rest uuid, p_event text, p_subject text, p_body text,
  p_order uuid default null, p_dedupe text default null) returns void
language plpgsql security definer set search_path = public as $$
declare u record; r boh_restaurants; has_phone boolean := false; has_email boolean := false;
begin
  select * into r from boh_restaurants where id = p_rest;
  for u in select * from boh_users where restaurant_id = p_rest and role = 'customer' and active loop
    perform boh_enqueue_user(u.id, p_event, p_subject, p_body, p_order, p_dedupe);
    has_phone := has_phone or boh_norm_phone(u.phone) is not null;
    has_email := has_email or u.email is not null;
  end loop;
  if not has_phone then perform boh_enqueue_addr('whatsapp', r.phone, r.name, p_event, p_subject, p_body, p_order, p_dedupe); end if;
  if not has_email then perform boh_enqueue_addr('email', r.email, r.name, p_event, p_subject, p_body, p_order, p_dedupe); end if;
end $$;

-- admins assigned to the restaurant, or every admin if nobody is assigned
create or replace function public.boh_notify_admins(p_rest uuid, p_event text, p_subject text, p_body text,
  p_order uuid default null, p_dedupe text default null) returns void
language plpgsql security definer set search_path = public as $$
declare u record; n int := 0;
begin
  for u in select bu.id from boh_restaurant_admins ra join boh_users bu on bu.id = ra.user_id and bu.active where ra.restaurant_id = p_rest loop
    perform boh_enqueue_user(u.id, p_event, p_subject, p_body, p_order, p_dedupe); n := n + 1;
  end loop;
  if n = 0 then
    for u in select id from boh_users where role in ('admin','super_admin') and active loop
      perform boh_enqueue_user(u.id, p_event, p_subject, p_body, p_order, p_dedupe);
    end loop;
  end if;
end $$;

create or replace function public.boh_notify_coordinators(p_order uuid, p_event text, p_subject text, p_body text, p_dedupe text default null) returns void
language plpgsql security definer set search_path = public as $$
declare u record;
begin
  for u in select distinct coordinator_id from boh_order_allocations where order_id = p_order loop
    perform boh_enqueue_user(u.coordinator_id, p_event, p_subject, p_body, p_order, p_dedupe);
  end loop;
end $$;

-- ---------------------------------------------------------------- order events
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

  elsif new.event = 'allocated' then
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

  elsif new.event = 'delivered' then
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
drop trigger if exists boh_tr_order_event on public.boh_order_events;
create trigger boh_tr_order_event after insert on public.boh_order_events for each row execute function public.boh_tr_order_event();

-- ---------------------------------------------------------------- order status / payment changes
create or replace function public.boh_tr_order_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare r boh_restaurants; s boh_settings;
begin
  select * into r from boh_restaurants where id = new.restaurant_id;
  select * into s from boh_settings where id = 1;
  if new.status = 'delivered' and old.status is distinct from 'delivered' and new.payment_status <> 'paid' then
    perform boh_notify_restaurant(new.restaurant_id, 'delivered_due', 'Order #' || new.order_no || ' delivered — ' || boh_inr(new.total) || ' due',
      '🧾 *Order #' || new.order_no || ' fully delivered.*' || E'\nAmount due: *' || boh_inr(new.total) || '*' ||
      E'\nPlease pay within ' || s.sla_payment_hrs || ' working hours (by ' || boh_ist(boh_add_working_hours(new.delivered_at, s.sla_payment_hrs)) || ')' ||
      E'\nApp → My orders → Pay now, then tap “I''ve already paid”.\n— ' || s.company_name, new.id, 'deldue:' || new.id);
  end if;
  if new.payment_status is distinct from old.payment_status then
    if new.payment_status = 'under_review' then
      perform boh_notify_coordinators(new.id, 'payment_claim', 'Verify payment — order #' || new.order_no,
        '💳 *Payment to verify* — order #' || new.order_no || ' · ' || r.name || E'\nAmount: ' || boh_inr(new.total) ||
        E'\nPaid via: ' || coalesce(new.payment_claim_method, '—') || ' · Ref: ' || coalesce(new.payment_claim_ref, '—') ||
        E'\nApprove or reject in the app.', 'claim:' || new.id || ':' || coalesce(new.payment_claim_ref, ''));
      perform boh_notify_admins(new.restaurant_id, 'payment_claim', 'Verify payment — order #' || new.order_no,
        '💳 *Payment to verify* — order #' || new.order_no || ' · ' || r.name || E'\nAmount: ' || boh_inr(new.total) ||
        E'\nPaid via: ' || coalesce(new.payment_claim_method, '—') || ' · Ref: ' || coalesce(new.payment_claim_ref, '—') ||
        E'\nApprove or reject in the app.', new.id, 'claim:' || new.id || ':' || coalesce(new.payment_claim_ref, ''));
    elsif new.payment_status = 'paid' then
      perform boh_notify_restaurant(new.restaurant_id, 'paid', 'Payment received — order #' || new.order_no,
        '✅ *Payment received* for order #' || new.order_no || ' (' || boh_inr(new.total) || '). Thank you!' || E'\n— ' || s.company_name,
        new.id, 'paid:' || new.id);
    elsif new.payment_status = 'unpaid' and old.payment_status = 'under_review' and new.payment_rejected_note is not null then
      perform boh_notify_restaurant(new.restaurant_id, 'payment_rejected', 'Payment not approved — order #' || new.order_no,
        '❌ *Payment for order #' || new.order_no || ' was not approved.*' || E'\nReason: ' || new.payment_rejected_note ||
        E'\nAmount due: ' || boh_inr(new.total) || E'\nPlease check and pay again from the app (My orders → Pay now).\n— ' || s.company_name,
        new.id, 'reject:' || new.id || ':' || extract(epoch from new.payment_rejected_at)::bigint);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists boh_tr_order_update on public.boh_orders;
create trigger boh_tr_order_update after update of status, payment_status on public.boh_orders for each row execute function public.boh_tr_order_update();

-- ---------------------------------------------------------------- requests, enquiries, complaints
create or replace function public.boh_tr_request() returns trigger
language plpgsql security definer set search_path = public as $$
declare r boh_restaurants; s boh_settings; item text; by_user boh_users;
begin
  select * into r from boh_restaurants where id = new.restaurant_id;
  select * into s from boh_settings where id = 1;
  item := coalesce((select name from boh_products where id = new.product_id), new.item_name, 'item');
  if tg_op = 'INSERT' then
    select * into by_user from boh_users where id = new.requested_by;
    perform boh_notify_admins(new.restaurant_id, 'request', 'Product request — ' || r.name,
      '🙋 *Product request* — ' || r.name || coalesce(' (' || by_user.full_name || coalesce(', ' || by_user.phone, '') || ')', '') ||
      E'\nItem: ' || item || case when new.source = 'slideshow' then ' (from slideshow)' else '' end ||
      coalesce(E'\nNote: ' || new.note, '') || E'\nReview in Product requests.', null, 'req:' || new.id);
  elsif new.status is distinct from old.status and new.status in ('approved','rejected') then
    perform boh_notify_restaurant(new.restaurant_id, 'request_' || new.status, 'Your request: ' || item,
      case when new.status = 'approved' then '✅ *' || item || '* has been added to your ordering list. You can order it now.'
           else '❌ Your request for *' || item || '* was not approved.' end ||
      coalesce(E'\nNote: ' || new.admin_note, '') || E'\n— ' || s.company_name, null, 'reqdone:' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists boh_tr_request on public.boh_product_requests;
create trigger boh_tr_request after insert or update of status on public.boh_product_requests for each row execute function public.boh_tr_request();

create or replace function public.boh_tr_enquiry() returns trigger
language plpgsql security definer set search_path = public as $$
declare r boh_restaurants; u boh_users;
begin
  select * into r from boh_restaurants where id = new.restaurant_id;
  select * into u from boh_users where id = new.created_by;
  perform boh_notify_admins(new.restaurant_id, 'enquiry', 'Enquiry — ' || new.subject || ' — ' || r.name,
    '💬 *Enquiry* — ' || new.subject || E'\nFrom: ' || r.name || coalesce(' · ' || u.full_name, '') || coalesce(' · ' || coalesce(u.phone, r.phone), '') ||
    coalesce(E'\nMessage: ' || new.message, '') || coalesce(E'\nQuantity: ' || new.quantity, '') || E'\nSee Enquiries in the app.', null, 'enq:' || new.id);
  return new;
end $$;
drop trigger if exists boh_tr_enquiry on public.boh_enquiries;
create trigger boh_tr_enquiry after insert on public.boh_enquiries for each row execute function public.boh_tr_enquiry();

create or replace function public.boh_tr_complaint() returns trigger
language plpgsql security definer set search_path = public as $$
declare r boh_restaurants; s boh_settings; ono bigint; body text;
begin
  select * into r from boh_restaurants where id = new.restaurant_id;
  select * into s from boh_settings where id = 1;
  select order_no into ono from boh_orders where id = new.order_id;
  if tg_op = 'INSERT' then
    body := '⚠️ *Complaint* — ' || r.name || coalesce(' · order #' || ono, '') || E'\n' || coalesce(new.category, '') || ': ' || new.subject ||
      coalesce(E'\n' || new.description, '') || E'\nSee Complaints in the app.';
    perform boh_notify_admins(new.restaurant_id, 'complaint', 'Complaint — ' || r.name || ': ' || new.subject, body, new.order_id, 'comp:' || new.id);
    if new.order_id is not null then perform boh_notify_coordinators(new.order_id, 'complaint', 'Complaint — ' || r.name, body, 'comp:' || new.id); end if;
  elsif new.status is distinct from old.status and new.status in ('in_progress','resolved') then
    perform boh_notify_restaurant(new.restaurant_id, 'complaint_' || new.status, 'Your complaint: ' || new.subject,
      case when new.status = 'resolved' then '✅ Your complaint “' || new.subject || '” is resolved.' else '🔧 We are working on your complaint “' || new.subject || '”.' end ||
      coalesce(E'\n' || new.resolution, '') || E'\n— ' || s.company_name, new.order_id, 'compst:' || new.id || ':' || new.status);
  end if;
  return new;
end $$;
drop trigger if exists boh_tr_complaint on public.boh_complaints;
create trigger boh_tr_complaint after insert or update of status on public.boh_complaints for each row execute function public.boh_tr_complaint();

-- ---------------------------------------------------------------- daily report
create or replace function public.boh_daily_report_text(p_day date) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  s boh_settings; d0 timestamptz; d1 timestamptz; m0 timestamptz;
  n_orders int; sales numeric; cost numeric; n_cancel int; oh numeric; oh_lines text;
  n_deliv int; deliv_val numeric; collected numeric; n_coll int; rev_n int; rev_amt numeric;
  dues numeric; n_dues int; dues_lines text; n_unalloc int; n_overdue int;
  n_req int; n_enq int; n_comp int; open_comp int; rest_lines text;
  m_sales numeric; m_cost numeric; m_oh numeric; m_coll numeric;
begin
  select * into s from boh_settings where id = 1;
  d0 := p_day::timestamp at time zone 'Asia/Kolkata'; d1 := d0 + interval '1 day';
  m0 := date_trunc('month', p_day)::timestamp at time zone 'Asia/Kolkata';

  select count(*), coalesce(sum(total), 0), coalesce(sum(cost_total), 0) into n_orders, sales, cost
    from boh_orders where created_at >= d0 and created_at < d1 and status <> 'cancelled';
  select count(*) into n_cancel from boh_orders where cancelled_at >= d0 and cancelled_at < d1;
  select coalesce(sum(amount), 0) into oh from boh_order_overheads where created_at >= d0 and created_at < d1;
  select string_agg('   ' || kind || ': ' || boh_inr(amt), E'\n' order by amt desc) into oh_lines
    from (select kind, sum(amount) amt from boh_order_overheads where created_at >= d0 and created_at < d1 group by kind) k;
  select count(*), coalesce(sum(total), 0) into n_deliv, deliv_val from boh_orders where delivered_at >= d0 and delivered_at < d1 and status <> 'cancelled';
  select count(*), coalesce(sum(total), 0) into n_coll, collected from boh_orders where paid_at >= d0 and paid_at < d1 and payment_status = 'paid';
  select count(*), coalesce(sum(total), 0) into rev_n, rev_amt from boh_orders where payment_status = 'under_review' and status <> 'cancelled';
  select count(*), coalesce(sum(total), 0) into n_dues, dues from boh_orders
    where status <> 'cancelled' and payment_status <> 'paid' and (payment_mode = 'prepaid' or delivered_at is not null);
  select string_agg('   ' || name || ': ' || boh_inr(amt), E'\n' order by amt desc) into dues_lines from (
    select r.name, sum(o.total) amt from boh_orders o join boh_restaurants r on r.id = o.restaurant_id
    where o.status <> 'cancelled' and o.payment_status <> 'paid' and (o.payment_mode = 'prepaid' or o.delivered_at is not null)
    group by r.name order by 2 desc limit 5) x;
  select count(*) into n_unalloc from boh_orders where status = 'placed';
  select count(*) into n_overdue from boh_order_allocations a join boh_orders o on o.id = a.order_id
    where o.status not in ('cancelled','paid') and a.status <> 'delivered' and now() > case a.status
      when 'allocated' then boh_add_working_hours(a.allocated_at, s.sla_ack_hrs)
      when 'acknowledged' then boh_add_working_hours(a.acknowledged_at, s.sla_vendor_order_hrs)
      when 'vendor_ordered' then boh_add_working_hours(a.vendor_ordered_at, s.sla_followup1_hrs)
      when 'followup1' then boh_add_working_hours(a.followup1_at, s.sla_followup2_hrs)
      else (o.delivery_date + s.work_end) at time zone 'Asia/Kolkata' end;
  select count(*) into n_req from boh_product_requests where created_at >= d0 and created_at < d1;
  select count(*) into n_enq from boh_enquiries where created_at >= d0 and created_at < d1;
  select count(*) into n_comp from boh_complaints where created_at >= d0 and created_at < d1;
  select count(*) into open_comp from boh_complaints where status <> 'resolved';
  select string_agg('   ' || name || ': ' || n || ' order(s), ' || boh_inr(sl) || ', profit ' || boh_inr(sl - cs), E'\n' order by sl desc) into rest_lines from (
    select r.name, count(*) n, sum(o.total) sl, sum(o.cost_total) cs from boh_orders o join boh_restaurants r on r.id = o.restaurant_id
    where o.created_at >= d0 and o.created_at < d1 and o.status <> 'cancelled' group by r.name order by 3 desc limit 10) x;
  select coalesce(sum(total), 0), coalesce(sum(cost_total), 0) into m_sales, m_cost from boh_orders where created_at >= m0 and created_at < d1 and status <> 'cancelled';
  select coalesce(sum(amount), 0) into m_oh from boh_order_overheads where created_at >= m0 and created_at < d1;
  select coalesce(sum(total), 0) into m_coll from boh_orders where paid_at >= m0 and paid_at < d1 and payment_status = 'paid';

  return '📊 *' || s.company_name || ' — daily report*' || E'\n' || to_char(p_day, 'Dy, DD Mon YYYY') ||
    E'\n\n*Sales today*' ||
    E'\nOrders: ' || n_orders || ' · Sales: ' || boh_inr(sales) ||
    E'\nCost: ' || boh_inr(cost) || ' · Gross profit: ' || boh_inr(sales - cost) || case when sales > 0 then ' (' || round((sales - cost) / sales * 100, 1) || '%)' else '' end ||
    E'\nOverheads: ' || boh_inr(oh) || coalesce(E'\n' || oh_lines, '') ||
    E'\n*Net profit: ' || boh_inr(sales - cost - oh) || '*' ||
    case when n_cancel > 0 then E'\nCancelled: ' || n_cancel else '' end ||
    E'\n\n*Deliveries & money*' ||
    E'\nDelivered today: ' || n_deliv || ' order(s), ' || boh_inr(deliv_val) ||
    E'\nCollected today: *' || boh_inr(collected) || '* (' || n_coll || ' order(s))' ||
    E'\nPayments to verify: ' || rev_n || ' · ' || boh_inr(rev_amt) ||
    E'\n*Total amount due: ' || boh_inr(dues) || '* (' || n_dues || ' order(s))' || coalesce(E'\n' || dues_lines, '') ||
    E'\n\n*Attention*' ||
    E'\nOrders not allocated: ' || n_unalloc || E'\nOverdue coordinator steps: ' || n_overdue ||
    E'\nNew today — requests: ' || n_req || ', enquiries: ' || n_enq || ', complaints: ' || n_comp || ' (open complaints: ' || open_comp || ')' ||
    case when rest_lines is not null then E'\n\n*By restaurant today*\n' || rest_lines else '' end ||
    E'\n\n*Month to date*' ||
    E'\nSales: ' || boh_inr(m_sales) || ' · Gross profit: ' || boh_inr(m_sales - m_cost) ||
    E'\nOverheads: ' || boh_inr(m_oh) || ' · *Net profit: ' || boh_inr(m_sales - m_cost - m_oh) || '*' ||
    E'\nCollected: ' || boh_inr(m_coll);
end $$;

create or replace function public.boh_send_daily_report(p_day date default null, p_force boolean default false) returns int
language plpgsql security definer set search_path = public as $$
declare s boh_settings; d date; body text; dk text; u record; x text; before int; after int;
begin
  if auth.uid() is not null and coalesce(boh_role(), '') <> 'super_admin' then raise exception 'Only the super admin can send the report'; end if;
  select * into s from boh_settings where id = 1;
  d := coalesce(p_day, (now() at time zone 'Asia/Kolkata')::date);
  body := boh_daily_report_text(d);
  dk := case when p_force then null else 'report:' || d end;
  select count(*) into before from boh_notifications;
  for u in select id from boh_users where role = 'super_admin' and active loop
    perform boh_enqueue_user(u.id, 'daily_report', s.company_name || ' — daily report ' || to_char(d, 'DD Mon YYYY'), body, null, dk);
  end loop;
  for x in select trim(t) from regexp_split_to_table(coalesce(s.report_emails, ''), '[,;\s]+') t where trim(t) <> '' loop
    perform boh_enqueue_addr('email', x, null, 'daily_report', s.company_name || ' — daily report ' || to_char(d, 'DD Mon YYYY'), body, null, dk);
  end loop;
  for x in select trim(t) from regexp_split_to_table(coalesce(s.report_phones, ''), '[,;\s]+') t where trim(t) <> '' loop
    perform boh_enqueue_addr('whatsapp', x, null, 'daily_report', null, body, null, dk);
  end loop;
  select count(*) into after from boh_notifications;
  return after - before;
end $$;

-- ---------------------------------------------------------------- scheduled scan (every 10 min): SLA reminders + daily report
create or replace function public.boh_sla_scan() returns void
language plpgsql security definer set search_path = public as $$
declare s boh_settings; ist timestamp := now() at time zone 'Asia/Kolkata'; mins numeric; in_hours boolean; rec record; due timestamptz; nxt text; r boh_restaurants;
begin
  select * into s from boh_settings where id = 1;
  -- daily report once a day after the report time
  if ist::time >= s.report_time and not exists (select 1 from boh_notifications where dedupe_key = 'report:' || ist::date) then
    perform boh_send_daily_report(ist::date, false);
  end if;
  -- reminders only inside working hours
  mins := extract(hour from ist) * 60 + extract(minute from ist);
  in_hours := extract(isodow from ist)::int = any (s.work_days)
    and mins >= extract(hour from s.work_start) * 60 + extract(minute from s.work_start)
    and mins < extract(hour from s.work_end) * 60 + extract(minute from s.work_end);
  if not in_hours then return; end if;

  -- orders waiting for allocation
  for rec in select o.*, rr.name rname from boh_orders o join boh_restaurants rr on rr.id = o.restaurant_id where o.status = 'placed' loop
    due := boh_add_working_hours(rec.created_at, s.sla_allocate_hrs);
    if now() > due then
      perform boh_notify_admins(rec.restaurant_id, 'sla_overdue', 'OVERDUE: allocate order #' || rec.order_no,
        '⏰ *Overdue:* order #' || rec.order_no || ' (' || rec.rname || ') is not fully allocated. Was due ' || boh_ist(due) || '.', rec.id, 'alloc-over:' || rec.id);
    elsif due - now() <= interval '30 minutes' then
      perform boh_notify_admins(rec.restaurant_id, 'sla_soon', 'Allocate order #' || rec.order_no || ' by ' || boh_ist(due),
        '⏳ Allocate order #' || rec.order_no || ' (' || rec.rname || ') by ' || boh_ist(due) || '.', rec.id, 'alloc-soon:' || rec.id);
    end if;
  end loop;

  -- each category with its coordinator
  for rec in select a.*, o.order_no, o.restaurant_id, o.delivery_date, rr.name rname
      from boh_order_allocations a join boh_orders o on o.id = a.order_id join boh_restaurants rr on rr.id = o.restaurant_id
      where a.status <> 'delivered' and o.status not in ('cancelled','paid') loop
    due := case rec.status
      when 'allocated' then boh_add_working_hours(rec.allocated_at, s.sla_ack_hrs)
      when 'acknowledged' then boh_add_working_hours(rec.acknowledged_at, s.sla_vendor_order_hrs)
      when 'vendor_ordered' then boh_add_working_hours(rec.vendor_ordered_at, s.sla_followup1_hrs)
      when 'followup1' then boh_add_working_hours(rec.followup1_at, s.sla_followup2_hrs)
      else (rec.delivery_date + s.work_end) at time zone 'Asia/Kolkata' end;
    nxt := case rec.status when 'allocated' then 'acknowledge' when 'acknowledged' then 'place the order with the vendor'
      when 'vendor_ordered' then 'take the 1st follow-up' when 'followup1' then 'take the 2nd follow-up' else 'deliver' end;
    if now() > due then
      perform boh_enqueue_user(rec.coordinator_id, 'sla_overdue', 'OVERDUE: order #' || rec.order_no || ' · ' || rec.category_name,
        '⏰ *Overdue:* ' || nxt || ' — order #' || rec.order_no || ' · ' || rec.category_name || ' (' || rec.rname || '). Was due ' || boh_ist(due) || '.',
        rec.order_id, 'sla-over:' || rec.id || ':' || rec.status);
      perform boh_notify_admins(rec.restaurant_id, 'sla_overdue', 'OVERDUE: order #' || rec.order_no || ' · ' || rec.category_name,
        '⏰ *Overdue:* ' || nxt || ' — order #' || rec.order_no || ' · ' || rec.category_name || ' (' || rec.rname || ') · coordinator ' ||
        (select full_name from boh_users where id = rec.coordinator_id) || '. Was due ' || boh_ist(due) || '.', rec.order_id, 'sla-over:' || rec.id || ':' || rec.status);
    elsif due - now() <= interval '30 minutes' then
      perform boh_enqueue_user(rec.coordinator_id, 'sla_soon', 'Due soon: order #' || rec.order_no || ' · ' || rec.category_name,
        '⏳ Please ' || nxt || ' for order #' || rec.order_no || ' · ' || rec.category_name || ' (' || rec.rname || ') by ' || boh_ist(due) || '.',
        rec.order_id, 'sla-soon:' || rec.id || ':' || rec.status);
    end if;
  end loop;

  -- payments overdue after delivery, and pre-pay reminders
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

-- ---------------------------------------------------------------- WhatsApp bot queue (called by the edge function with the service role)
create or replace function public.boh_wa_claim(p_limit int default 10) returns table (id bigint, address text, body text)
language plpgsql security definer set search_path = public as $$
begin
  update boh_settings set bot_last_seen = now() where boh_settings.id = 1;
  -- release rows stuck in "sending" for more than 10 minutes
  update boh_notifications n set status = 'pending' where n.channel = 'whatsapp' and n.status = 'sending' and n.locked_at < now() - interval '10 minutes';
  return query
  update boh_notifications n set status = 'sending', locked_at = now(), attempts = n.attempts + 1
  where n.id in (select x.id from boh_notifications x where x.channel = 'whatsapp' and x.status = 'pending' order by x.id limit p_limit for update skip locked)
  returning n.id, n.address, n.body;
end $$;

-- staff tools
create or replace function public.boh_retry_notification(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not boh_is_staff() then raise exception 'not allowed'; end if;
  update boh_notifications set status = 'pending', error = null, attempts = 0, locked_at = null where id = p_id;
end $$;

create or replace function public.boh_test_notification(p_channel text, p_address text) returns void
language plpgsql security definer set search_path = public as $$
declare s boh_settings;
begin
  if not boh_is_staff() then raise exception 'not allowed'; end if;
  select * into s from boh_settings where id = 1;
  if p_channel = 'email' and not s.notify_email then raise exception 'Email notifications are switched off'; end if;
  if p_channel = 'whatsapp' and not s.notify_whatsapp then raise exception 'WhatsApp notifications are switched off'; end if;
  perform boh_enqueue_addr(p_channel, p_address, null, 'test', s.company_name || ' — test message',
    '👋 Test message from ' || s.company_name || '. If you can read this, ' || p_channel || ' notifications work.', null, null, auth.uid());
end $$;

-- super admin: notification secrets (bot key shown, Brevo key write-only)
create or replace function public.boh_notify_config() returns table (bot_secret text, brevo_configured boolean)
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(boh_role(), '') <> 'super_admin' then raise exception 'Only the super admin'; end if;
  return query select (select value from boh_private where key = 'bot_secret'), exists (select 1 from boh_private where key = 'brevo_api_key' and value <> '');
end $$;

create or replace function public.boh_set_notify_secret(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(boh_role(), '') <> 'super_admin' then raise exception 'Only the super admin'; end if;
  if p_key not in ('brevo_api_key', 'bot_secret') then raise exception 'Unknown key'; end if;
  insert into boh_private (key, value, updated_at) values (p_key, coalesce(p_value, ''), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;

create or replace function public.boh_rotate_bot_secret() returns text
language plpgsql security definer set search_path = public as $$
declare v text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  perform boh_set_notify_secret('bot_secret', v);
  return v;
end $$;

-- grants: internal helpers are not callable from the browser
revoke execute on function public.boh_enqueue_addr(text, text, text, text, text, text, uuid, text, uuid), public.boh_enqueue_user(uuid, text, text, text, uuid, text),
  public.boh_notify_restaurant(uuid, text, text, text, uuid, text), public.boh_notify_admins(uuid, text, text, text, uuid, text),
  public.boh_notify_coordinators(uuid, text, text, text, text), public.boh_sla_scan(), public.boh_wa_claim(int),
  public.boh_daily_report_text(date), public.boh_add_working_hours(timestamptz, numeric)
  from public, anon, authenticated;
revoke execute on function public.boh_send_daily_report(date, boolean), public.boh_retry_notification(bigint), public.boh_test_notification(text, text),
  public.boh_notify_config(), public.boh_set_notify_secret(text, text), public.boh_rotate_bot_secret() from public, anon;
grant execute on function public.boh_send_daily_report(date, boolean), public.boh_retry_notification(bigint), public.boh_test_notification(text, text),
  public.boh_notify_config(), public.boh_set_notify_secret(text, text), public.boh_rotate_bot_secret() to authenticated;
