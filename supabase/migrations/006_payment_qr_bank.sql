-- Payment details set by the super admin: QR code / UPI and bank account
alter table public.boh_settings
  add column if not exists pay_qr_url text,
  add column if not exists pay_upi_id text,
  add column if not exists bank_name text,
  add column if not exists bank_account_name text,
  add column if not exists bank_account_no text,
  add column if not exists bank_ifsc text,
  add column if not exists bank_branch text;

alter table public.boh_orders add column if not exists payment_claim_method text;

drop function if exists public.boh_claim_payment(uuid, text);
create function public.boh_claim_payment(p_order uuid, p_ref text, p_method text default null) returns void
language plpgsql security definer set search_path = public as $$
declare o boh_orders;
begin
  select * into o from boh_orders where id = p_order;
  if not found or o.restaurant_id is distinct from boh_my_restaurant() then raise exception 'Order not found'; end if;
  if o.status = 'cancelled' then raise exception 'Order is cancelled'; end if;
  if o.payment_status = 'paid' then raise exception 'This order is already marked paid'; end if;
  if coalesce(trim(p_ref), '') = '' then raise exception 'Please enter the payment reference (UTR / transaction ID / cheque no.)'; end if;
  update boh_orders set payment_status = 'under_review', payment_claim_ref = trim(p_ref), payment_claim_method = nullif(trim(p_method), ''),
    payment_claimed_at = now(), payment_rejected_note = null, payment_rejected_at = null where id = p_order;
  insert into boh_order_events (order_id, event, note, actor)
  values (p_order, 'payment claimed', concat_ws(' · ', nullif(trim(p_method), ''), trim(p_ref)), auth.uid());
end $$;
revoke execute on function public.boh_claim_payment(uuid, text, text) from public, anon;
grant execute on function public.boh_claim_payment(uuid, text, text) to authenticated;
