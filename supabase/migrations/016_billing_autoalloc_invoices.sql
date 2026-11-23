-- 016: billing from the backend, invoices (proforma → invoice), coordinator payment collection,
--      automatic allocation to a default coordinator, proforma + payment-confirmation emails.

-- ---------------------------------------------------------------- settings: company details on bills, default coordinator
alter table public.boh_settings
  add column if not exists default_coordinator_id uuid references public.boh_users(id) on delete set null,
  add column if not exists company_address text,
  add column if not exists company_gstin text,
  add column if not exists company_email text,
  add column if not exists invoice_prefix text not null default 'BOH/',
  add column if not exists invoice_terms text not null default 'Please pay within the agreed time. Goods once delivered and accepted are not returnable. This is a computer-generated bill.',
  add column if not exists portal_url text not null default 'https://ordering.backofhouseco.in';

-- ---------------------------------------------------------------- orders: invoice number, how payment was collected
alter table public.boh_orders
  add column if not exists invoice_no text,
  add column if not exists invoice_date date,
  add column if not exists payment_method text;
create unique index if not exists boh_orders_invoice_no_idx on public.boh_orders(invoice_no) where invoice_no is not null;
create sequence if not exists public.boh_invoice_seq start 1001;

-- an invoice number is issued once the order is delivered or paid (before that the bill is a proforma)
create or replace function public.boh_tr_invoice_no() returns trigger
language plpgsql security definer set search_path = public as $$
declare pre text;
begin
  if new.invoice_no is null and new.status <> 'cancelled'
     and (new.status in ('delivered','paid') or new.payment_status = 'paid' or new.delivered_at is not null) then
    select coalesce(nullif(trim(invoice_prefix), ''), 'BOH/') into pre from boh_settings where id = 1;
    new.invoice_no := pre || nextval('boh_invoice_seq');
    new.invoice_date := (now() at time zone 'Asia/Kolkata')::date;
  end if;
  return new;
end $$;
drop trigger if exists boh_tr_invoice_no on public.boh_orders;
create trigger boh_tr_invoice_no before insert or update on public.boh_orders for each row execute function public.boh_tr_invoice_no();

-- ---------------------------------------------------------------- allocation core (used by admins and by auto-allocation)
create or replace function public.boh_allocate_core(p_order uuid, p_coordinator uuid, p_actor uuid, p_how text default null) returns void
language plpgsql security definer set search_path = public as $$
declare o boh_orders; v_name text;
begin
  select * into o from boh_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status in ('cancelled','paid','delivered') then raise exception 'Order is closed'; end if;
  select full_name into v_name from boh_users where id = p_coordinator and role in ('coordinator','admin','super_admin') and active;
  if v_name is null then raise exception 'Invalid coordinator'; end if;
  if o.coordinator_id = p_coordinator
     and not exists (select 1 from boh_order_items i where i.order_id = p_order and not exists
       (select 1 from boh_order_allocations a where a.order_id = p_order and a.category_id = i.category_id and a.coordinator_id = p_coordinator)) then
    return;
  end if;
  insert into boh_order_allocations (order_id, category_id, category_name, coordinator_id, allocated_by)
  select distinct on (i.category_id) p_order, i.category_id, coalesce(i.category_name, 'Items'), p_coordinator, p_actor
    from boh_order_items i where i.order_id = p_order and i.category_id is not null
  on conflict (order_id, category_id) do update set coordinator_id = excluded.coordinator_id, allocated_by = excluded.allocated_by,
    allocated_at = case when boh_order_allocations.coordinator_id is distinct from excluded.coordinator_id then now() else boh_order_allocations.allocated_at end;
  update boh_orders set coordinator_id = p_coordinator, allocated_by = p_actor where id = p_order;
  insert into boh_order_events (order_id, event, note, actor) values (p_order, 'allocated', 'ALL → ' || v_name || coalesce(' (' || p_how || ')', ''), p_actor);
  perform boh_sync_order(p_order);
end $$;
revoke execute on function public.boh_allocate_core(uuid, uuid, uuid, text) from public, anon, authenticated;

