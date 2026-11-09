create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.boh_inr(n numeric) returns text
language sql immutable as $$ select case when coalesce(n, 0) < 0 then '-' else '' end || '₹' || to_char(abs(coalesce(n, 0)), 'FM99,99,99,99,990.00') $$;

-- every 10 minutes: deadline reminders, overdue alerts, payment reminders, daily report
select cron.unschedule(jobid) from cron.job where jobname in ('boh-sla-scan', 'boh-send-email');
select cron.schedule('boh-sla-scan', '*/10 * * * *', $$select public.boh_sla_scan()$$);

-- every minute: hand pending emails to the email sender (only when something is waiting)
-- NOTE: replace the project URL if you move to another Supabase project.
select cron.schedule('boh-send-email', '* * * * *', $$
  select net.http_post(
    url := 'https://gqusbphanvsqrieyhluo.supabase.co/functions/v1/boh-notify',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select value from public.boh_private where key = 'cron_secret')),
    body := '{}'::jsonb)
  where exists (select 1 from public.boh_notifications where channel = 'email' and status = 'pending')
    and exists (select 1 from public.boh_private where key = 'brevo_api_key' and value <> '')
$$);

create or replace function public.boh_report_preview(p_day date default null) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(boh_role(), '') <> 'super_admin' then raise exception 'Only the super admin'; end if;
  return boh_daily_report_text(coalesce(p_day, (now() at time zone 'Asia/Kolkata')::date));
end $$;
revoke execute on function public.boh_report_preview(date) from public, anon;
grant execute on function public.boh_report_preview(date) to authenticated;
