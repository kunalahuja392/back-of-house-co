// Back of House Co — user management (runs with the service role, so the browser never needs it)
// Actions:
//   create_user  – admins create coordinators / restaurant users; super admin can also create admins
//   set_password – admins reset a user's password
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
    const url = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const body = await req.json();
    const action = body.action;

    // ---------------------------------------------------------------- authenticated actions
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: who } = await admin.auth.getUser(token);
    if (!who?.user) return json({ error: "Not signed in" }, 401);
    const { data: me } = await admin.from("boh_users").select("role, active").eq("id", who.user.id).single();
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
      const { error } = await admin.from("boh_users").insert({
        id: created.data.user!.id, email, full_name: body.full_name || email, phone: body.phone || null,
        role, restaurant_id: role === "customer" ? body.restaurant_id : null, active: true,
      });
      if (error) {
        await admin.auth.admin.deleteUser(created.data.user!.id);
        return json({ error: error.message }, 400);
      }
      return json({ ok: true, id: created.data.user!.id });
    }

    if (action === "set_password") {
      const { data: target } = await admin.from("boh_users").select("role").eq("id", body.user_id).single();
      if (!target) return json({ error: "User not found" }, 404);
      if (!canManage(target.role)) return json({ error: "Only the super admin can change admin passwords" }, 403);
      if (!body.password || String(body.password).length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
      const { error } = await admin.auth.admin.updateUserById(body.user_id, { password: body.password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