create or replace function public.boh_allocate_order_to(p_order uuid, p_coordinator uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not boh_is_staff() then raise exception 'Only admins can allocate orders'; end if;
  perform boh_allocate_core(p_order, p_coordinator, auth.uid(), null);
end $$;
revoke execute on function public.boh_allocate_order_to(uuid, uuid) from public, anon;
grant execute on function public.boh_allocate_order_to(uuid, uuid) to authenticated;

-- who should get a new order automatically: the coordinator who billed it, else the default coordinator
create or replace function public.boh_auto_coordinator(p_order uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select u.id from boh_orders o join boh_users u on u.id = o.placed_by and u.role = 'coordinator' and u.active where o.id = p_order),
    (select u.id from boh_settings s join boh_users u on u.id = s.default_coordinator_id and u.active
      and u.role in ('coordinator','admin','super_admin') where s.id = 1))
$$;
revoke execute on function public.boh_auto_coordinator(uuid) from public, anon, authenticated;

-- runs after the "placed" notifications (trigger names fire in alphabetical order)
create or replace function public.boh_tr_zz_autoalloc() returns trigger
language plpgsql security definer set search_path = public as $$
declare c uuid; o boh_orders;
begin
  select * into o from boh_orders where id = new.order_id;
  if not found or o.coordinator_id is not null or o.status <> 'placed' then return new; end if;
  c := boh_auto_coordinator(new.order_id);
  if c is not null then perform boh_allocate_core(new.order_id, c, null, 'auto'); end if;
  return new;
end $$;
drop trigger if exists boh_tr_zz_autoalloc on public.boh_order_events;
create trigger boh_tr_zz_autoalloc after insert on public.boh_order_events for each row
  when (new.event = 'placed') execute function public.boh_tr_zz_autoalloc();

-- ---------------------------------------------------------------- text helpers for bills in email / WhatsApp
create or replace function public.boh_bill_lines(p_order uuid) returns text
language sql stable security definer set search_path = public as $$
  select string_agg('• ' || i.product_name || ' — ' || trim(to_char(i.qty, 'FM999999990.###')) || ' ' || coalesce(i.unit, '') ||
         ' × ' || boh_inr(i.unit_price) || ' = *' || boh_inr(i.line_total) || '*', E'\n' order by i.category_name, i.product_name)
  from boh_order_items i where i.order_id = p_order
$$;

create or replace function public.boh_pay_text() returns text
language sql stable security definer set search_path = public as $$
  select nullif(concat_ws(E'\n',
    case when nullif(trim(pay_upi_id), '') is not null then 'UPI: ' || pay_upi_id end,
    case when nullif(trim(bank_account_no), '') is not null then 'Bank: ' || coalesce(bank_name, '') || ' · A/c ' || bank_account_no ||
      coalesce(' · IFSC ' || nullif(bank_ifsc, ''), '') || coalesce(' · ' || nullif(bank_account_name, ''), '') end), '')
  from boh_settings where id = 1
$$;

-- ---------------------------------------------------------------- notifications on order events
create or replace function public.boh_tr_order_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare o boh_orders; r boh_restaurants; s boh_settings; a boh_order_allocations; co boh_users; by_u boh_users;
  cat text; items text; n int; body text; doc text; auto_co text; pay text;
