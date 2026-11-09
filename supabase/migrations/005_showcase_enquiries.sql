-- Showcase slides get full details; restaurants can enquire.
-- Enquiries about a catalogue product become product requests (Requests tab); others go to Enquiries.
alter table public.boh_featured
  add column if not exists details text,          -- long description shown in "Know more"
  add column if not exists price_label text,      -- e.g. "₹120 / pack of 50", "From ₹2,500"
  add column if not exists highlights text,       -- one point per line
  add column if not exists more_link text,        -- optional link (brochure, video, website)
  add column if not exists gallery text[] not null default '{}';

alter table public.boh_product_requests add column if not exists source text not null default 'browse';
alter table public.boh_product_requests add column if not exists featured_id uuid references public.boh_featured(id) on delete set null;

create table if not exists public.boh_enquiries (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.boh_restaurants(id) on delete cascade,
  featured_id uuid references public.boh_featured(id) on delete set null,
  subject text not null,
  message text,
  quantity text,
  status text not null default 'new' check (status in ('new','interested','dropped','converted')),
  admin_note text,
  created_by uuid references public.boh_users(id),
  updated_by uuid references public.boh_users(id),
  updated_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.boh_enquiries enable row level security;
create policy boh_enq_read on public.boh_enquiries for select to authenticated using (boh_is_team() or restaurant_id = boh_my_restaurant());
create policy boh_enq_staff on public.boh_enquiries for update to authenticated using (boh_is_staff()) with check (boh_is_staff());
create policy boh_enq_del on public.boh_enquiries for delete to authenticated using (boh_is_staff());

-- restaurant enquires from a slide: product slide → product request; otherwise → enquiry
create or replace function public.boh_enquire(p_featured uuid, p_message text, p_quantity text default null) returns text
language plpgsql security definer set search_path = public as $$
declare r uuid := boh_my_restaurant(); f boh_featured; v_note text;
begin
  if r is null then raise exception 'Only restaurant users can enquire'; end if;
  select * into f from boh_featured where id = p_featured;
  if not found then raise exception 'This item is no longer available'; end if;
  v_note := nullif(concat_ws(' · ', nullif(trim(p_message), ''), case when nullif(trim(p_quantity), '') is not null then 'Qty: ' || trim(p_quantity) end), '');
  if f.product_id is not null then
    if exists (select 1 from boh_restaurant_products where restaurant_id = r and product_id = f.product_id and active)
       and boh_category_on(r, (select category_id from boh_products where id = f.product_id)) then
      return 'on_list';
    end if;
    if exists (select 1 from boh_product_requests where restaurant_id = r and product_id = f.product_id and status = 'pending') then
      update boh_product_requests set note = concat_ws(' | ', note, v_note) where restaurant_id = r and product_id = f.product_id and status = 'pending';
      return 'request_updated';
    end if;
    insert into boh_product_requests (restaurant_id, product_id, note, requested_by, source, featured_id)
    values (r, f.product_id, coalesce(v_note, 'Enquired from slideshow: ' || f.title), auth.uid(), 'slideshow', f.id);
    return 'request';
  end if;
  insert into boh_enquiries (restaurant_id, featured_id, subject, message, quantity, created_by)
  values (r, f.id, f.title, nullif(trim(p_message), ''), nullif(trim(p_quantity), ''), auth.uid());
  return 'enquiry';
end $$;
revoke execute on function public.boh_enquire(uuid, text, text) from public, anon;
grant execute on function public.boh_enquire(uuid, text, text) to authenticated;
