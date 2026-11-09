// Back of House Co — email sender.
// Sends queued email notifications through Brevo's free plan (300 emails/day).
// Called every minute by pg_cron (header x-cron-secret) or by a staff member from the app (Bearer token).
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const toHtml = (body: string, company: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1d1b18;max-width:620px">
     <div style="background:#1f4d3a;color:#fff;padding:12px 16px;border-radius:8px 8px 0 0;font-weight:bold">${esc(company)}</div>
     <div style="border:1px solid #e6e0d6;border-top:0;padding:16px;border-radius:0 0 8px 8px">${esc(body).replace(/\*([^*\n]+)\*/g, "<b>$1</b>").replace(/\n/g, "<br>")}</div>
   </div>`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  try {
    const { data: priv } = await db.from("boh_private").select("key,value");
    const P = Object.fromEntries((priv || []).map((r: { key: string; value: string }) => [r.key, r.value]));

    // who is calling?
    let allowed = req.headers.get("x-cron-secret") === P.cron_secret && !!P.cron_secret;
    if (!allowed) {
      const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
      const { data: who } = await db.auth.getUser(token);
      if (who?.user) {
        const { data: me } = await db.from("boh_users").select("role,active").eq("id", who.user.id).single();
        allowed = !!me?.active && ["admin", "super_admin"].includes(me.role);
      }
    }
    if (!allowed) return json({ error: "Not allowed" }, 401);

    const { data: s } = await db.from("boh_settings").select("company_name,email_from,email_from_name").eq("id", 1).single();
    const { count: pending } = await db.from("boh_notifications").select("id", { count: "exact", head: true }).eq("channel", "email").eq("status", "pending");
    if (!P.brevo_api_key || !s?.email_from) return json({ configured: false, pending, message: "Add the Brevo API key and sender email in Settings → Notifications" });

    const { data: rows } = await db.from("boh_notifications").select("id,address,name,subject,body,attempts")
      .eq("channel", "email").eq("status", "pending").order("id").limit(40);
    let sent = 0, failed = 0;
    for (const n of rows || []) {
      await db.from("boh_notifications").update({ status: "sending", locked_at: new Date().toISOString(), attempts: n.attempts + 1 }).eq("id", n.id).eq("status", "pending");
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": P.brevo_api_key, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sender: { email: s.email_from, name: s.email_from_name || s.company_name },
          to: [{ email: n.address, ...(n.name ? { name: n.name } : {}) }],
          subject: n.subject || s.company_name,
          htmlContent: toHtml(n.body, s.company_name),
          textContent: n.body.replace(/\*/g, ""),
        }),
      });
      if (res.ok) {
        sent++;
        await db.from("boh_notifications").update({ status: "sent", sent_at: new Date().toISOString(), error: null }).eq("id", n.id);
      } else {
        failed++;
        const err = (await res.text()).slice(0, 300);
        await db.from("boh_notifications").update({ status: n.attempts + 1 >= 3 ? "failed" : "pending", error: `Brevo ${res.status}: ${err}` }).eq("id", n.id);
      }
    }
    return json({ configured: true, sent, failed, remaining: Math.max(0, (pending || 0) - sent - failed) });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