begin
  select * into o from boh_orders where id = new.order_id;
  select * into r from boh_restaurants where id = o.restaurant_id;
  select * into s from boh_settings where id = 1;

  if new.event = 'placed' then
    select count(*) into n from boh_order_items where order_id = o.id;
    select * into by_u from boh_users where id = o.placed_by;
    doc := case when o.invoice_no is not null then 'Invoice ' || o.invoice_no else 'Proforma invoice' end;
    pay := boh_pay_text();
    -- the restaurant gets the bill itself
    perform boh_notify_restaurant(o.restaurant_id, 'order_placed', doc || ' — order #' || o.order_no || ' · ' || boh_inr(o.total),
      '🧾 *' || doc || '* — ' || s.company_name ||
      E'\nOrder #' || o.order_no || ' · ' || to_char(o.created_at at time zone 'Asia/Kolkata', 'DD Mon YYYY') ||
      E'\nBilled to: ' || r.name || coalesce(' · GSTIN ' || nullif(r.gstin, ''), '') ||
      E'\nDelivery: ' || to_char(o.delivery_date, 'Dy DD Mon YYYY') ||
      E'\n\n' || coalesce(boh_bill_lines(o.id), '') ||
      E'\n\n*Total: ' || boh_inr(o.total) || '* (' || n || ' items)' ||
      case when o.payment_status = 'paid' then E'\n✅ Paid' || coalesce(' via ' || o.payment_method, '') || coalesce(' · ref ' || o.payment_ref, '')
           when o.payment_mode = 'prepaid' then E'\nPayment: pre-pay — please pay now' || coalesce(E'\n' || pay, '') || E'\nThen tap “I''ve already paid” in the app (My orders).'
           else E'\nPayment: on delivery' || coalesce(E'\n' || pay, '') end ||
      coalesce(E'\nYour coordinator: ' || (select full_name || coalesce(' (' || phone || ')', '') from boh_users where id = o.coordinator_id), '') ||
      E'\n\nDownload this bill as PDF: ' || s.portal_url || '/#/orders' || E'\n— ' || s.company_name ||
      coalesce(' · ' || nullif(s.support_phone, ''), ''), o.id, 'placed:' || o.id);
    select full_name into auto_co from boh_users where id = boh_auto_coordinator(o.id);
    perform boh_notify_admins(o.restaurant_id, 'order_new',
      case when o.source = 'backend' then 'New bill #' else 'New order #' end || o.order_no || ' — ' || r.name || ' · ' || boh_inr(o.total),
      '🆕 *' || case when o.source = 'backend' then 'Bill created' else 'New order' end || ' #' || o.order_no || '* — ' || r.name ||
      E'\n' || n || ' items · ' || boh_inr(o.total) || ' · ' || case when o.payment_mode = 'prepaid' then 'Pre-pay' else 'Pay on delivery' end ||
      case when o.source = 'backend' then E'\nBilled by ' || coalesce(by_u.full_name, 'team') else '' end ||
      E'\nDelivery: ' || to_char(o.delivery_date, 'Dy DD Mon') ||
      case when o.coordinator_id is not null then E'\nCoordinator: ' || coalesce((select full_name from boh_users where id = o.coordinator_id), '—')
           when auto_co is not null then E'\nAuto-allocated to ' || auto_co || '.'
           else E'\nAllocate by ' || boh_ist(boh_add_working_hours(o.created_at, s.sla_allocate_hrs)) || ' (Orders & allocation).' end,
      o.id, 'new:' || o.id);

  elsif new.event = 'allocated' and new.note like 'ALL → %' then
    select * into co from boh_users where id = o.coordinator_id;
    if not found then return new; end if;
    if co.id is distinct from new.actor then   -- nobody needs an email about an order they billed themselves
      select string_agg(vline, E'\n\n' order by vname) into items from (
        select coalesce(i.vendor_name, 'No vendor yet') vname,
               '🏪 *' || coalesce(i.vendor_name, 'No vendor yet') || '*' || coalesce(' · ' || nullif(array_to_string(v.phones, ' / '), ''), '') ||
               coalesce(' · ' || replace(i.delivery_style, '_', ' '), '') || E'\n' ||
               string_agg('• ' || i.product_name || ' — ' || trim(to_char(i.qty, 'FM999999990.###')) || ' ' || coalesce(i.unit, ''), E'\n' order by i.product_name) vline
          from boh_order_items i left join boh_vendors v on v.id = i.vendor_id
         where i.order_id = o.id
         group by i.vendor_name, v.phones, i.delivery_style) t;
      perform boh_enqueue_user(co.id, 'allocated', 'Allocated to you: order #' || o.order_no || ' — ' || r.name,
        '📋 *Allocated to you: order #' || o.order_no || '*' || E'\n' || r.name || coalesce(' · ' || r.phone, '') ||
        E'\nDelivery: ' || to_char(o.delivery_date, 'Dy DD Mon') || coalesce(E'\nAddress: ' || r.address, '') ||
        E'\n\nWhat to do now:\n1. Acknowledge in the app by ' || boh_ist(boh_add_working_hours(now(), s.sla_ack_hrs)) ||
        E'\n2. Call each vendor below and place the order, then tap “Ordered with vendors”' ||
        E'\n3. Follow up, mark delivered, then collect payment' ||
        E'\n\n' || coalesce(items, '') ||
        E'\n\nVendor not responding? Open the order → ⇄ Change vendor.' ||
        E'\nApp: ' || s.portal_url || '/#/tasks', o.id,
        'alloc:' || o.id || ':' || co.id);
    end if;
    if coalesce(current_setting('boh.quiet', true), '') <> '1' then  -- a backend bill mentions the coordinator in the bill itself
      perform boh_notify_restaurant(o.restaurant_id, 'coordinator', 'Order #' || o.order_no || ' — your coordinator',
        '👤 Order #' || o.order_no || ' is handled by *' || co.full_name || '*' || coalesce(' (' || co.phone || ')', '') || E'\n— ' || s.company_name,
        o.id, 'coord:' || o.id || ':' || co.id);
    end if;

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

  elsif new.event = 'delivered' and new.note not like 'Whole order%' and new.note not like 'Billed%' then
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

