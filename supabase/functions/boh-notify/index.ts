// Back of House Co — notification sender.
// Email: queued messages through Brevo's free plan (300 emails/day).
// WhatsApp (when Settings → WhatsApp = Official): queued messages through Meta's WhatsApp Cloud API, using approved templates.
// Called every minute by pg_cron (header x-cron-secret) or by a staff member from the app (Bearer token).
// Super admin actions: {action:"wa_status"} and {action:"wa_create_templates"}.
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

// ---------------------------------------------------------------- WhatsApp Cloud API
const GRAPH = "https://graph.facebook.com/v21.0";
// Three utility templates: {{1}} = recipient name, {{2}} = the message (one line).
export const TEMPLATES = [
  { name: "boh_order_update", text: "Hi {{1}}, here is an update on your Back of House Co order: {{2}}\n\nFor help, reply to this message or call your coordinator.",
    example: ["Cafe Mocha", "Order #101 received · 12 items · Rs 4,250 · Delivery: Thu 12 Nov · Payment: Pay on delivery"] },
  { name: "boh_team_alert", text: "Hi {{1}}, you have a Back of House Co ordering task: {{2}}\n\nPlease open the ordering app to act on it.",
    example: ["Ravi", "Allocated to you: order #101 · Cafe Mocha · Delivery Thu 12 Nov · Fresh Bakes 98xxxxxx: Burger bun 10 pc · Acknowledge by 11:30 am"] },
  { name: "boh_daily_report", text: "Hi {{1}}, here is the Back of House Co daily summary: {{2}}\n\nThe full report is in your email and the ordering app.",
    example: ["Kunal", "11 Nov 2026 · Orders 14 · Sales Rs 52,300 · Gross profit Rs 6,100 · Collected Rs 31,000 · Due Rs 88,400"] },
];
const RESTAURANT_EVENTS = new Set(["order_placed", "coordinator", "cat_delivered", "delivered_due", "paid", "payment_rejected", "payment_reminder"]);
function pickTemplate(event: string, role: string | null) {
  if (event === "daily_report") return "boh_daily_report";
  if (role === "customer") return "boh_order_update";
  if (role) return "boh_team_alert";
  return RESTAURANT_EVENTS.has(event) || event === "cancelled" ? "boh_order_update" : "boh_team_alert"; // phone with no login
}
// WhatsApp template parameters cannot contain new lines, tabs or more than 4 spaces in a row
const oneLine = (s: string, max: number) => {
  const t = (s || "").replace(/\*/g, "").replace(/\r/g, "").split("\n").map((x) => x.trim()).filter(Boolean).join(" · ")
    .replace(/\t/g, " ").replace(/ {2,}/g, " ").replace(/^— /, "").replace(/ · — [^·]+$/, "");
  return t.length > max ? t.slice(0, max - 40).trimEnd() + " … (full details in the app)" : t;
};
async function graph(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${GRAPH}/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  try {
    const { data: priv } = await db.from("boh_private").select("key,value");
    const P = Object.fromEntries((priv || []).map((r: { key: string; value: string }) => [r.key, r.value]));

    // who is calling?
    let allowed = req.headers.get("x-cron-secret") === P.cron_secret && !!P.cron_secret;
    let role = allowed ? "cron" : "";
    if (!allowed) {
      const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
      const { data: who } = await db.auth.getUser(token);
      if (who?.user) {
        const { data: me } = await db.from("boh_users").select("role,active").eq("id", who.user.id).single();
        allowed = !!me?.active && ["admin", "super_admin"].includes(me.role);
        role = me?.role || "";
      }
    }
    if (!allowed) return json({ error: "Not allowed" }, 401);

    const { data: ws } = await db.from("boh_settings").select("wa_provider,wa_phone_number_id,wa_waba_id,wa_lang,notify_whatsapp").eq("id", 1).single();
    const token = P.wa_cloud_token || "";
    const input = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    // ---- super admin: check the Meta setup and template approval
    if (input.action === "wa_status" || input.action === "wa_create_templates") {
      if (role !== "super_admin") return json({ error: "Only the super admin" }, 403);
      if (!token) return json({ error: "Save the access token first" }, 400);
      const out: Record<string, unknown> = {};
      if (ws?.wa_phone_number_id) {
        const r = await graph(`${ws.wa_phone_number_id}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,name_status,messaging_limit_tier`, token);
        out.phone = r.ok ? r.body : { error: r.body?.error?.message || `HTTP ${r.status}` };
      } else out.phone = { error: "Phone number ID is missing" };
      if (!ws?.wa_waba_id) return json({ ...out, templates: [], error: "WhatsApp Business Account ID is missing" });
      if (input.action === "wa_create_templates") {
        const created: unknown[] = [];
        for (const t of TEMPLATES) {
          const r = await graph(`${ws.wa_waba_id}/message_templates`, token, { method: "POST", body: JSON.stringify({
            name: t.name, language: ws.wa_lang || "en", category: "UTILITY",
            components: [{ type: "BODY", text: t.text, example: { body_text: [t.example] } }],
          }) });
          created.push({ name: t.name, ok: r.ok, status: r.body?.status, error: r.ok ? null : r.body?.error?.error_user_msg || r.body?.error?.message });
        }
        out.created = created;
      }
      const tl = await graph(`${ws.wa_waba_id}/message_templates?fields=name,status,category,language,rejected_reason&limit=100`, token);
      out.templates = tl.ok ? (tl.body.data || []).filter((t: { name: string }) => TEMPLATES.some((x) => x.name === t.name))
        : { error: tl.body?.error?.message || `HTTP ${tl.status}` };
      return json(out);
    }

    // ---- WhatsApp through the official API
    let wa: Record<string, number> | null = null;
    if (ws?.wa_provider === "cloud" && token && ws.wa_phone_number_id) {
      wa = { sent: 0, failed: 0 };
      const { data: claimed } = await db.rpc("boh_wa_claim_cloud", { p_limit: 30 });
      const rows = claimed || [];
      // setup problem (template not approved yet / token expired): put rows back without using up their tries
      const putBack = async (from: number, why: string) => {
        for (const x of rows.slice(from)) await db.from("boh_notifications").update({ status: "pending", attempts: Math.max(0, x.attempts - 1), error: why }).eq("id", x.id);
      };
      for (let i = 0; i < rows.length; i++) {
        const n = rows[i];
        const tpl = pickTemplate(n.event, n.role);
        const r = await graph(`${ws.wa_phone_number_id}/messages`, token, { method: "POST", body: JSON.stringify({
          messaging_product: "whatsapp", to: n.address, type: "template",
          template: { name: tpl, language: { code: ws.wa_lang || "en" }, components: [{ type: "body", parameters: [
            { type: "text", text: oneLine(n.name || "there", 60) || "there" },
            { type: "text", text: oneLine(n.body, 850) || "-" },
          ] }] },
        }) });
        if (r.ok) {
          wa.sent++;
          await db.from("boh_notifications").update({ status: "sent", sent_at: new Date().toISOString(), error: null }).eq("id", n.id);
        } else {
          const e = r.body?.error || {};
          const code = Number(e.code);
          // 132001 = template missing / not approved yet; 190 = token expired or wrong
          if (code === 132001 || code === 190) {
            await putBack(i, `WhatsApp ${code}: ${code === 190 ? "access token invalid or expired — save a new one in Settings" : "message templates not approved yet"}`);
            break;
          }
          wa.failed++;
          // 131026 = not a WhatsApp number
          const final = code === 131026 || n.attempts >= 3;
          await db.from("boh_notifications").update({
            status: final ? "failed" : "pending",
            error: `WhatsApp ${code || r.status}: ${(e.error_data?.details || e.message || "").slice(0, 250)}`,
          }).eq("id", n.id);
        }
      }
    }

    const { data: s } = await db.from("boh_settings").select("company_name,email_from,email_from_name").eq("id", 1).single();
    const { count: pending } = await db.from("boh_notifications").select("id", { count: "exact", head: true }).eq("channel", "email").eq("status", "pending");
    if (!P.brevo_api_key || !s?.email_from) return json({ configured: false, pending, whatsapp: wa, message: "Add the Brevo API key and sender email in Settings → Notifications" });

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
    return json({ configured: true, sent, failed, remaining: Math.max(0, (pending || 0) - sent - failed), whatsapp: wa });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
