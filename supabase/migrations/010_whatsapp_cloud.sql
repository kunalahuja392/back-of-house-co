-- 010: official WhatsApp (Meta Cloud API) as an alternative to the WhatsApp Web bot.
alter table public.boh_settings
  add column if not exists wa_provider text not null default 'bot' check (wa_provider in ('bot','cloud')),
  add column if not exists wa_phone_number_id text,
  add column if not exists wa_waba_id text,
  add column if not exists wa_lang text not null default 'en';

-- the token is write-only (like the Brevo key)
create or replace function public.boh_set_notify_secret(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(boh_role(), '') <> 'super_admin' then raise exception 'Only the super admin'; end if;
  if p_key not in ('brevo_api_key', 'bot_secret', 'wa_cloud_token') then raise exception 'Unknown key'; end if;
  insert into boh_private (key, value, updated_at) values (p_key, coalesce(p_value, ''), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;

create or replace function public.boh_wa_cloud_configured() returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if not boh_is_staff() then raise exception 'not allowed'; end if;
  return exists (select 1 from boh_private where key = 'wa_cloud_token' and value <> '');
end $$;
revoke execute on function public.boh_wa_cloud_configured() from public, anon;
grant execute on function public.boh_wa_cloud_configured() to authenticated;

-- the bot gets nothing while the official API is selected
create or replace function public.boh_wa_claim(p_limit int default 10) returns table (id bigint, address text, body text)
language plpgsql security definer set search_path = public as $$
begin
  update boh_settings set bot_last_seen = now() where boh_settings.id = 1;
  if (select wa_provider from boh_settings where boh_settings.id = 1) = 'cloud' then return; end if;
  update boh_notifications n set status = 'pending' where n.channel = 'whatsapp' and n.status = 'sending' and n.locked_at < now() - interval '10 minutes';
  return query
  update boh_notifications n set status = 'sending', locked_at = now(), attempts = n.attempts + 1
  where n.id in (select x.id from boh_notifications x where x.channel = 'whatsapp' and x.status = 'pending' order by x.id limit p_limit for update skip locked)
  returning n.id, n.address, n.body;
end $$;

-- the email/WhatsApp sender (service role) claims WhatsApp rows when the official API is selected
create or replace function public.boh_wa_claim_cloud(p_limit int default 30)
returns table (id bigint, address text, name text, event text, body text, attempts int, role text)
language plpgsql security definer set search_path = public as $$
begin
  update boh_notifications n set status = 'pending' where n.channel = 'whatsapp' and n.status = 'sending' and n.locked_at < now() - interval '10 minutes';
  return query
  with c as (
    update boh_notifications n set status = 'sending', locked_at = now(), attempts = n.attempts + 1
    where n.id in (select x.id from boh_notifications x where x.channel = 'whatsapp' and x.status = 'pending' order by x.id limit p_limit for update skip locked)
    returning n.id, n.address, n.name, n.event, n.body, n.attempts, n.user_id)
  select c.id, c.address, coalesce(c.name, u.full_name), c.event, c.body, c.attempts, u.role
    from c left join boh_users u on u.id = c.user_id order by c.id;
end $$;
revoke execute on function public.boh_wa_claim_cloud(int) from public, anon, authenticated;