-- ---------------------------------------------------------------- delivered / payment notifications (quiet while a backend bill is being created)
create or replace function public.boh_tr_order_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare r boh_restaurants; s boh_settings; by_u text; pay text;
begin
  if coalesce(current_setting('boh.quiet', true), '') = '1' then return new; end if;
  select * into r from boh_restaurants where id = new.restaurant_id;
  select * into s from boh_settings where id = 1;
  if new.status = 'delivered' and old.status is distinct from 'delivered' and new.payment_status <> 'paid' then
    pay := boh_pay_text();
    perform boh_notify_restaurant(new.restaurant_id, 'delivered_due', 'Invoice ' || coalesce(new.invoice_no, '#' || new.order_no) || ' — ' || boh_inr(new.total) || ' due',
      '🧾 *Order #' || new.order_no || ' delivered* — invoice ' || coalesce(new.invoice_no, '') ||
      E'\nAmount due: *' || boh_inr(new.total) || '*' ||
      E'\nPlease pay within ' || s.sla_payment_hrs || ' working hours (by ' || boh_ist(boh_add_working_hours(new.delivered_at, s.sla_payment_hrs)) || ')' ||
      coalesce(E'\n' || pay, '') ||
      E'\nYour coordinator can also collect the payment.\nDownload the invoice: ' || s.portal_url || '/#/orders' || E'\n— ' || s.company_name, new.id, 'deldue:' || new.id);
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
      select full_name into by_u from boh_users where id = new.payment_confirmed_by;
      perform boh_notify_restaurant(new.restaurant_id, 'paid', 'Payment received — ' || boh_inr(new.total) || ' · order #' || new.order_no,
        '✅ *Payment received — thank you!*' ||
        E'\nOrder #' || new.order_no || coalesce(' · Invoice ' || new.invoice_no, '') ||
        E'\nAmount: *' || boh_inr(new.total) || '*' ||
        coalesce(E'\nMethod: ' || coalesce(new.payment_method, new.payment_claim_method), '') ||
        coalesce(E'\nReference: ' || nullif(new.payment_ref, ''), '') ||
        E'\nDate: ' || boh_ist(coalesce(new.paid_at, now())) ||
        E'\n\nDownload the paid invoice: ' || s.portal_url || '/#/orders' || E'\n— ' || s.company_name,
        new.id, 'paid:' || new.id);
      perform boh_notify_admins(new.restaurant_id, 'paid', 'Payment received — order #' || new.order_no || ' · ' || r.name,
        '💰 *Payment received* — order #' || new.order_no || ' · ' || r.name || E'\nAmount: ' || boh_inr(new.total) ||
        coalesce(E'\nMethod: ' || coalesce(new.payment_method, new.payment_claim_method), '') || coalesce(' · ref ' || nullif(new.payment_ref, ''), '') ||
        coalesce(E'\nMarked by ' || by_u, ''), new.id, 'paid-admin:' || new.id);
    elsif new.payment_status = 'unpaid' and old.payment_status = 'under_review' and new.payment_rejected_note is not null then
      perform boh_notify_restaurant(new.restaurant_id, 'payment_rejected', 'Payment not approved — order #' || new.order_no,
        '❌ *Payment for order #' || new.order_no || ' was not approved.*' || E'\nReason: ' || new.payment_rejected_note ||
        E'\nAmount due: ' || boh_inr(new.total) || E'\nPlease check and pay again from the app (My orders → Pay now).\n— ' || s.company_name,
        new.id, 'reject:' || new.id || ':' || extract(epoch from new.payment_rejected_at)::bigint);
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- collect / confirm payment (coordinator on the order or admin)
create or replace function public.boh_collect_payment(p_order uuid, p_method text, p_ref text default null) returns void
language plpgsql security definer set search_path = public as $$
declare o boh_orders;
begin
  if not (boh_is_staff() or boh_on_order(p_order)) then raise exception 'This order is not allocated to you'; end if;
  select * into o from boh_orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status = 'cancelled' then raise exception 'Order is cancelled'; end if;
  if o.payment_status = 'paid' then raise exception 'Payment is already recorded'; end if;
  if coalesce(trim(p_method), '') = '' then raise exception 'Choose how the payment was received'; end if;
  if p_method <> 'Cash' and coalesce(trim(p_ref), '') = '' then raise exception 'Enter the UPI / bank / cheque reference'; end if;
  update boh_orders set payment_status = 'paid', paid_at = now(), payment_confirmed_by = auth.uid(), payment_method = trim(p_method),
    payment_ref = coalesce(nullif(trim(p_ref), ''), case when p_method = 'Cash' then 'Cash' end, payment_claim_ref),
    payment_rejected_note = null, payment_rejected_at = null
  where id = p_order;
  insert into boh_order_events (order_id, event, note, actor) values (p_order, 'payment confirmed', trim(p_method) || coalesce(' · ' || nullif(trim(p_ref), ''), ''), auth.uid());
  perform boh_sync_order(p_order);
