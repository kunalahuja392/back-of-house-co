// Back of House Co — user management (runs with the service role, so the browser never needs it)
// Actions:
//   create_user       – admins create coordinators / restaurant logins; super admin can also create admins
//   set_password      – admins reset a user's password
//   set_own_password  – any signed-in user changes their own password (also used after a reset link)
// Passwords set through this function are kept in boh_user_secrets, readable only by the super admin.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const body = await req.json();
    const action = body.action;
    const saveSecret = (user_id: string, password: string) =>
      admin.from("boh_user_secrets").upsert({ user_id, password, updated_at: new Date().toISOString() });

    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: who } = await admin.auth.getUser(token);
    if (!who?.user) return json({ error: "Not signed in" }, 401);
    const { data: me } = await admin.from("boh_users").select("role, active").eq("id", who.user.id).single();

    if (action === "set_own_password") {
      if (!body.password || String(body.password).length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
      const { error } = await admin.auth.admin.updateUserById(who.user.id, { password: body.password });
      if (error) return json({ error: error.message }, 400);
      if (me) await saveSecret(who.user.id, body.password);
      return json({ ok: true });
    }

    if (!me || !me.active || !["super_admin", "admin"].includes(me.role)) return json({ error: "Admins only" }, 403);
    const canManage = (role: string) => me.role === "super_admin" || ["coordinator", "customer"].includes(role);

    if (action === "create_user") {
      const role = String(body.role);
      if (!["super_admin", "admin", "coordinator", "customer"].includes(role)) return json({ error: "Invalid role" }, 400);
      if (!canManage(role)) return json({ error: "Only the super admin can create admins" }, 403);
      if (role === "customer" && !body.restaurant_id) return json({ error: "Pick the restaurant for this login" }, 400);
      const email = String(body.email || "").trim().toLowerCase();
      if (!email || !body.password || String(body.password).length < 8)
        return json({ error: "Email and a password of at least 8 characters are required" }, 400);

      const created = await admin.auth.admin.createUser({ email, password: body.password, email_confirm: true });
      if (created.error) return json({ error: created.error.message }, 400);
      const id = created.data.user!.id;
      const { error } = await admin.from("boh_users").insert({
        id, email, full_name: body.full_name || email, phone: body.phone || null,
        role, restaurant_id: role === "customer" ? body.restaurant_id : null, active: true,
      });
      if (error) {
        await admin.auth.admin.deleteUser(id);
        return json({ error: error.message }, 400);
      }
      await saveSecret(id, body.password);
      return json({ ok: true, id });
    }

    if (action === "set_password") {
      const { data: target } = await admin.from("boh_users").select("role").eq("id", body.user_id).single();
      if (!target) return json({ error: "User not found" }, 404);
      if (!canManage(target.role)) return json({ error: "Only the super admin can change admin passwords" }, 403);
      if (!body.password || String(body.password).length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
      const { error } = await admin.auth.admin.updateUserById(body.user_id, { password: body.password });
      if (error) return json({ error: error.message }, 400);
      await saveSecret(body.user_id, body.password);
      return json({ ok: true });
    }

    if (action === "update_login_email") {
      const { data: target } = await admin.from("boh_users").select("role").eq("id", body.user_id).single();
      if (!target) return json({ error: "User not found" }, 404);
      if (!canManage(target.role)) return json({ error: "Not allowed" }, 403);
      const email = String(body.email || "").trim().toLowerCase();
      if (!email) return json({ error: "Email required" }, 400);
      const { error } = await admin.auth.admin.updateUserById(body.user_id, { email, email_confirm: true });
      if (error) return json({ error: error.message }, 400);
      await admin.from("boh_users").update({ email }).eq("id", body.user_id);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
