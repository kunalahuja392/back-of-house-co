-- masked hint of a saved secret (first 8 + last 4 characters) so the super admin can see which key is saved
create or replace function public.boh_secret_hint(p_key text) returns text
language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  if coalesce(boh_role(), '') <> 'super_admin' then raise exception 'Only the super admin'; end if;
  if p_key not in ('brevo_api_key', 'wa_cloud_token') then raise exception 'Unknown key'; end if;
  select value into v from boh_private where key = p_key;
  if coalesce(v, '') = '' then return null; end if;
  if length(v) < 16 then return '•••• (' || length(v) || ' characters — too short, not a valid key)'; end if;
  return left(v, 8) || '••••••••' || right(v, 4) || ' (' || length(v) || ' characters)';
end $$;
revoke execute on function public.boh_secret_hint(text) from public, anon;
grant execute on function public.boh_secret_hint(text) to authenticated;
