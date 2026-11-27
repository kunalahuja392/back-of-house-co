-- 018: restaurants can order "Price on request" items; our team confirms the price on the order.
-- A line with no price yet has unit_price / line_total null and price_pending = true. The order total counts priced lines only
-- until every line is priced. Confirming a line can also save the vendor rate, so the item is priced for next time.

alter table public.boh_order_items alter column unit_price drop not null;
alter table public.boh_order_items alter column line_total drop not null;
alter table public.boh_order_items add column if not exists price_pending boolean not null default false;
alter table public.boh_orders add column if not exists price_pending boolean not null default false;

-- the vendor we would call for a product: the cheapest active rate, else the vendor linked without a price
create or replace function public.boh_product_vendor(p_product uuid)
returns table (vendor_id uuid, vendor_name text, delivery_style text, rate numeric)
language sql stable security definer set search_path = public as $$
  select b.vendor_id, b.vendor_name, b.delivery_style, b.rate from boh_product_best_rate b where b.product_id = p_product
  union all
  select * from (select v.id, v.name, v.delivery_style, null::numeric from boh_vendor_rates r join boh_vendors v on v.id = r.vendor_id
                 where r.product_id = p_product and v.active and not exists (select 1 from boh_product_best_rate b where b.product_id = p_product)
                 order by r.updated_at desc limit 1) t
  limit 1
$$;
revoke execute on function public.boh_product_vendor(uuid) from public, anon, authenticated;

