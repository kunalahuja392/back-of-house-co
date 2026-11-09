-- Payment mode (pre-pay / pay on delivery) and payment confirmation flow
-- payment_status: unpaid → under_review (restaurant says "already paid") → paid (admin/coordinator approves)
--                 under_review → unpaid with a rejection note (shown to restaurant as "Not paid")
alter table public.boh_orders
  add column if not exists payment_mode text not null default 'cod' check (payment_mode in ('prepaid','cod')),
  add column if not exists payment_status text not null default 'unpaid' check (payment_status in ('unpaid','under_review','paid')),
  add column if not exists payment_claim_ref text,
  add column if not exists payment_claimed_at timestamptz,
  add column if not exists payment_rejected_note text,
  add column if not exists payment_rejected_at timestamptz,
  add column if not exists payment_confirmed_by uuid references public.boh_users(id);

update public.boh_orders set payment_status = 'paid' where status = 'paid' and payment_status <> 'paid';

alter table public.boh_settings add column if not exists payment_instructions text default '';

-- order status reaches 'paid' only when delivered AND payment confirmed
create or replace function public.boh_sync_order(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o boh_orders; n_cat int; n_alloc int; rnk int; st text;
begin
  select * into o from boh_orders where id = p_order;
  if o.status = 'cancelled' then return; end if;
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
  if st = 'delivered' and o.payment_status = 'paid' then st := 'paid'; end if;
  update boh_orders set
    status = st,
    allocated_at = (select max(allocated_at) from boh_order_allocations where order_id = p_order),
    acknowledged_at = case when rnk >= 2 then (select max(acknowledged_at) from boh_order_allocations where order_id = p_order) end,
    vendor_ordered_at = case when rnk >= 3 then (select max(vendor_ordered_at) from boh_order_allocations where order_id = p_order) end,
    delivered_at = case when rnk >= 6 then (select max(delivered_at) from boh_order_allocations where order_id = p_order) end
  where id = p_order;
end $$;
revoke execute on function public.boh_sync_order(uuid) from public, anon, authenticated;

-- restaurant: "I have already paid"
create or replace function public.boh_claim_payment(p_order uuid, p_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare o boh_orders;
begin
  select * into o from boh_orders where id = p_order;
  if not found or o.restaurant_id is distinct from boh_my_restaurant() then raise exception 'Order not found'; end if;
  if o.status = 'cancelled' then raise exception 'Order is cancelled'; end if;
  if o.payment_status = 'paid' then raise exception 'This order is already marked paid'; end if;
  if coalesce(trim(p_ref), '') = '' then raise exception 'Please enter the payment reference (UTR / transaction ID / cheque no.)'; end if;
  update boh_orders set payment_status = 'under_review', payment_claim_ref = trim(p_ref), payment_claimed_at = now(),
    payment_rejected_note = null, payment_rejected_at = null where id = p_order;
  insert into boh_order_events (order_id, event, note, actor) values (p_order, 'payment claimed', trim(p_ref), auth.uid());
end $$;

-- admin / coordinator on the order: approve (payment collected)
drop function if exists public.boh_mark_paid(uuid, text);
create function public.boh_mark_paid(p_order uuid, p_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare o boh_orders;
begin
  if not (boh_is_staff() or boh_on_order(p_order)) then raise exception 'not allowed'; end if;
  select * into o from boh_orders where id = p_order;
  if o.status = 'cancelled' then raise exception 'Order is cancelled'; end if;
  update boh_orders set payment_status = 'paid', paid_at = now(), payment_confirmed_by = auth.uid(),
    payment_ref = coalesce(nullif(trim(p_ref), ''), payment_claim_ref), payment_rejected_note = null, payment_rejected_at = null
  where id = p_order;
  insert into boh_order_events (order_id, event, note, actor) values (p_order, 'payment confirmed', coalesce(nullif(trim(p_ref), ''), o.payment_claim_ref), auth.uid());
  perform boh_sync_order(p_order);
end $$;

-- admin / coordinator on the order: reject a claimed payment
create or replace function public.boh_reject_payment(p_order uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (boh_is_staff() or boh_on_order(p_order)) then raise exception 'not allowed'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'Please give a reason so the restaurant knows what to fix'; end if;
  update boh_orders set payment_status = 'unpaid', payment_rejected_note = trim(p_note), payment_rejected_at = now(),
    paid_at = null, status = case when status = 'paid' then 'delivered' else status end
  where id = p_order;
  insert into boh_order_events (order_id, event, note, actor) values (p_order, 'payment rejected', trim(p_note), auth.uid());
end $$;

-- place order: now records the payment mode
drop function if exists public.boh_place_order(jsonb, text);
create function public.boh_place_order(p_items jsonb, p_notes text default null, p_payment_mode text default 'cod') returns uuid
language plpgsql security definer set search_path = public as $$
declare
  r uuid := boh_my_restaurant();
  s boh_settings;
  ist timestamp := (now() at time zone 'Asia/Kolkata');
  v_delivery date; v_order uuid; it jsonb; v_qty numeric; p record; v_margin numeric; v_price numeric;
  v_total numeric := 0; v_cost numeric := 0;
begin
  if r is null then raise exception 'Only restaurant users can place orders'; end if;
  if p_payment_mode not in ('prepaid','cod') then raise exception 'Choose pre-pay or pay on delivery'; end if;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then raise exception 'Order is empty'; end if;
  select * into s from boh_settings where id = 1;
  v_delivery := case when ist::time < s.order_cutoff then ist::date + 1 else ist::date + 2 end;
  insert into boh_orders (restaurant_id, placed_by, delivery_date, notes, payment_mode)
  values (r, auth.uid(), v_delivery, p_notes, p_payment_mode) returning id into v_order;
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
  insert into boh_order_events (order_id, event, note, actor) values (v_order, 'placed', case when p_payment_mode = 'prepaid' then 'Pre-pay' else 'Pay on delivery' end, auth.uid());
  return v_order;
end $$;

revoke execute on function public.boh_place_order(jsonb, text, text), public.boh_claim_payment(uuid, text),
  public.boh_mark_paid(uuid, text), public.boh_reject_payment(uuid, text) from public, anon;
grant execute on function public.boh_place_order(jsonb, text, text), public.boh_claim_payment(uuid, text),
  public.boh_mark_paid(uuid, text), public.boh_reject_payment(uuid, text) to authenticated;
