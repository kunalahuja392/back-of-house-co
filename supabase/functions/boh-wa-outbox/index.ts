// Back of House Co — WhatsApp queue for the self-hosted WhatsApp Web bot.
// The bot authenticates with the bot key (Settings → Notifications) in the x-bot-secret header.
//   {"action":"claim","limit":10}                 → messages to send now
//   {"action":"report","results":[{id,ok,error}]} → mark them sent / failed
import { createClient } from "npm:@supabase/supabase-js@2";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  try {
    const { data: key } = await db.from("boh_private").select("value").eq("key", "bot_secret").single();
    const given = req.headers.get("x-bot-secret") || "";
    if (!key?.value || given !== key.value) return json({ error: "Wrong bot key" }, 401);

    const body = await req.json().catch(() => ({}));
    if (body.action === "claim") {
      const { data: s } = await db.from("boh_settings").select("notify_whatsapp").eq("id", 1).single();
      if (!s?.notify_whatsapp) {
        await db.from("boh_settings").update({ bot_last_seen: new Date().toISOString() }).eq("id", 1);
        return json({ messages: [], paused: true });
      }
      const { data, error } = await db.rpc("boh_wa_claim", { p_limit: Math.min(Number(body.limit) || 10, 30) });
      if (error) return json({ error: error.message }, 500);
      return json({ messages: data || [] });
    }
    if (body.action === "report") {
      for (const r of body.results || []) {
        if (!r?.id) continue;
        if (r.ok) {
          await db.from("boh_notifications").update({ status: "sent", sent_at: new Date().toISOString(), error: null }).eq("id", r.id);
        } else {
          const { data: n } = await db.from("boh_notifications").select("attempts").eq("id", r.id).single();
          // numbers that are not on WhatsApp are not retried
          const final = r.notOnWhatsApp || (n?.attempts ?? 0) >= 3;
          await db.from("boh_notifications").update({ status: final ? "failed" : "pending", error: String(r.error || "failed").slice(0, 300) }).eq("id", r.id);
        }
      }
      return json({ ok: true });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
