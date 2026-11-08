import { sb, state, $, $$, esc, toast, q, callUsersFn } from "./lib.js?v=4";
import * as admin from "./admin.js?v=4";
import * as reports from "./reports.js?v=4";
import * as coord from "./coordinator.js?v=4";
import * as cust from "./customer.js?v=4";

const root = document.getElementById("root");

const MENUS = {
  staff: [
    ["Operations"],
    ["dashboard", "📊", "Dashboard", admin.dashboard],
    ["orders", "🧾", "Orders & allocation", admin.orders],
    ["tasks", "✅", "My assigned orders", coord.tasks],
    ["requests", "🙋", "Product requests", admin.requests],
    ["complaints", "⚠️", "Complaints", admin.complaints],
    ["Catalogue"],
    ["restaurants", "🍽️", "Restaurants", admin.restaurants],
    ["products", "📦", "Products & rates", admin.products],
    ["vendors", "🚚", "Vendors", admin.vendors],
    ["categories", "🗂️", "Categories & margins", admin.categories],
    ["showcase", "🖼️", "Showcase slideshow", admin.showcase],
    ["Insights"],
    ["reports", "📈", "Reports", reports.reports],
    ["Admin"],
    ["team", "👥", "Team & logins", admin.team],
    ["settings", "⚙️", "Settings", admin.settings, "super_admin"],
  ],
  coordinator: [
    ["tasks", "✅", "My orders", coord.tasks],
    ["complaints", "⚠️", "Complaints", admin.complaints],
    ["vendors", "🚚", "Vendor contacts", coord.vendorContacts],
  ],
  customer: [
    ["home", "🏠", "Home", cust.home],
    ["order", "🛒", "Place order", cust.placeOrder],
    ["myorders", "🧾", "My orders", cust.myOrders],
    ["browse", "🔎", "Browse & request", cust.browse],
    ["complaints", "⚠️", "Complaints", cust.complaints],
  ],
};

function menuFor(role) {
  const m = role === "customer" ? MENUS.customer : role === "coordinator" ? MENUS.coordinator : MENUS.staff;
  return m.filter((i) => i.length === 1 || !i[4] || i[4] === role);
}

// ---------------------------------------------------------------- auth screens
function loginView(msg = "") {
  root.innerHTML = `
  <div class="login">
    <div class="hero">
      <div class="brand"><span class="logo">B</span> Back of House Co</div>
      <div>
        <h1>Everything your kitchen runs on, ordered in one place.</h1>
        <p style="max-width:440px;opacity:.85">Raw material, disposables, cleaning supplies and machines. Order before 4 PM, delivered tomorrow.</p>
      </div>
      <div class="small" style="opacity:.6">Accounts are created by the Back of House Co team.</div>
    </div>
    <div class="form"><div>
      <h2>Sign in</h2>
      <p class="muted">Use the email and password shared by our team.</p>
      ${msg ? `<div class="notice">${esc(msg)}</div>` : ""}
      <form id="lf">
        <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="username"></div>
        <div class="field"><label>Password</label><input name="password" type="password" required autocomplete="current-password"></div>
        <button class="btn primary" style="width:100%;justify-content:center">Sign in</button>
      </form>
    </div></div>
  </div>`;
  $("#lf").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const { error } = await sb.auth.signInWithPassword({ email: f.get("email"), password: f.get("password") });
    if (error) toast(error.message, true);
  };
}

// ---------------------------------------------------------------- shell
function shell() {
  const role = state.me.role;
  const items = menuFor(role);
  root.innerHTML = `
  <div class="topbar"><button class="btn sm" id="burger">☰</button><b>Back of House Co</b></div>
  <div class="app">
    <aside class="side" id="side">
      <div class="brand"><span class="logo">B</span> Back of House Co</div>
      <nav class="nav">
        ${items.map((i) => i.length === 1 ? `<div class="nav-sec">${esc(i[0])}</div>`
          : `<a href="#/${i[0]}" data-r="${i[0]}"><span>${i[1]}</span>${esc(i[2])}<span class="badge hidden" data-count="${i[0]}"></span></a>`).join("")}
      </nav>
      <div class="who">
        <div style="color:#fff;font-weight:600">${esc(state.me.full_name)}</div>
        <div>${esc(state.me.role.replace("_", " "))}${state.me.restaurant ? " · " + esc(state.me.restaurant.name) : ""}</div>
        <button class="btn sm" id="logout" style="margin-top:.6rem">Sign out</button>
      </div>
    </aside>
    <main class="main" id="view"></main>
  </div>`;
  $("#logout").onclick = () => sb.auth.signOut();
  $("#burger").onclick = () => $("#side").classList.toggle("open");
  route();
  refreshCounts();
}

async function refreshCounts() {
  if (!["admin", "super_admin"].includes(state.me.role)) return;
  const [o, r, c] = await Promise.all([
    sb.from("boh_orders").select("id", { count: "exact", head: true }).eq("status", "placed"),
    sb.from("boh_product_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
    sb.from("boh_complaints").select("id", { count: "exact", head: true }).neq("status", "resolved"),
  ]);
  const set = (k, n) => { const el = $(`[data-count="${k}"]`); if (el) { el.textContent = n; el.classList.toggle("hidden", !n); } };
  set("orders", o.count); set("requests", r.count); set("complaints", c.count);
}
window.bohRefreshCounts = refreshCounts;

function route() {
  const view = $("#view");
  if (!view) return;
  const items = menuFor(state.me.role).filter((i) => i.length > 1);
  const name = (location.hash.replace(/^#\/?/, "").split("?")[0]) || items[0][0];
  const item = items.find((i) => i[0] === name) || items[0];
  $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.r === item[0]));
  $("#side")?.classList.remove("open");
  view.innerHTML = `<div class="empty">Loading…</div>`;
  item[3](view).catch((e) => { console.error(e); view.innerHTML = `<div class="card">Something went wrong: ${esc(e.message)}</div>`; });
}

// ---------------------------------------------------------------- boot
async function loadMe(session) {
  if (!session) { state.me = null; return loginView(); }
  const { data: me } = await sb.from("boh_users").select("*, restaurant:boh_restaurants!boh_users_restaurant_id_fkey(id,name)").eq("id", session.user.id).maybeSingle();
  if (!me || !me.active) {
    await sb.auth.signOut();
    return loginView("This login is not set up for Back of House Co, or has been deactivated. Please contact the team.");
  }
  state.me = me;
  state.settings = await q(sb.from("boh_settings").select("*").eq("id", 1).single());
  shell();
}

window.addEventListener("hashchange", () => {
  if (state.me) route();
});

let lastUser;
sb.auth.onAuthStateChange((_evt, session) => {
  const uid = session?.user?.id || null;
  if (uid === lastUser) return; // ignore token refreshes
  lastUser = uid;
  setTimeout(() => loadMe(session), 0);
});