end $$;
revoke execute on function public.boh_collect_payment(uuid, text, text) from public, anon;
grant execute on function public.boh_collect_payment(uuid, text, text) to authenticated;

-- approving a restaurant's claim keeps the method they told us
create or replace function public.boh_mark_paid(p_order uuid, p_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare o boh_orders;
begin
  if not (boh_is_staff() or boh_on_order(p_order)) then raise exception 'not allowed'; end if;
  select * into o from boh_orders where id = p_order;
  if o.status = 'cancelled' then raise exception 'Order is cancelled'; end if;
  update boh_orders set payment_status = 'paid', paid_at = now(), payment_confirmed_by = auth.uid(),
    payment_method = coalesce(payment_method, payment_claim_method, 'UPI / bank'),
    payment_ref = coalesce(nullif(trim(p_ref), ''), payment_claim_ref), payment_rejected_note = null, payment_rejected_at = null
  where id = p_order;
  insert into boh_order_events (order_id, event, note, actor) values (p_order, 'payment confirmed', coalesce(nullif(trim(p_ref), ''), o.payment_claim_ref), auth.uid());
  perform boh_sync_order(p_order);
end $$;

-- ---------------------------------------------------------------- bill from the backend (admin or coordinator)
-- p_items: [{product_id, qty, price?}] — price optional (defaults to the restaurant's selling price)
create or replace function public.boh_staff_bill(p_rest uuid, p_items jsonb, p_notes text default null, p_payment_mode text default 'cod',
  p_delivery date default null, p_delivered boolean default false, p_paid_method text default null, p_paid_ref text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare it jsonb; v_qty numeric; v_price numeric; p record; v_order uuid; v_total numeric := 0; v_cost numeric := 0; v_dd date; co uuid; n int := 0;
begin
  if not boh_is_team() then raise exception 'Only our team can create bills'; end if;
  if not exists (select 1 from boh_restaurants where id = p_rest and active) then raise exception 'Choose an active restaurant'; end if;
  if p_payment_mode not in ('prepaid','cod') then raise exception 'Choose pre-pay or pay on delivery'; end if;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then raise exception 'Add at least one item'; end if;
  if p_paid_method is not null and p_paid_method <> 'Cash' and coalesce(trim(p_paid_ref), '') = '' then
    raise exception 'Enter the UPI / bank / cheque reference for the payment';
  end if;
  v_dd := coalesce(p_delivery, case when p_delivered then (now() at time zone 'Asia/Kolkata')::date else boh_base_delivery() end);

  insert into boh_orders (restaurant_id, placed_by, delivery_date, notes, payment_mode, source)
  values (p_rest, auth.uid(), v_dd, nullif(trim(p_notes), ''), p_payment_mode, 'backend') returning id into v_order;

  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := (it->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then continue; end if;
    select pr.id, pr.name, pr.unit, c.id cat_id, c.name cat, b.rate, b.vendor_id, b.vendor_name, b.delivery_style into p
      from boh_products pr join boh_categories c on c.id = pr.category_id
      left join boh_product_best_rate b on b.product_id = pr.id
     where pr.id = (it->>'product_id')::uuid and pr.active;
    if not found then raise exception 'Product not found or inactive'; end if;
    v_price := coalesce(nullif(it->>'price', '')::numeric, boh_selling_price(p_rest, p.id));
    if v_price is null or v_price <= 0 then raise exception '% has no price — enter one', p.name; end if;
    insert into boh_order_items (order_id, product_id, product_name, category_id, category_name, unit, qty, unit_cost, margin_pct,
                                 unit_price, line_total, vendor_id, vendor_name, delivery_style)
    values (v_order, p.id, p.name,
            p.cat_id, p.cat, p.unit, v_qty, p.rate,
            case when p.rate > 0 then round((v_price / p.rate - 1) * 100, 2) end,
            v_price, round(v_price * v_qty, 2), p.vendor_id, p.vendor_name, p.delivery_style);
    v_total := v_total + round(v_price * v_qty, 2);
    v_cost := v_cost + round(coalesce(p.rate, 0) * v_qty, 2);
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'Add at least one item with a quantity'; end if;
  update boh_orders set total = v_total, cost_total = v_cost where id = v_order;

  -- allocate: the coordinator who billed it, else the default coordinator, else the admin who billed it
  co := coalesce(boh_auto_coordinator(v_order), case when boh_is_staff() then auth.uid() end);
  perform set_config('boh.quiet', '1', true);
  if co is not null then perform boh_allocate_core(v_order, co, auth.uid(), case when co = auth.uid() then 'billed' else 'auto' end); end if;

  if p_delivered then
    if not exists (select 1 from boh_order_allocations where order_id = v_order) then raise exception 'Allocate a coordinator before marking delivered'; end if;
    update boh_order_allocations set status = 'delivered',
      acknowledged_at = coalesce(acknowledged_at, now()), vendor_ordered_at = coalesce(vendor_ordered_at, now()), delivered_at = now()
     where order_id = v_order;
    insert into boh_order_events (order_id, event, note, actor) values (v_order, 'delivered', 'Billed as already delivered', auth.uid());
    perform boh_sync_order(v_order);
  end if;
  if p_paid_method is not null then
    update boh_orders set payment_status = 'paid', paid_at = now(), payment_confirmed_by = auth.uid(), payment_method = trim(p_paid_method),
      payment_ref = coalesce(nullif(trim(p_paid_ref), ''), trim(p_paid_method)) where id = v_order;
    insert into boh_order_events (order_id, event, note, actor) values (v_order, 'payment confirmed', trim(p_paid_method) || coalesce(' · ' || nullif(trim(p_paid_ref), ''), ''), auth.uid());
    perform boh_sync_order(v_order);
  end if;
  perform set_config('boh.quiet', '', true);

  -- one message to the restaurant with the bill (proforma, invoice or paid invoice)
  insert into boh_order_events (order_id, event, note, actor) values (v_order, 'placed',
    'Backend bill · ' || case when p_payment_mode = 'prepaid' then 'Pre-pay' else 'Pay on delivery' end ||
    case when p_delivered then ' · delivered' else '' end || case when p_paid_method is not null then ' · paid' else '' end, auth.uid());
  return v_order;
end $$;
revoke execute on function public.boh_staff_bill(uuid, jsonb, text, text, date, boolean, text, text) from public, anon;
grant execute on function public.boh_staff_bill(uuid, jsonb, text, text, date, boolean, text, text) to authenticated;

-- ---------------------------------------------------------------- everything a bill needs, for staff, coordinators and the restaurant
create or replace function public.boh_invoice(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o boh_orders; res jsonb;
begin
  select * into o from boh_orders where id = p_order;
  if not found then raise exception 'Order not found'; end if;
  if not (boh_is_team() or o.restaurant_id = boh_my_restaurant()) then raise exception 'not allowed'; end if;
  select jsonb_build_object(
    'order', jsonb_build_object('id', o.id, 'order_no', o.order_no, 'status', o.status, 'created_at', o.created_at, 'delivery_date', o.delivery_date,
       'delivered_at', o.delivered_at, 'total', o.total, 'notes', o.notes, 'payment_mode', o.payment_mode, 'payment_status', o.payment_status,
       'paid_at', o.paid_at, 'payment_ref', o.payment_ref, 'payment_method', coalesce(o.payment_method, o.payment_claim_method),
       'invoice_no', o.invoice_no, 'invoice_date', o.invoice_date, 'source', o.source),
    'restaurant', (select jsonb_build_object('name', r.name, 'address', r.address, 'gstin', r.gstin, 'phone', r.phone, 'email', r.email, 'contact', r.contact_name)
                     from boh_restaurants r where r.id = o.restaurant_id),
    'company', (select jsonb_build_object('name', s.company_name, 'address', s.company_address, 'gstin', s.company_gstin, 'email', coalesce(s.company_email, s.site_email),
                  'phone', coalesce(nullif(s.support_phone, ''), s.site_phone), 'terms', s.invoice_terms, 'upi', s.pay_upi_id, 'qr', s.pay_qr_url,
                  'bank_name', s.bank_name, 'account_name', s.bank_account_name, 'account_no', s.bank_account_no, 'ifsc', s.bank_ifsc, 'branch', s.bank_branch)
                  from boh_settings s where s.id = 1),
    'coordinator', (select jsonb_build_object('name', u.full_name, 'phone', u.phone) from boh_users u where u.id = o.coordinator_id),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('product_id', i.product_id, 'product_name', i.product_name, 'category_name', i.category_name,
                 'unit', i.unit, 'qty', i.qty, 'unit_price', i.unit_price, 'line_total', i.line_total) order by i.category_name, i.product_name)
               from boh_order_items i where i.order_id = o.id), '[]'::jsonb)
  ) into res;
  return res;
end $$;
revoke execute on function public.boh_invoice(uuid) from public, anon;
grant execute on function public.boh_invoice(uuid) to authenticated;

-- resend the bill email (team)
create or replace function public.boh_resend_bill(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o boh_orders; r boh_restaurants; s boh_settings; doc text; pay text;
begin
  if not boh_is_team() then raise exception 'not allowed'; end if;
  select * into o from boh_orders where id = p_order;
  select * into r from boh_restaurants where id = o.restaurant_id;
  select * into s from boh_settings where id = 1;
  doc := case when o.invoice_no is not null then 'Invoice ' || o.invoice_no else 'Proforma invoice' end;
  pay := boh_pay_text();
  perform boh_notify_restaurant(o.restaurant_id, 'bill', doc || ' — order #' || o.order_no || ' · ' || boh_inr(o.total),
    '🧾 *' || doc || '* — ' || s.company_name || E'\nOrder #' || o.order_no || ' · Delivery ' || to_char(o.delivery_date, 'DD Mon YYYY') ||
    E'\n\n' || coalesce(boh_bill_lines(o.id), '') || E'\n\n*Total: ' || boh_inr(o.total) || '*' ||
    case when o.payment_status = 'paid' then E'\n✅ Paid' || coalesce(' via ' || o.payment_method, '') else coalesce(E'\n' || pay, '') end ||
    E'\n\nDownload as PDF: ' || s.portal_url || '/#/orders' || E'\n— ' || s.company_name,
    o.id, 'bill:' || o.id || ':' || extract(epoch from now())::bigint);
end $$;
revoke execute on function public.boh_resend_bill(uuid) from public, anon;
grant execute on function public.boh_resend_bill(uuid) to authenticated;

-- ---------------------------------------------------------------- order source may now be 'backend'
do $$ begin
  alter table public.boh_orders drop constraint if exists boh_orders_source_check;
exception when others then null; end $$;