-- order core (from 013) with price-on-request lines; auto-orders never include them
create or replace function public.boh_place_order_core(p_rest uuid, p_user uuid, p_items jsonb, p_notes text, p_payment_mode text, p_source text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  base date := boh_base_delivery(); it jsonb; v_qty numeric; p record; pv record; lines jsonb := '[]'; dd date; v_order uuid; first_order uuid;
  x jsonb; v_margin numeric; v_total numeric; v_cost numeric; moved text; v_pending boolean; v_price numeric;
begin
  if p_rest is null then raise exception 'Only restaurant users can place orders'; end if;
  if p_payment_mode not in ('prepaid','cod') then raise exception 'Choose pre-pay or pay on delivery'; end if;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then raise exception 'Order is empty'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := (it->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then continue; end if;
    select pr.id, pr.name, pr.unit, pr.moq, c.id as cat_id, c.name as cat into p
      from boh_restaurant_products rp
      join boh_products pr on pr.id = rp.product_id and pr.active
      join boh_categories c on c.id = pr.category_id
      where rp.restaurant_id = p_rest and rp.active and rp.product_id = (it->>'product_id')::uuid and boh_category_on(p_rest, c.id);
    if not found then raise exception 'Product % is not on your ordering list', it->>'product_id'; end if;
    select * into pv from boh_product_vendor(p.id);
    if pv.rate is null and p_source = 'auto' then continue; end if;   -- auto-orders only buy priced items
    if p.moq is not null and v_qty < p.moq then
      if p_source = 'auto' then v_qty := p.moq;
      else raise exception 'Minimum order quantity for % is % %', p.name, trim(to_char(p.moq, 'FM999999990.###')), coalesce(p.unit, ''); end if;
    end if;
    v_price := case when pv.rate is not null then boh_selling_price(p_rest, p.id) end;
    lines := lines || jsonb_build_object('pid', p.id, 'name', p.name, 'unit', p.unit, 'cat_id', p.cat_id, 'cat', p.cat, 'qty', v_qty,
      'rate', pv.rate, 'price', v_price, 'vendor_id', pv.vendor_id, 'vendor_name', pv.vendor_name, 'style', pv.delivery_style,
      'd', boh_next_delivery(p.cat_id, base));
  end loop;
  if jsonb_array_length(lines) = 0 then raise exception 'Order is empty'; end if;

  for dd in select distinct (l->>'d')::date from jsonb_array_elements(lines) l order by 1 loop
    insert into boh_orders (restaurant_id, placed_by, delivery_date, notes, payment_mode, source)
    values (p_rest, p_user, dd, p_notes, p_payment_mode, p_source) returning id into v_order;
    v_total := 0; v_cost := 0; v_pending := false;
    for x in select l from jsonb_array_elements(lines) l where (l->>'d')::date = dd loop
      if x->>'price' is null then
        v_pending := true;
        insert into boh_order_items (order_id, product_id, product_name, category_id, category_name, unit, qty, unit_cost, margin_pct,
                                     unit_price, line_total, vendor_id, vendor_name, delivery_style, price_pending)
        values (v_order, (x->>'pid')::uuid, x->>'name', (x->>'cat_id')::uuid, x->>'cat', x->>'unit', (x->>'qty')::numeric, null, null,
                null, null, nullif(x->>'vendor_id', '')::uuid, x->>'vendor_name', x->>'style', true);
      else
        v_margin := case when (x->>'rate')::numeric > 0 then round(((x->>'price')::numeric / (x->>'rate')::numeric - 1) * 100, 2) end;
        insert into boh_order_items (order_id, product_id, product_name, category_id, category_name, unit, qty, unit_cost, margin_pct,
                                     unit_price, line_total, vendor_id, vendor_name, delivery_style)
        values (v_order, (x->>'pid')::uuid, x->>'name', (x->>'cat_id')::uuid, x->>'cat', x->>'unit', (x->>'qty')::numeric, (x->>'rate')::numeric, v_margin,
                (x->>'price')::numeric, round((x->>'price')::numeric * (x->>'qty')::numeric, 2), nullif(x->>'vendor_id', '')::uuid, x->>'vendor_name', x->>'style');
        v_total := v_total + round((x->>'price')::numeric * (x->>'qty')::numeric, 2);
        v_cost := v_cost + round((x->>'rate')::numeric * (x->>'qty')::numeric, 2);
      end if;
    end loop;
    update boh_orders set total = v_total, cost_total = v_cost, price_pending = v_pending where id = v_order;
    select string_agg(distinct l->>'cat', ', ') into moved from jsonb_array_elements(lines) l where (l->>'d')::date = dd and dd > base;
    insert into boh_order_events (order_id, event, note, actor) values (v_order, 'placed',
      case when p_source = 'auto' then 'Auto order · ' else '' end || case when p_payment_mode = 'prepaid' then 'Pre-pay' else 'Pay on delivery' end ||
      case when v_pending then ' · has price-on-request items' else '' end ||
      coalesce(' · ' || moved || ' delivered ' || to_char(dd, 'Dy DD Mon') || ' (day off)', ''), p_user);
    first_order := coalesce(first_order, v_order);
  end loop;
  return first_order;
end $$;
revoke execute on function public.boh_place_order_core(uuid, uuid, jsonb, text, text, text) from public, anon, authenticated;

-- bill lines in emails: unpriced lines say so
create or replace function public.boh_bill_lines(p_order uuid) returns text
language sql stable security definer set search_path = public as $$
  select string_agg('• ' || i.product_name || ' — ' || trim(to_char(i.qty, 'FM999999990.###')) || ' ' || coalesce(i.unit, '') ||
         case when i.unit_price is null then ' — _price to be confirmed_'
              else ' × ' || boh_inr(i.unit_price) || ' = *' || boh_inr(i.line_total) || '*' end, E'\n' order by i.category_name, i.product_name) ||
         case when bool_or(i.unit_price is null) then E'\n\n⚠ Items marked “price to be confirmed” are price-on-request: we will confirm their price and send the final bill. The total below is for priced items only.' else '' end
  from boh_order_items i where i.order_id = p_order
$$;

-- confirm the price of a price-on-request line (coordinator on the order, or admin)
-- p_cost = what the vendor charges us per unit; p_price = restaurant's price (default: cost + the restaurant's mark-up)
create or replace function public.boh_set_line_price(p_item uuid, p_cost numeric, p_price numeric default null, p_vendor uuid default null, p_save_rate boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i boh_order_items; o boh_orders; v_price numeric; v_vendor uuid; v_vname text; v_style text; v_left int;
begin
  select * into i from boh_order_items where id = p_item for update;
  if not found then raise exception 'Line not found'; end if;
  select * into o from boh_orders where id = i.order_id for update;
  if not (boh_is_staff() or boh_on_order(o.id)) then raise exception 'This order is not allocated to you'; end if;
  if o.status = 'cancelled' then raise exception 'Order is cancelled'; end if;
  if o.payment_status = 'paid' then raise exception 'Order is already paid'; end if;
  if p_cost is null or p_cost <= 0 then raise exception 'Enter the vendor''s rate'; end if;
  v_vendor := coalesce(p_vendor, i.vendor_id);
  if v_vendor is null then raise exception 'Choose the vendor'; end if;
  select name, delivery_style into v_vname, v_style from boh_vendors where id = v_vendor;
  v_price := coalesce(p_price, round(p_cost * (1 + coalesce(boh_effective_margin(o.restaurant_id, i.product_id), 0) / 100), 2));
  if v_price < p_cost and not boh_is_staff() then raise exception 'Price is below the vendor rate — ask an admin'; end if;
  update boh_order_items set unit_cost = p_cost, unit_price = v_price, line_total = round(v_price * qty, 2),
    margin_pct = round((v_price / p_cost - 1) * 100, 2), vendor_id = v_vendor, vendor_name = v_vname, delivery_style = coalesce(v_style, delivery_style),
    price_pending = false
  where id = p_item;
  if p_save_rate then
    insert into boh_vendor_rates (vendor_id, product_id, rate, active, updated_at) values (v_vendor, i.product_id, p_cost, true, now())
      on conflict (vendor_id, product_id) do update set rate = excluded.rate, active = true, updated_at = now();
  end if;
  select count(*) into v_left from boh_order_items where order_id = o.id and price_pending;
  update boh_orders set total = (select coalesce(sum(line_total), 0) from boh_order_items where order_id = o.id),
    cost_total = (select coalesce(sum(round(unit_cost * qty, 2)), 0) from boh_order_items where order_id = o.id),
    price_pending = v_left > 0
  where id = o.id;
  insert into boh_order_events (order_id, event, note, actor)
    values (o.id, 'price confirmed', i.product_name || ' · ' || boh_inr(v_price) || ' / ' || coalesce(i.unit, 'unit') || ' (vendor ' || boh_inr(p_cost) || ')', auth.uid());
  if v_left = 0 then perform boh_resend_bill(o.id); end if;   -- restaurant gets the final bill
  return jsonb_build_object('price', v_price, 'left', v_left);
end $$;
revoke execute on function public.boh_set_line_price(uuid, numeric, numeric, uuid, boolean) from public, anon;
grant execute on function public.boh_set_line_price(uuid, numeric, numeric, uuid, boolean) to authenticated;

-- no invoice number, delivery or payment while a price is still open
create or replace function public.boh_tr_invoice_no() returns trigger
language plpgsql security definer set search_path = public as $$
declare pre text;
begin
  if new.invoice_no is null and new.status <> 'cancelled' and not new.price_pending
     and (new.status in ('delivered','paid') or new.payment_status = 'paid' or new.delivered_at is not null) then
    select coalesce(nullif(trim(invoice_prefix), ''), 'BOH/') into pre from boh_settings where id = 1;
    new.invoice_no := pre || nextval('boh_invoice_seq');
    new.invoice_date := (now() at time zone 'Asia/Kolkata')::date;
  end if;
  return new;
end $$;

create or replace function public.boh_tr_block_pending() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.price_pending and new.payment_status = 'paid' and old.payment_status is distinct from 'paid' then
    raise exception 'Confirm the price of the price-on-request items before recording payment';
  end if;
  return new;
end $$;
drop trigger if exists boh_tr_block_pending on public.boh_orders;
create trigger boh_tr_block_pending before update of payment_status on public.boh_orders for each row execute function public.boh_tr_block_pending();

-- the "delivered — amount due" message waits while prices are open (the final bill goes out when the last price is set)
create or replace function public.boh_tr_order_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare r boh_restaurants; s boh_settings; by_u text; pay text;
begin
  if coalesce(current_setting('boh.quiet', true), '') = '1' then return new; end if;
  select * into r from boh_restaurants where id = new.restaurant_id;
  select * into s from boh_settings where id = 1;
  if new.status = 'delivered' and old.status is distinct from 'delivered' and new.payment_status <> 'paid' and not new.price_pending then
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

-- invoice numbers used by test runs are not kept
select setval('boh_invoice_seq', greatest(1003, coalesce((select max(nullif(regexp_replace(invoice_no, '\D', '', 'g'), '')::bigint) from boh_orders where invoice_no is not null), 1003)));
