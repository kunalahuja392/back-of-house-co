import {
  sb, state, $, $$, esc, money, num, pct, fmtDT, fmtD, toast, modal, confirmBox, formData, q, callUsersFn,
  uploadImage, tabs, statusBadge, dueBadge, stepsHTML, telLinks, DELIVERY_LABEL, NEXT_STEP, STEP_BUTTON, todayIST, daysAgoIST,
  downloadCSV, promptBox,
} from "./lib.js?v=5";

const isSuper = () => state.me.role === "super_admin";
const refreshCounts = () => window.bohRefreshCounts?.();

async function lookups() {
  const [cats, rests, team] = await Promise.all([
    q(sb.from("boh_categories").select("*").order("sort").order("name")),
    q(sb.from("boh_restaurants").select("id,name,coordinator_id,active").order("name")),
    q(sb.from("boh_users").select("id,full_name,phone,role,active").in("role", ["coordinator", "admin", "super_admin"]).order("full_name")),
  ]);
  return { cats, rests, team, restMap: Object.fromEntries(rests.map((r) => [r.id, r])), teamMap: Object.fromEntries(team.map((t) => [t.id, t])) };
}

// ====================================================================== DASHBOARD
export async function dashboard(el) {
  const monthStart = todayIST().slice(0, 8) + "01";
  const [orders, reqs, comps, L] = await Promise.all([
    q(sb.from("boh_orders").select("*").gte("created_at", daysAgoIST(45) + "T00:00:00+05:30").order("created_at", { ascending: false })),
    q(sb.from("boh_product_requests").select("id").eq("status", "pending")),
    q(sb.from("boh_complaints").select("id").neq("status", "resolved")),
    lookups(),
  ]);
  const today = todayIST();
  const isToday = (d) => new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 10) === today;
  const live = orders.filter((o) => o.status !== "cancelled");
  const month = live.filter((o) => o.created_at >= monthStart);
  const sales = month.reduce((a, o) => a + Number(o.total), 0);
  const cost = month.reduce((a, o) => a + Number(o.cost_total), 0);
  const overdue = live.filter((o) => !["paid"].includes(o.status) && dueBadge(o).includes("Overdue"));
  el.innerHTML = `
    <div class="page-head"><div><h1>Dashboard</h1><div class="muted">Good to see you, ${esc(state.me.full_name.split(" ")[0])}.</div></div>
      <a class="btn primary" href="#/orders">Go to orders</a></div>
    <div class="grid k4">
      <div class="card stat"><div class="l">Orders today</div><div class="v">${live.filter((o) => isToday(o.created_at)).length}</div></div>
      <div class="card stat"><div class="l">Awaiting allocation</div><div class="v">${live.filter((o) => o.status === "placed").length}</div></div>
      <div class="card stat"><div class="l">Overdue steps</div><div class="v" style="color:var(--danger)">${overdue.length}</div></div>
      <div class="card stat"><div class="l">Payments pending</div><div class="v">${live.filter((o) => o.status === "delivered").length}</div></div>
      <div class="card stat"><div class="l">Sales this month</div><div class="v">${money(sales)}</div></div>
      <div class="card stat"><div class="l">Gross margin this month</div><div class="v">${money(sales - cost)}</div><div class="small muted">${sales ? pct(((sales - cost) / sales) * 100) : ""}</div></div>
      <div class="card stat"><div class="l">Pending product requests</div><div class="v">${reqs.length}</div></div>
      <div class="card stat"><div class="l">Open complaints</div><div class="v">${comps.length}</div></div>
    </div>
    <div class="card" style="margin-top:1rem"><div class="row between"><h2>Needs attention</h2></div>
      ${orderTable([...overdue, ...live.filter((o) => o.status === "placed" && !overdue.includes(o))].slice(0, 15), L)}</div>`;
  bindOrderTable(el, L, () => dashboard(el));
}

// ====================================================================== ORDERS
function orderTable(rows, L) {
  if (!rows.length) return `<div class="empty">No orders here.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>#</th><th>Restaurant</th><th>Placed</th><th>Delivery</th><th class="right">Total</th><th>Status</th><th>Coordinator</th><th>SLA</th><th></th></tr></thead><tbody>
    ${rows.map((o) => `<tr>
      <td><b>${o.order_no}</b></td>
      <td>${esc(L.restMap[o.restaurant_id]?.name || "—")}</td>
      <td>${fmtDT(o.created_at)}</td>
      <td>${fmtD(o.delivery_date)}</td>
      <td class="right">${money(o.total)}</td>
      <td>${statusBadge(o.status)}</td>
      <td>${o.coordinator_id ? esc(L.teamMap[o.coordinator_id]?.full_name || "—") : '<span class="muted">Unassigned</span>'}</td>
      <td>${dueBadge(o)}</td>
      <td class="right" style="white-space:nowrap">
        ${o.status !== "cancelled" && !["delivered", "paid"].includes(o.status) ? `<button class="btn sm" data-alloc="${o.id}">${o.coordinator_id ? "Reassign" : "Allocate"}</button>` : ""}
        <button class="btn sm" data-view="${o.id}">Open</button></td>
    </tr>`).join("")}</tbody></table></div>`;
}

function bindOrderTable(el, L, reload) {
  $$("[data-alloc]", el).forEach((b) => (b.onclick = () => allocateModal(b.dataset.alloc, L, reload)));
  $$("[data-view]", el).forEach((b) => (b.onclick = () => orderModal(b.dataset.view, reload)));
}

async function allocateModal(orderId, L, reload) {
  const o = await q(sb.from("boh_orders").select("*").eq("id", orderId).single());
  const def = o.coordinator_id || L.restMap[o.restaurant_id]?.coordinator_id || "";
  const m = modal({
    title: `Allocate order #${o.order_no}`,
    body: `<p class="muted">${esc(L.restMap[o.restaurant_id]?.name)} · placed ${fmtDT(o.created_at)} · ${dueBadge(o)}</p>
      <div class="field"><label>Coordinator</label><select id="co">
        ${L.team.filter((t) => t.active).map((t) => `<option value="${t.id}" ${t.id === def ? "selected" : ""}>${esc(t.full_name)} (${t.role})${t.phone ? " · " + esc(t.phone) : ""}</option>`).join("")}
      </select></div>`,
    footer: `<button class="btn primary" id="go">Allocate</button>`,
  });
  $("#go", m.el).onclick = async () => {
    await q(sb.rpc("boh_allocate_order", { p_order: orderId, p_coordinator: $("#co", m.el).value }));
    toast("Order allocated"); m.close(); refreshCounts(); reload();
  };
}

export async function orderModal(orderId, reload) {
  const [o, items, events] = await Promise.all([
    q(sb.from("boh_orders").select("*, restaurant:boh_restaurants(name,phone,address), coordinator:boh_users!boh_orders_coordinator_id_fkey(full_name,phone)").eq("id", orderId).single()),
    q(sb.from("boh_order_items").select("*, vendor:boh_vendors(name,phones,delivery_style)").eq("order_id", orderId).order("vendor_name").order("product_name")),
    q(sb.from("boh_order_events").select("*, actor:boh_users(full_name)").eq("order_id", orderId).order("created_at")),
  ]);
  const canAct = ["admin", "super_admin"].includes(state.me.role) || o.coordinator_id === state.me.id;
  const next = NEXT_STEP[o.status];
  const isStaff = ["admin", "super_admin"].includes(state.me.role);
  // group lines by vendor so the coordinator can call each vendor once
  const byVendor = {};
  items.forEach((i) => { (byVendor[i.vendor_id || "none"] ||= { v: i.vendor, name: i.vendor_name, style: i.delivery_style, lines: [] }).lines.push(i); });
  const m = modal({
    wide: true,
    title: `Order #${o.order_no} — ${o.restaurant?.name || ""}`,
    body: `
      <div class="row" style="margin-bottom:1rem">${statusBadge(o.status)} ${dueBadge(o)}
        <span class="muted">Placed ${fmtDT(o.created_at)} · Delivery ${fmtD(o.delivery_date)} · Coordinator: ${esc(o.coordinator?.full_name || "Unassigned")}</span></div>
      ${o.notes ? `<div class="notice">Restaurant note: ${esc(o.notes)}</div>` : ""}
      <div class="grid c2">
        <div>
          <h3>Items by vendor</h3>
          ${Object.values(byVendor).map((g) => `
            <div class="card" style="padding:.75rem">
              <div class="row between"><b>${esc(g.name || "No vendor")}</b><span class="badge info">${esc(DELIVERY_LABEL[g.style] || g.style || "")}</span></div>
              <div class="small phones" style="margin:.3rem 0 .5rem">📞 ${telLinks(g.v?.phones)}</div>
              <table><thead><tr><th>Item</th><th class="right">Qty</th>${isStaff ? '<th class="right">Cost</th><th class="right">Margin</th>' : ""}<th class="right">Price</th><th class="right">Total</th></tr></thead><tbody>
              ${g.lines.map((i) => `<tr><td>${esc(i.product_name)} <span class="small muted">${esc(i.category_name || "")}</span></td><td class="right">${num(i.qty, 3)} ${esc(i.unit || "")}</td>
                ${isStaff ? `<td class="right">${money(i.unit_cost)}</td><td class="right">${pct(i.margin_pct)}</td>` : ""}
                <td class="right">${money(i.unit_price)}</td><td class="right">${money(i.line_total)}</td></tr>`).join("")}
              </tbody></table>
            </div>`).join("")}
          <div class="row between" style="margin-top:.75rem"><b>Order total</b><b>${money(o.total)}</b></div>
          ${isStaff ? `<div class="row between small muted"><span>Cost ${money(o.cost_total)}</span><span>Margin ${money(o.total - o.cost_total)}</span></div>` : ""}
        </div>
        <div>
          <h3>Workflow</h3>
          ${stepsHTML(o)}
          ${o.followup1_note ? `<p class="small"><b>1st follow-up:</b> ${esc(o.followup1_note)}</p>` : ""}
          ${o.followup2_note ? `<p class="small"><b>2nd follow-up:</b> ${esc(o.followup2_note)}</p>` : ""}
          ${o.payment_ref ? `<p class="small"><b>Payment ref:</b> ${esc(o.payment_ref)}</p>` : ""}
          <h3 style="margin-top:1rem">Activity</h3>
          <div class="small">${events.map((e) => `<div>${fmtDT(e.created_at)} — <b>${esc(e.event)}</b> ${e.note ? "· " + esc(e.note) : ""} <span class="muted">${esc(e.actor?.full_name || "")}</span></div>`).join("")}</div>
          <p class="small muted" style="margin-top:.75rem">Restaurant: ${esc(o.restaurant?.phone || "")} · ${esc(o.restaurant?.address || "")}</p>
        </div>
      </div>`,
    footer: `${isStaff && !["paid", "cancelled"].includes(o.status) ? `<button class="btn danger" id="cancel">Cancel order</button>` : ""}
      <span class="grow"></span>
      ${o.status === "followup1" && canAct ? `<button class="btn" data-step="delivered">Mark delivered</button>` : ""}
      ${o.status === "vendor_ordered" && canAct ? `<button class="btn" data-step="delivered">Mark delivered (early)</button>` : ""}
      ${next && canAct ? `<button class="btn primary" data-step="${next}">${STEP_BUTTON[next]}</button>` : ""}
      ${o.status === "placed" ? `<span class="muted small">Allocate a coordinator to start the workflow</span>` : ""}`,
  });
  $$("[data-step]", m.el).forEach((b) => (b.onclick = async () => {
    const step = b.dataset.step;
    let note = null;
    if (["followup1", "followup2"].includes(step)) { note = await promptBox("Follow-up note", "What did the vendor say?"); if (note === null) return; }
    if (step === "paid") { note = await promptBox("Payment completed", "Payment reference (UPI / cheque / cash)"); if (note === null) return; }
    await q(sb.rpc("boh_advance_order", { p_order: orderId, p_step: step, p_note: note }));
    toast("Updated"); m.close(); reload?.(); refreshCounts();
  }));
  const c = $("#cancel", m.el);
  if (c) c.onclick = async () => {
    if (!(await confirmBox(`Cancel order #${o.order_no}?`))) return;
    await q(sb.rpc("boh_advance_order", { p_order: orderId, p_step: "cancelled", p_note: null }));
    toast("Order cancelled"); m.close(); reload?.(); refreshCounts();
  };
}

export async function orders(el) {
  const L = await lookups();
  el.innerHTML = `
    <div class="page-head"><div><h1>Orders & allocation</h1><div class="muted">Allocate each order to a coordinator within ${state.settings.sla_allocate_hrs} working hours.</div></div></div>
    <div class="card"><div class="row">
      <div><label>Status</label><select id="fs"><option value="open">Open (not paid)</option><option value="placed">Awaiting allocation</option><option value="">All</option>
        ${["allocated", "acknowledged", "vendor_ordered", "followup1", "followup2", "delivered", "paid", "cancelled"].map((s) => `<option value="${s}">${s}</option>`).join("")}</select></div>
      <div><label>Restaurant</label><select id="fr"><option value="">All</option>${L.rests.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("")}</select></div>
      <div><label>Coordinator</label><select id="fc"><option value="">All</option>${L.team.map((t) => `<option value="${t.id}">${esc(t.full_name)}</option>`).join("")}</select></div>
      <div><label>From</label><input type="date" id="ff" value="${daysAgoIST(30)}"></div>
      <div><label>To</label><input type="date" id="ft" value="${todayIST()}"></div>
    </div></div>
    <div id="list" style="margin-top:1rem"></div>`;
  const load = async () => {
    let qq = sb.from("boh_orders").select("*").order("created_at", { ascending: false })
      .gte("created_at", $("#ff").value + "T00:00:00+05:30").lte("created_at", $("#ft").value + "T23:59:59+05:30");
    const s = $("#fs").value;
    if (s === "open") qq = qq.not("status", "in", "(paid,cancelled)"); else if (s) qq = qq.eq("status", s);
    if ($("#fr").value) qq = qq.eq("restaurant_id", $("#fr").value);
    if ($("#fc").value) qq = qq.eq("coordinator_id", $("#fc").value);
    const rows = await q(qq);
    $("#list").innerHTML = orderTable(rows, L);
    bindOrderTable($("#list"), L, load);
  };
  $$("select, input", el).forEach((i) => (i.onchange = load));
  load();
}

// ====================================================================== RESTAURANTS
export async function restaurants(el) {
  const L = await lookups();
  const rows = await q(sb.from("boh_restaurants").select("*, boh_restaurant_products(count), boh_users!boh_users_restaurant_id_fkey(count)").order("name"));
  el.innerHTML = `
    <div class="page-head"><div><h1>Restaurants</h1><div class="muted">Customers are added only by the team. Allocate their ordering list and set mark-ups.</div></div>
      <button class="btn primary" id="add">+ Add restaurant</button></div>
    <div class="row" style="margin-bottom:.75rem"><input id="s" placeholder="Search restaurants…" style="max-width:320px"></div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Contact</th><th>Coordinator</th><th class="right">Items on list</th><th class="right">Logins</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr data-name="${esc(r.name.toLowerCase())}">
      <td><b>${esc(r.name)}</b><div class="small muted">${esc(r.address || "")}</div></td><td>${esc(r.outlet_type || "")}</td>
      <td>${esc(r.contact_name || "")}<div class="small">${esc(r.phone || "")}</div></td>
      <td>${esc(L.teamMap[r.coordinator_id]?.full_name || "—")}</td>
      <td class="right">${r.boh_restaurant_products?.[0]?.count ?? 0}</td>
      <td class="right">${r.boh_users?.[0]?.count ?? 0}</td>
      <td>${r.active ? '<span class="badge ok">Active</span>' : '<span class="badge">Inactive</span>'}</td>
      <td class="right"><button class="btn sm" data-edit="${r.id}">Manage</button></td></tr>`).join("") || `<tr><td colspan="8" class="empty">No restaurants yet.</td></tr>`}</tbody></table></div>`;
  $("#s").oninput = (e) => $$("tbody tr[data-name]", el).forEach((tr) => tr.classList.toggle("hidden", !tr.dataset.name.includes(e.target.value.toLowerCase())));
  $("#add").onclick = () => restaurantEditor(null, L, () => restaurants(el));
  $$("[data-edit]", el).forEach((b) => (b.onclick = () => restaurantEditor(b.dataset.edit, L, () => restaurants(el))));
}

async function restaurantEditor(id, L, reload) {
  let r = { active: true, outlet_type: "Restaurant" };
  let margins = {};
  if (id) {
    r = await q(sb.from("boh_restaurants").select("*").eq("id", id).single());
    (await q(sb.from("boh_restaurant_category_margins").select("*").eq("restaurant_id", id))).forEach((m) => (margins[m.category_id] = m.margin_pct));
  }
  const m = modal({
    wide: true,
    title: id ? r.name : "Add restaurant",
    body: `<div class="tabs" id="rt"></div><div id="rb"></div>`,
  });
  const body = $("#rb", m.el);
  const names = id ? ["Details", "Category mark-up", "Ordering list & pricing", "Add products", "Logins"] : ["Details & mark-up"];
  tabs($("#rt", m.el), names, (i) => {
    if (!id) return detailsTab(true);
    [() => detailsTab(false), marginTab, listTab, addProductsTab, loginsTab][i]();
  });

  function detailsTab(withMargins) {
    body.innerHTML = `
      <div class="form-grid" id="df">
        <div class="field"><label>Restaurant / cafe name *</label><input name="name" value="${esc(r.name || "")}"></div>
        <div class="field"><label>Outlet type</label><select name="outlet_type">${["Restaurant", "Cafe", "Bakery", "Cloud kitchen", "Hotel", "Bar", "Caterer", "Other"].map((t) => `<option ${t === r.outlet_type ? "selected" : ""}>${t}</option>`).join("")}</select></div>
        <div class="field"><label>Contact person</label><input name="contact_name" value="${esc(r.contact_name || "")}"></div>
        <div class="field"><label>Phone</label><input name="phone" value="${esc(r.phone || "")}"></div>
        <div class="field"><label>Email</label><input name="email" value="${esc(r.email || "")}"></div>
        <div class="field"><label>GSTIN</label><input name="gstin" value="${esc(r.gstin || "")}"></div>
        <div class="field"><label>Coordinator (shown to the restaurant)</label><select name="coordinator_id"><option value="">— none —</option>
          ${L.team.filter((t) => t.active).map((t) => `<option value="${t.id}" ${t.id === r.coordinator_id ? "selected" : ""}>${esc(t.full_name)}${t.phone ? " · " + esc(t.phone) : ""}</option>`).join("")}</select></div>
        <div class="field"><label>Status</label><select name="active"><option value="true">Active</option><option value="false" ${r.active ? "" : "selected"}>Inactive</option></select></div>
      </div>
      <div class="field"><label>Delivery address</label><textarea name="address" rows="2">${esc(r.address || "")}</textarea></div>
      <div class="field"><label>Internal notes</label><textarea name="notes" rows="2">${esc(r.notes || "")}</textarea></div>
      ${withMargins ? `<h3>Category mark-up</h3><p class="small muted">Pre-filled with each category's default. You'll pick the ordering list in the next step.</p>${marginGrid()}` : ""}
      <div class="row" style="justify-content:flex-end"><button class="btn primary" id="save">${id ? "Save details" : "Create & choose products"}</button></div>`;
    $("#save", body).onclick = async () => {
      const f = formData(body);
      if (!f.name) return toast("Name is required", true);
      const rec = { name: f.name, outlet_type: f.outlet_type, contact_name: f.contact_name, phone: f.phone, email: f.email, gstin: f.gstin,
        coordinator_id: f.coordinator_id, active: f.active === "true", address: f.address, notes: f.notes };
      if (id) {
        await q(sb.from("boh_restaurants").update(rec).eq("id", id));
        toast("Saved"); Object.assign(r, rec); reload();
      } else {
        const created = await q(sb.from("boh_restaurants").insert(rec).select().single());
        await saveMargins(created.id);
        toast("Restaurant created — now allocate products");
        m.close(); reload();
        restaurantEditor(created.id, L, reload);
      }
    };
  }

  function marginGrid() {
    return `<div class="form-grid">${L.cats.map((c) => `<div class="field"><label>${esc(c.name)} <span class="muted">(default ${pct(c.default_margin)})</span></label>
      <input type="number" step="0.01" data-cat="${c.id}" value="${margins[c.id] ?? c.default_margin}"></div>`).join("")}</div>`;
  }
  async function saveMargins(rid) {
    const rows = $$("[data-cat]", body).filter((i) => i.value !== "").map((i) => ({ restaurant_id: rid, category_id: i.dataset.cat, margin_pct: Number(i.value) }));
    if (rows.length) await q(sb.from("boh_restaurant_category_margins").upsert(rows));
  }

  function marginTab() {
    body.innerHTML = `<p class="muted">Mark-up applied on the best vendor rate for every product of a category. Individual products can be overridden in the ordering list tab.</p>
      ${marginGrid()}<div class="row" style="justify-content:flex-end"><button class="btn primary" id="sm">Save mark-up</button></div>`;
    $("#sm", body).onclick = async () => {
      await saveMargins(id);
      $$("[data-cat]", body).forEach((i) => (margins[i.dataset.cat] = Number(i.value)));
      toast("Mark-up saved");
    };
  }

  async function listTab() {
    body.innerHTML = `<div class="empty">Loading…</div>`;
    const rows = await q(sb.rpc("boh_restaurant_catalog", { p_restaurant: id }));
    body.innerHTML = `
      <div class="row between" style="margin-bottom:.6rem"><div class="muted">${rows.length} products on this restaurant's ordering list. Leave "override" blank to use the category mark-up.</div>
        <input id="ls" placeholder="Filter…" style="max-width:240px"></div>
      <div class="table-wrap"><table><thead><tr><th>Product</th><th>Category</th><th class="right">Best cost</th><th>Vendor</th><th class="right">Override %</th><th class="right">Effective</th><th class="right">Selling price</th><th>On list</th><th></th></tr></thead><tbody>
      ${rows.map((x) => `<tr data-n="${esc((x.product_name + " " + x.category_name).toLowerCase())}">
        <td>${esc(x.product_name)} <span class="small muted">/${esc(x.unit)}</span></td><td>${esc(x.category_name)}</td>
        <td class="right">${x.cost == null ? '<span class="badge danger">No rate</span>' : money(x.cost)}</td><td class="small">${esc(x.vendor_name || "")}</td>
        <td class="right"><input type="number" step="0.01" style="width:90px" data-ov="${x.rp_id}" value="${x.margin_override ?? ""}" placeholder="—"></td>
        <td class="right">${pct(x.effective_margin)}</td><td class="right"><b>${money(x.price)}</b></td>
        <td><input type="checkbox" data-act="${x.rp_id}" ${x.rp_active ? "checked" : ""}></td>
        <td><button class="btn sm danger" data-del="${x.rp_id}">Remove</button></td></tr>`).join("") || `<tr><td colspan="9" class="empty">No products allocated yet — use “Add products”.</td></tr>`}
      </tbody></table></div>`;
    $("#ls", body).oninput = (e) => $$("tr[data-n]", body).forEach((tr) => tr.classList.toggle("hidden", !tr.dataset.n.includes(e.target.value.toLowerCase())));
    $$("[data-ov]", body).forEach((i) => (i.onchange = async () => {
      await q(sb.from("boh_restaurant_products").update({ margin_override: i.value === "" ? null : Number(i.value) }).eq("id", i.dataset.ov));
      toast("Mark-up updated"); listTab();
    }));
    $$("[data-act]", body).forEach((i) => (i.onchange = async () => {
      await q(sb.from("boh_restaurant_products").update({ active: i.checked }).eq("id", i.dataset.act)); toast("Updated");
    }));
    $$("[data-del]", body).forEach((b) => (b.onclick = async () => {
      await q(sb.from("boh_restaurant_products").delete().eq("id", b.dataset.del)); listTab();
    }));
  }

  async function addProductsTab() {
    body.innerHTML = `<div class="empty">Loading…</div>`;
    const [prods, have] = await Promise.all([
      q(sb.from("boh_products").select("id,name,unit,brand,category_id,active").eq("active", true).order("name")),
      q(sb.from("boh_restaurant_products").select("product_id").eq("restaurant_id", id)),
    ]);
    const haveSet = new Set(have.map((h) => h.product_id));
    const avail = prods.filter((p) => !haveSet.has(p.id));
    body.innerHTML = `
      <div class="row between" style="margin-bottom:.6rem"><div class="muted">Tick the products from this restaurant's ordering list. ${avail.length} available.</div>
        <input id="ps" placeholder="Search products…" style="max-width:260px"></div>
      ${L.cats.map((c) => {
        const list = avail.filter((p) => p.category_id === c.id);
        if (!list.length) return "";
        return `<div class="card" data-catbox style="padding:.75rem"><div class="row between"><b>${esc(c.name)}</b>
          <label class="row" style="margin:0"><input type="checkbox" data-all="${c.id}"> Select all</label></div>
          <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.3rem;margin-top:.5rem">
          ${list.map((p) => `<label class="row" style="margin:0;font-weight:400;color:var(--ink)" data-pn="${esc(p.name.toLowerCase())}"><input type="checkbox" data-pick="${p.id}" data-c="${c.id}"> ${esc(p.name)} <span class="muted small">${esc(p.unit)}</span></label>`).join("")}
          </div></div>`;
      }).join("") || '<div class="empty">Every active product is already on this list.</div>'}
      <div class="row" style="justify-content:flex-end;margin-top:1rem"><button class="btn primary" id="addsel">Add selected to ordering list</button></div>`;
    $("#ps", body).oninput = (e) => $$("[data-pn]", body).forEach((l) => l.classList.toggle("hidden", !l.dataset.pn.includes(e.target.value.toLowerCase())));
    $$("[data-all]", body).forEach((a) => (a.onchange = () => $$(`[data-c="${a.dataset.all}"]`, body).forEach((x) => (x.checked = a.checked))));
    $("#addsel", body).onclick = async () => {
      const ids = $$("[data-pick]:checked", body).map((x) => x.dataset.pick);
      if (!ids.length) return toast("Nothing selected", true);
      await q(sb.from("boh_restaurant_products").insert(ids.map((pid) => ({ restaurant_id: id, product_id: pid }))));
      toast(`${ids.length} products added`); addProductsTab();
    };
  }

  async function loginsTab() {
    const users = await q(sb.from("boh_users").select("*").eq("restaurant_id", id).order("created_at"));
    body.innerHTML = `
      <p class="muted">People at ${esc(r.name)} who can sign in, place orders and raise requests.</p>
      <table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Status</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.full_name)}</td><td>${esc(u.email)}</td><td>${esc(u.phone || "")}</td><td>${u.active ? '<span class="badge ok">Active</span>' : '<span class="badge">Inactive</span>'}</td>
        <td class="right"><button class="btn sm" data-tog="${u.id}" data-on="${u.active}">${u.active ? "Deactivate" : "Activate"}</button> <button class="btn sm" data-pw="${u.id}">Reset password</button></td></tr>`).join("") || '<tr><td colspan="5" class="empty">No logins yet.</td></tr>'}
      </tbody></table>
      <h3 style="margin-top:1rem">Add login</h3>
      <div class="form-grid" id="nl">
        <div class="field"><label>Full name</label><input name="full_name"></div>
        <div class="field"><label>Email</label><input name="email" type="email"></div>
        <div class="field"><label>Phone</label><input name="phone"></div>
        <div class="field"><label>Password (min 8)</label><input name="password" type="text"></div>
      </div><button class="btn primary" id="cl">Create login</button>`;
    $("#cl", body).onclick = async () => {
      const f = formData($("#nl", body));
      try { await callUsersFn({ action: "create_user", ...f, role: "customer", restaurant_id: id }); toast("Login created — share the email & password with the restaurant"); loginsTab(); }
      catch (e) { toast(e.message, true); }
    };
    bindUserActions(body, loginsTab);
  }
}

function bindUserActions(root, reload) {
  $$("[data-tog]", root).forEach((b) => (b.onclick = async () => {
    await q(sb.from("boh_users").update({ active: b.dataset.on !== "true" }).eq("id", b.dataset.tog)); toast("Updated"); reload();
  }));
  $$("[data-pw]", root).forEach((b) => (b.onclick = async () => {
    const pw = await promptBox("Reset password", "New password (min 8 characters)");
    if (!pw) return;
    try { await callUsersFn({ action: "set_password", user_id: b.dataset.pw, password: pw }); toast("Password changed"); } catch (e) { toast(e.message, true); }
  }));
}

// ====================================================================== PRODUCTS & RATES
export async function products(el) {
  const L = await lookups();
  const [prods, rates] = await Promise.all([
    q(sb.from("boh_products").select("*").order("name")),
    q(sb.from("boh_vendor_rates").select("product_id, rate, active, vendor:boh_vendors(name, active)")),
  ]);
  const info = {};
  rates.forEach((r) => {
    const i = (info[r.product_id] ||= { count: 0, best: null, vendor: "" });
    i.count++;
    if (r.active && r.vendor?.active && (i.best == null || Number(r.rate) < i.best)) { i.best = Number(r.rate); i.vendor = r.vendor.name; }
  });
  const catName = Object.fromEntries(L.cats.map((c) => [c.id, c.name]));
  el.innerHTML = `
    <div class="page-head"><div><h1>Products & rates</h1><div class="muted">Each product can have many vendors — the lowest active rate is used for pricing and ordering.</div></div>
      <div class="row"><button class="btn" id="imp">Import CSV</button><button class="btn primary" id="add">+ Add product</button></div></div>
    <div class="row" style="margin-bottom:.75rem">
      <input id="s" placeholder="Search…" style="max-width:280px">
      <select id="c" style="max-width:240px"><option value="">All categories</option>${L.cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
      <label class="row" style="margin:0"><input type="checkbox" id="nr"> Only products without a rate</label>
    </div>
    <div class="table-wrap"><table><thead><tr><th></th><th>Product</th><th>Category</th><th>Unit</th><th class="right">Best rate</th><th>Best vendor</th><th class="right">Vendors</th><th>Status</th><th></th></tr></thead><tbody>
    ${prods.map((p) => { const i = info[p.id] || { count: 0 }; return `<tr data-n="${esc((p.name + " " + (p.brand || "") + " " + (p.sku || "")).toLowerCase())}" data-c="${p.category_id}" data-nr="${i.best == null}">
      <td>${p.image_url ? `<img src="${esc(p.image_url)}" style="width:36px;height:36px;object-fit:cover;border-radius:6px">` : ""}</td>
      <td><b>${esc(p.name)}</b><div class="small muted">${esc([p.brand, p.sku].filter(Boolean).join(" · "))}</div></td>
      <td>${esc(catName[p.category_id] || "")}</td><td>${esc(p.unit)}</td>
      <td class="right">${i.best == null ? '<span class="badge danger">No rate</span>' : money(i.best)}</td><td>${esc(i.vendor || "")}</td>
      <td class="right">${i.count}</td><td>${p.active ? '<span class="badge ok">Active</span>' : '<span class="badge">Inactive</span>'}</td>
      <td class="right"><button class="btn sm" data-edit="${p.id}">Edit & rates</button></td></tr>`; }).join("") || '<tr><td colspan="9" class="empty">No products yet.</td></tr>'}
    </tbody></table></div>`;
  const filter = () => {
    const s = $("#s").value.toLowerCase(), c = $("#c").value, nr = $("#nr").checked;
    $$("tr[data-n]", el).forEach((tr) => tr.classList.toggle("hidden", !(tr.dataset.n.includes(s) && (!c || tr.dataset.c === c) && (!nr || tr.dataset.nr === "true"))));
  };
  $("#s").oninput = filter; $("#c").onchange = filter; $("#nr").onchange = filter;
  $("#add").onclick = () => productEditor(null, L, () => products(el));
  $("#imp").onclick = () => importProducts(L, () => products(el));
  $$("[data-edit]", el).forEach((b) => (b.onclick = () => productEditor(b.dataset.edit, L, () => products(el))));
}

function parseCSV(text) {
  const rows = []; let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inQ = false; else cur += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function importProducts(L, reload) {
  const m = modal({
    title: "Import products from CSV",
    body: `<p>Columns (header row required): <code>category, name, unit, brand, sku, description</code>. Unknown categories are created with 0% default margin.</p>
      <p class="small muted">Tip: paste a restaurant's A-to-Z ordering list here, then allocate it to them from the restaurant screen.</p>
      <input type="file" id="f" accept=".csv,text/csv"><div id="pv" class="small" style="margin-top:.75rem"></div>`,
    footer: `<button class="btn primary" id="go" disabled>Import</button>`,
  });
  let parsed = [];
  $("#f", m.el).onchange = async (e) => {
    const rows = parseCSV(await e.target.files[0].text());
    const head = rows.shift().map((h) => h.trim().toLowerCase());
    parsed = rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || "").trim()]))).filter((r) => r.name && r.category);
    $("#pv", m.el).textContent = `${parsed.length} products ready to import.`;
    $("#go", m.el).disabled = !parsed.length;
  };
  $("#go", m.el).onclick = async () => {
    const catByName = Object.fromEntries(L.cats.map((c) => [c.name.toLowerCase(), c.id]));
    const newCats = [...new Set(parsed.map((p) => p.category).filter((c) => !catByName[c.toLowerCase()]))];
    if (newCats.length) {
      const created = await q(sb.from("boh_categories").insert(newCats.map((name) => ({ name, default_margin: 0, sort: 99 }))).select());
      created.forEach((c) => (catByName[c.name.toLowerCase()] = c.id));
    }
    await q(sb.from("boh_products").insert(parsed.map((p) => ({
      category_id: catByName[p.category.toLowerCase()], name: p.name, unit: p.unit || "pc", brand: p.brand || null, sku: p.sku || null, description: p.description || null,
    }))));
    toast(`${parsed.length} products imported`); m.close(); reload();
  };
}

async function productEditor(id, L, reload) {
  let p = { active: true, unit: "kg", category_id: L.cats[0]?.id };
  if (id) p = await q(sb.from("boh_products").select("*").eq("id", id).single());
  const m = modal({
    wide: true,
    title: id ? p.name : "Add product",
    body: `
      <div class="grid c2">
        <div id="pf">
          <div class="field"><label>Name *</label><input name="name" value="${esc(p.name || "")}"></div>
          <div class="form-grid">
            <div class="field"><label>Category *</label><select name="category_id">${L.cats.map((c) => `<option value="${c.id}" ${c.id === p.category_id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
            <div class="field"><label>Unit</label><input name="unit" value="${esc(p.unit || "")}" placeholder="kg, pc, litre, box of 100"></div>
            <div class="field"><label>Brand</label><input name="brand" value="${esc(p.brand || "")}"></div>
            <div class="field"><label>SKU / code</label><input name="sku" value="${esc(p.sku || "")}"></div>
          </div>
          <div class="field"><label>Description (shown to restaurants)</label><textarea name="description" rows="3">${esc(p.description || "")}</textarea></div>
          <div class="field"><label>Image</label><input type="file" id="img" accept="image/*"><input type="hidden" name="image_url" value="${esc(p.image_url || "")}">
            <div id="imgp" style="margin-top:.4rem">${p.image_url ? `<img src="${esc(p.image_url)}" style="max-height:100px;border-radius:8px">` : ""}</div></div>
          <label class="row" style="margin:0"><input type="checkbox" name="active" ${p.active ? "checked" : ""}> Active</label>
        </div>
        <div id="rates">${id ? "" : '<div class="notice">Save the product first, then add vendor rates.</div>'}</div>
      </div>`,
    footer: `<button class="btn primary" id="save">Save product</button>`,
  });
  $("#img", m.el).onchange = async (e) => {
    const url = await uploadImage(e.target.files[0], "products");
    $('[name="image_url"]', m.el).value = url;
    $("#imgp", m.el).innerHTML = `<img src="${esc(url)}" style="max-height:100px;border-radius:8px">`;
  };
  $("#save", m.el).onclick = async () => {
    const f = formData($("#pf", m.el));
    if (!f.name) return toast("Name is required", true);
    if (id) await q(sb.from("boh_products").update(f).eq("id", id));
    else { const c = await q(sb.from("boh_products").insert(f).select().single()); id = c.id; renderRates(); }
    toast("Product saved"); reload();
  };
  if (id) renderRates();

  async function renderRates() {
    const box = $("#rates", m.el);
    const [rates, vendors] = await Promise.all([
      q(sb.from("boh_vendor_rates").select("*, vendor:boh_vendors(name,active,phones,delivery_style)").eq("product_id", id).order("rate")),
      q(sb.from("boh_vendors").select("id,name,active").order("name")),
    ]);
    const best = rates.find((r) => r.active && r.vendor?.active);
    box.innerHTML = `<h3>Vendor rates</h3>
      <table><thead><tr><th>Vendor</th><th class="right">Rate</th><th>MOQ</th><th>Use</th><th></th></tr></thead><tbody>
      ${rates.map((r) => `<tr>
        <td>${esc(r.vendor?.name)} ${r === best ? '<span class="badge ok">Best</span>' : ""} ${r.vendor?.active ? "" : '<span class="badge">Vendor inactive</span>'}
          <div class="small muted">${esc(DELIVERY_LABEL[r.vendor?.delivery_style] || "")} · ${(r.vendor?.phones || []).map(esc).join(", ")}</div></td>
        <td class="right"><input type="number" step="0.01" style="width:100px" data-rate="${r.id}" value="${r.rate}"></td>
        <td><input style="width:90px" data-moq="${r.id}" value="${esc(r.moq || "")}"></td>
        <td><input type="checkbox" data-ract="${r.id}" ${r.active ? "checked" : ""}></td>
        <td><button class="btn sm danger" data-rdel="${r.id}">×</button></td></tr>`).join("") || '<tr><td colspan="5" class="muted">No vendors yet.</td></tr>'}
      </tbody></table>
      <div class="row" style="margin-top:.6rem">
        <select id="nv" style="flex:2">${vendors.filter((v) => !rates.some((r) => r.vendor_id === v.id)).map((v) => `<option value="${v.id}">${esc(v.name)}${v.active ? "" : " (inactive)"}</option>`).join("")}</select>
        <input id="nr" type="number" step="0.01" placeholder="Rate ₹" style="flex:1">
        <input id="nm" placeholder="MOQ" style="flex:1">
        <button class="btn" id="addr">Add vendor</button>
      </div>
      <p class="small muted">Rates update instantly; restaurant prices = best rate × (1 + mark-up).</p>`;
    $("#addr", box).onclick = async () => {
      if (!$("#nv", box).value || $("#nr", box).value === "") return toast("Pick a vendor and rate", true);
      await q(sb.from("boh_vendor_rates").insert({ product_id: id, vendor_id: $("#nv", box).value, rate: Number($("#nr", box).value), moq: $("#nm", box).value || null }));
      renderRates(); reload();
    };
    $$("[data-rate]", box).forEach((i) => (i.onchange = async () => { await q(sb.from("boh_vendor_rates").update({ rate: Number(i.value), updated_at: new Date().toISOString() }).eq("id", i.dataset.rate)); toast("Rate updated"); renderRates(); reload(); }));
    $$("[data-moq]", box).forEach((i) => (i.onchange = async () => { await q(sb.from("boh_vendor_rates").update({ moq: i.value || null }).eq("id", i.dataset.moq)); toast("Saved"); }));
    $$("[data-ract]", box).forEach((i) => (i.onchange = async () => { await q(sb.from("boh_vendor_rates").update({ active: i.checked }).eq("id", i.dataset.ract)); renderRates(); reload(); }));
    $$("[data-rdel]", box).forEach((b) => (b.onclick = async () => { await q(sb.from("boh_vendor_rates").delete().eq("id", b.dataset.rdel)); renderRates(); reload(); }));
  }
}

// ====================================================================== VENDORS
export async function vendors(el) {
  const rows = await q(sb.from("boh_vendors").select("*, boh_vendor_rates(count)").order("name"));
  el.innerHTML = `
    <div class="page-head"><div><h1>Vendors</h1><div class="muted">Contact numbers and delivery style are shown to coordinators when they place orders.</div></div>
      <button class="btn primary" id="add">+ Add vendor</button></div>
    <div class="row" style="margin-bottom:.75rem"><input id="s" placeholder="Search vendors…" style="max-width:300px">
      <select id="st" style="max-width:180px"><option value="">All</option><option value="true">Active</option><option value="false">Inactive</option></select></div>
    <div class="table-wrap"><table><thead><tr><th>Vendor</th><th>Contact</th><th>Phone numbers</th><th>Delivery</th><th class="right">Products</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((v) => `<tr data-n="${esc(v.name.toLowerCase())}" data-a="${v.active}">
      <td><b>${esc(v.name)}</b><div class="small muted">${esc(v.address || "")}</div></td><td>${esc(v.contact_person || "")}</td>
      <td class="phones">${telLinks(v.phones)}</td><td>${esc(DELIVERY_LABEL[v.delivery_style])}</td>
      <td class="right">${v.boh_vendor_rates?.[0]?.count ?? 0}</td>
      <td><button class="btn sm" data-tog="${v.id}" data-on="${v.active}">${v.active ? "✅ Active" : "⛔ Inactive"}</button></td>
      <td class="right"><button class="btn sm" data-edit="${v.id}">Edit</button></td></tr>`).join("") || '<tr><td colspan="7" class="empty">No vendors yet.</td></tr>'}
    </tbody></table></div>`;
  const filter = () => $$("tr[data-n]", el).forEach((tr) => tr.classList.toggle("hidden", !(tr.dataset.n.includes($("#s").value.toLowerCase()) && (!$("#st").value || tr.dataset.a === $("#st").value))));
  $("#s").oninput = filter; $("#st").onchange = filter;
  $("#add").onclick = () => vendorEditor(null, () => vendors(el));
  $$("[data-edit]", el).forEach((b) => (b.onclick = () => vendorEditor(b.dataset.edit, () => vendors(el))));
  $$("[data-tog]", el).forEach((b) => (b.onclick = async () => {
    const on = b.dataset.on === "true";
    if (on && !(await confirmBox("Make this vendor inactive? Its rates will stop being used, and the next best vendor takes over."))) return;
    await q(sb.from("boh_vendors").update({ active: !on }).eq("id", b.dataset.tog)); toast(on ? "Vendor deactivated" : "Vendor activated"); vendors(el);
  }));
}

async function vendorEditor(id, reload) {
  let v = { active: true, phones: [""], delivery_style: "vendor_delivers" };
  let rates = [];
  if (id) {
    v = await q(sb.from("boh_vendors").select("*").eq("id", id).single());
    if (!v.phones?.length) v.phones = [""];
    rates = await q(sb.from("boh_vendor_rates").select("*, product:boh_products(name,unit)").eq("vendor_id", id).order("updated_at", { ascending: false }));
  }
  const m = modal({
    wide: !!id,
    title: id ? v.name : "Add vendor",
    body: `<div class="grid ${id ? "c2" : ""}"><div id="vf">
      <div class="form-grid">
        <div class="field"><label>Vendor name *</label><input name="name" value="${esc(v.name || "")}"></div>
        <div class="field"><label>Contact person</label><input name="contact_person" value="${esc(v.contact_person || "")}"></div>
        <div class="field"><label>Email</label><input name="email" value="${esc(v.email || "")}"></div>
        <div class="field"><label>GSTIN</label><input name="gstin" value="${esc(v.gstin || "")}"></div>
        <div class="field"><label>How is the order delivered?</label><select name="delivery_style">
          ${Object.entries(DELIVERY_LABEL).map(([k, l]) => `<option value="${k}" ${k === v.delivery_style ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="field"><label>Status</label><select name="active"><option value="true">Active</option><option value="false" ${v.active ? "" : "selected"}>Inactive</option></select></div>
      </div>
      <div class="field"><label>Phone numbers</label><div id="ph">${v.phones.map((p) => phoneRow(p)).join("")}</div>
        <button class="btn sm" id="addph" type="button">+ Add another number</button></div>
      <div class="field"><label>Address</label><textarea name="address" rows="2">${esc(v.address || "")}</textarea></div>
      <div class="field"><label>Notes</label><textarea name="notes" rows="2">${esc(v.notes || "")}</textarea></div>
    </div>
    ${id ? `<div><h3>Products supplied (${rates.length})</h3><div class="table-wrap" style="max-height:420px"><table><thead><tr><th>Product</th><th class="right">Rate</th><th>Updated</th></tr></thead><tbody>
      ${rates.map((r) => `<tr><td>${esc(r.product?.name)} <span class="small muted">/${esc(r.product?.unit)}</span></td><td class="right">${money(r.rate)}</td><td class="small">${fmtD(r.updated_at)}</td></tr>`).join("") || '<tr><td colspan="3" class="muted">Add rates from Products → Edit & rates.</td></tr>'}
      </tbody></table></div></div>` : ""}</div>`,
    footer: `<button class="btn primary" id="save">Save vendor</button>`,
  });
  function phoneRow(p) { return `<div class="row" style="margin-bottom:.35rem"><input class="phone" value="${esc(p)}" placeholder="+91…"><button class="btn sm" type="button" data-rm>×</button></div>`; }
  const bindRm = () => $$("[data-rm]", m.el).forEach((b) => (b.onclick = () => b.parentElement.remove()));
  bindRm();
  $("#addph", m.el).onclick = () => { $("#ph", m.el).insertAdjacentHTML("beforeend", phoneRow("")); bindRm(); };
  $("#save", m.el).onclick = async () => {
    const f = formData($("#vf", m.el));
    if (!f.name) return toast("Name is required", true);
    const rec = { ...f, active: f.active === "true", phones: $$(".phone", m.el).map((i) => i.value.trim()).filter(Boolean) };
    if (id) await q(sb.from("boh_vendors").update(rec).eq("id", id)); else await q(sb.from("boh_vendors").insert(rec));
    toast("Vendor saved"); m.close(); reload();
  };
}

// ====================================================================== CATEGORIES
export async function categories(el) {
  const cats = await q(sb.from("boh_categories").select("*, boh_products(count)").order("sort").order("name"));
  el.innerHTML = `
    <div class="page-head"><div><h1>Categories & default margins</h1><div class="muted">The default mark-up pre-fills each new restaurant. Change per restaurant, then per product.</div></div>
      <button class="btn primary" id="add">+ Add category</button></div>
    <div class="table-wrap"><table><thead><tr><th>Category</th><th class="right">Default mark-up %</th><th class="right">Sort</th><th class="right">Products</th><th>Active</th></tr></thead><tbody>
    ${cats.map((c) => `<tr>
      <td><input data-f="name" data-id="${c.id}" value="${esc(c.name)}"></td>
      <td class="right"><input type="number" step="0.01" data-f="default_margin" data-id="${c.id}" value="${c.default_margin}" style="width:110px"></td>
      <td class="right"><input type="number" data-f="sort" data-id="${c.id}" value="${c.sort}" style="width:80px"></td>
      <td class="right">${c.boh_products?.[0]?.count ?? 0}</td>
      <td><input type="checkbox" data-f="active" data-id="${c.id}" ${c.active ? "checked" : ""}></td></tr>`).join("")}
    </tbody></table></div>`;
  $$("[data-f]", el).forEach((i) => (i.onchange = async () => {
    const val = i.type === "checkbox" ? i.checked : i.type === "number" ? Number(i.value) : i.value;
    await q(sb.from("boh_categories").update({ [i.dataset.f]: val }).eq("id", i.dataset.id)); toast("Saved");
  }));
  $("#add").onclick = async () => {
    const name = await promptBox("New category", "Category name");
    if (!name) return;
    await q(sb.from("boh_categories").insert({ name, default_margin: 0, sort: cats.length + 1 })); categories(el);
  };
}

// ====================================================================== PRODUCT REQUESTS
export async function requests(el) {
  const L = await lookups();
  el.innerHTML = `
    <div class="page-head"><div><h1>Product requests</h1><div class="muted">Restaurants request items that aren't on their ordering list. Approve and set the mark-up.</div></div>
      <select id="st" style="max-width:200px"><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="">All</option></select></div>
    <div id="list"></div>`;
  const load = async () => {
    let qq = sb.from("boh_product_requests").select("*, product:boh_products(name,category_id,unit), restaurant:boh_restaurants(name), by:boh_users!boh_product_requests_requested_by_fkey(full_name)").order("created_at", { ascending: false });
    if ($("#st").value) qq = qq.eq("status", $("#st").value);
    const rows = await q(qq);
    $("#list").innerHTML = `<div class="table-wrap"><table><thead><tr><th>When</th><th>Restaurant</th><th>Product</th><th>Note</th><th>Status</th><th class="right">Mark-up</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${fmtDT(r.created_at)}</td><td>${esc(r.restaurant?.name)}<div class="small muted">${esc(r.by?.full_name || "")}</div></td>
        <td>${r.product ? esc(r.product.name) : `<i>New item:</i> ${esc(r.item_name)}`}</td><td class="small">${esc(r.note || "")}</td>
        <td><span class="badge ${r.status === "approved" ? "ok" : r.status === "rejected" ? "danger" : "warn"}">${r.status}</span>${r.admin_note ? `<div class="small muted">${esc(r.admin_note)}</div>` : ""}</td>
        <td class="right">${pct(r.margin_pct)}</td>
        <td class="right">${r.status === "pending" ? `<button class="btn sm primary" data-rev="${r.id}">Review</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="7" class="empty">Nothing here.</td></tr>'}
      </tbody></table></div>`;
    $$("[data-rev]", el).forEach((b) => (b.onclick = () => reviewRequest(rows.find((x) => x.id === b.dataset.rev), L, load)));
  };
  $("#st").onchange = load;
  load();
}

async function reviewRequest(r, L, reload) {
  const prods = await q(sb.from("boh_products").select("id,name,category_id").eq("active", true).order("name"));
  const catMargins = await q(sb.from("boh_restaurant_category_margins").select("*").eq("restaurant_id", r.restaurant_id));
  const suggest = (pid) => {
    const p = prods.find((x) => x.id === pid); if (!p) return "";
    return catMargins.find((c) => c.category_id === p.category_id)?.margin_pct ?? L.cats.find((c) => c.id === p.category_id)?.default_margin ?? 0;
  };
  const m = modal({
    title: `Request from ${r.restaurant?.name}`,
    body: `<p>${r.product ? `Product: <b>${esc(r.product.name)}</b>` : `New item requested: <b>${esc(r.item_name)}</b> — link it to a catalogue product (add it under Products first if needed).`}</p>
      ${r.note ? `<p class="muted">“${esc(r.note)}”</p>` : ""}
      <div class="field"><label>Catalogue product</label><select id="pp">${r.product_id ? "" : '<option value="">— choose —</option>'}${prods.map((p) => `<option value="${p.id}" ${p.id === r.product_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
      <div class="field"><label>Mark-up % for this restaurant</label><input type="number" step="0.01" id="mg" value="${suggest(r.product_id)}"></div>
      <div class="field"><label>Note to restaurant (optional)</label><input id="nt"></div>`,
    footer: `<button class="btn danger" id="rej">Reject</button><button class="btn primary" id="ok">Approve & add to list</button>`,
  });
  $("#pp", m.el).onchange = (e) => ($("#mg", m.el).value = suggest(e.target.value));
  const go = async (approve) => {
    const pid = $("#pp", m.el).value;
    if (approve && !pid) return toast("Choose the catalogue product", true);
    if (pid && pid !== r.product_id) await q(sb.from("boh_product_requests").update({ product_id: pid }).eq("id", r.id));
    await q(sb.rpc("boh_review_request", { p_request: r.id, p_approve: approve, p_margin: $("#mg", m.el).value === "" ? null : Number($("#mg", m.el).value), p_note: $("#nt", m.el).value || null }));
    toast(approve ? "Approved — product added to their ordering list" : "Request rejected"); m.close(); reload(); refreshCounts();
  };
  $("#ok", m.el).onclick = () => go(true);
  $("#rej", m.el).onclick = () => go(false);
}

// ====================================================================== SHOWCASE
export async function showcase(el) {
  const [rows, prods] = await Promise.all([
    q(sb.from("boh_featured").select("*, product:boh_products(name,image_url)").order("created_at", { ascending: false })),
    q(sb.from("boh_products").select("id,name,image_url,description").eq("active", true).order("name")),
  ]);
  el.innerHTML = `
    <div class="page-head"><div><h1>Showcase slideshow</h1><div class="muted">Shown to every restaurant at the top of their home screen, in random order. Clicking opens product details with a “Request product” button.</div></div>
      <button class="btn primary" id="add">+ Add slide</button></div>
    <div class="prod-grid">${rows.map((f) => `<div class="prod">
      <div class="img" style="background-image:url('${esc(f.image_url || f.product?.image_url || "")}')">${f.image_url || f.product?.image_url ? "" : "🖼️"}</div>
      <div class="b"><b>${esc(f.title)}</b><div class="small muted">${esc(f.caption || "")}</div><div class="small">${f.product ? "Product: " + esc(f.product.name) : "No product linked"}</div>
        <div class="row"><label class="row" style="margin:0"><input type="checkbox" data-act="${f.id}" ${f.active ? "checked" : ""}> Live</label><span class="grow"></span><button class="btn sm danger" data-del="${f.id}">Delete</button></div></div></div>`).join("") || '<div class="empty">No slides yet.</div>'}</div>`;
  $$("[data-act]", el).forEach((i) => (i.onchange = async () => { await q(sb.from("boh_featured").update({ active: i.checked }).eq("id", i.dataset.act)); toast("Updated"); }));
  $$("[data-del]", el).forEach((b) => (b.onclick = async () => { if (await confirmBox("Delete this slide?")) { await q(sb.from("boh_featured").delete().eq("id", b.dataset.del)); showcase(el); } }));
  $("#add").onclick = () => {
    const m = modal({
      title: "Add showcase slide",
      body: `<div class="field"><label>Product</label><select id="fp"><option value="">— none —</option>${prods.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></div>
        <div class="field"><label>Headline *</label><input id="ftl"></div>
        <div class="field"><label>Caption</label><input id="fc"></div>
        <div class="field"><label>Banner image (wide images look best; falls back to the product image)</label><input type="file" id="fi" accept="image/*"><div id="fprev"></div></div>`,
      footer: `<button class="btn primary" id="go">Add slide</button>`,
    });
    let url = null;
    $("#fp", m.el).onchange = (e) => { const p = prods.find((x) => x.id === e.target.value); if (p && !$("#ftl", m.el).value) $("#ftl", m.el).value = p.name; if (p && !$("#fc", m.el).value) $("#fc", m.el).value = p.description || ""; };
    $("#fi", m.el).onchange = async (e) => { url = await uploadImage(e.target.files[0], "showcase"); $("#fprev", m.el).innerHTML = `<img src="${esc(url)}" style="max-height:120px;border-radius:8px;margin-top:.4rem">`; };
    $("#go", m.el).onclick = async () => {
      if (!$("#ftl", m.el).value) return toast("Headline is required", true);
      await q(sb.from("boh_featured").insert({ product_id: $("#fp", m.el).value || null, title: $("#ftl", m.el).value, caption: $("#fc", m.el).value || null, image_url: url }));
      toast("Slide added"); m.close(); showcase(el);
    };
  };
}

// ====================================================================== COMPLAINTS (admin + coordinator)
export async function complaints(el) {
  el.innerHTML = `
    <div class="page-head"><div><h1>Complaints</h1></div>
      <select id="st" style="max-width:200px"><option value="open_all">Open & in progress</option><option value="resolved">Resolved</option><option value="">All</option></select></div>
    <div id="list"></div>`;
  const load = async () => {
    let qq = sb.from("boh_complaints").select("*, restaurant:boh_restaurants(name), order:boh_orders(order_no), by:boh_users!boh_complaints_created_by_fkey(full_name)").order("created_at", { ascending: false });
    const s = $("#st").value;
    if (s === "open_all") qq = qq.neq("status", "resolved"); else if (s) qq = qq.eq("status", s);
    const rows = await q(qq);
    $("#list").innerHTML = `<div class="table-wrap"><table><thead><tr><th>When</th><th>Restaurant</th><th>Order</th><th>Type</th><th>Complaint</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((c) => `<tr><td>${fmtDT(c.created_at)}</td><td>${esc(c.restaurant?.name)}<div class="small muted">${esc(c.by?.full_name || "")}</div></td>
        <td>${c.order ? "#" + c.order.order_no : "—"}</td><td>${esc(c.category || "")}</td>
        <td><b>${esc(c.subject)}</b><div class="small">${esc(c.description || "")}</div>${c.resolution ? `<div class="small" style="color:var(--ok)">↳ ${esc(c.resolution)}</div>` : ""}</td>
        <td><span class="badge ${c.status === "resolved" ? "ok" : c.status === "in_progress" ? "info" : "warn"}">${c.status.replace("_", " ")}</span></td>
        <td class="right"><button class="btn sm" data-upd="${c.id}">Update</button></td></tr>`).join("") || '<tr><td colspan="7" class="empty">No complaints 🎉</td></tr>'}
      </tbody></table></div>`;
    $$("[data-upd]", el).forEach((b) => (b.onclick = () => {
      const c = rows.find((x) => x.id === b.dataset.upd);
      const m = modal({
        title: c.subject,
        body: `<p>${esc(c.description || "")}</p>
          <div class="field"><label>Status</label><select id="cs">${["open", "in_progress", "resolved"].map((s) => `<option value="${s}" ${s === c.status ? "selected" : ""}>${s.replace("_", " ")}</option>`).join("")}</select></div>
          <div class="field"><label>Resolution / response (visible to restaurant)</label><textarea id="cr" rows="3">${esc(c.resolution || "")}</textarea></div>`,
        footer: `<button class="btn primary" id="go">Save</button>`,
      });
      $("#go", m.el).onclick = async () => {
        const status = $("#cs", m.el).value;
        await q(sb.from("boh_complaints").update({ status, resolution: $("#cr", m.el).value || null, resolved_at: status === "resolved" ? new Date().toISOString() : null }).eq("id", c.id));
        toast("Complaint updated"); m.close(); load(); refreshCounts();
      };
    }));
  };
  $("#st").onchange = load;
  load();
}

// ====================================================================== TEAM
export async function team(el) {
  const [users, rests] = await Promise.all([
    q(sb.from("boh_users").select("*, restaurant:boh_restaurants!boh_users_restaurant_id_fkey(name)").order("role").order("full_name")),
    q(sb.from("boh_restaurants").select("id,name,coordinator_id").order("name")),
  ]);
  const assigned = {};
  rests.forEach((r) => r.coordinator_id && (assigned[r.coordinator_id] = (assigned[r.coordinator_id] || 0) + 1));
  const roles = isSuper() ? ["admin", "coordinator", "customer", "super_admin"] : ["coordinator", "customer"];
  el.innerHTML = `
    <div class="page-head"><div><h1>Team & logins</h1><div class="muted">Super admin → admins → coordinators. Restaurant logins are also listed here.</div></div>
      <button class="btn primary" id="add">+ Add user</button></div>
    <div class="row" style="margin-bottom:.75rem"><select id="rf" style="max-width:200px"><option value="">All roles</option>${["super_admin", "admin", "coordinator", "customer"].map((r) => `<option>${r}</option>`).join("")}</select></div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Phone</th><th>Restaurant / load</th><th>Status</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr data-role="${u.role}"><td><b>${esc(u.full_name)}</b></td><td><span class="badge info">${u.role.replace("_", " ")}</span></td><td>${esc(u.email)}</td><td>${esc(u.phone || "")}</td>
      <td>${u.role === "customer" ? esc(u.restaurant?.name || "—") : `${assigned[u.id] || 0} restaurants`}</td>
      <td>${u.active ? '<span class="badge ok">Active</span>' : '<span class="badge">Inactive</span>'}</td>
      <td class="right">${u.id !== state.me.id && (isSuper() || ["coordinator", "customer"].includes(u.role)) ? `<button class="btn sm" data-ed="${u.id}">Edit</button> <button class="btn sm" data-tog="${u.id}" data-on="${u.active}">${u.active ? "Deactivate" : "Activate"}</button> <button class="btn sm" data-pw="${u.id}">Password</button>` : ""}</td></tr>`).join("")}
    </tbody></table></div>`;
  $("#rf").onchange = (e) => $$("tr[data-role]", el).forEach((tr) => tr.classList.toggle("hidden", !!e.target.value && tr.dataset.role !== e.target.value));
  bindUserActions(el, () => team(el));
  const editor = (u) => {
    const m = modal({
      title: u ? `Edit ${u.full_name}` : "Add user",
      body: `<div class="form-grid" id="uf">
        <div class="field"><label>Full name *</label><input name="full_name" value="${esc(u?.full_name || "")}"></div>
        <div class="field"><label>Phone</label><input name="phone" value="${esc(u?.phone || "")}"></div>
        ${u ? "" : `<div class="field"><label>Email *</label><input name="email" type="email"></div><div class="field"><label>Password * (min 8)</label><input name="password"></div>`}
        <div class="field"><label>Role</label><select name="role" ${u ? "disabled" : ""}>${roles.map((r) => `<option value="${r}" ${r === u?.role ? "selected" : ""}>${r.replace("_", " ")}</option>`).join("")}</select></div>
        <div class="field" id="rsel"><label>Restaurant (for restaurant logins)</label><select name="restaurant_id"><option value="">—</option>${rests.map((r) => `<option value="${r.id}" ${r.id === u?.restaurant_id ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></div>
      </div>`,
      footer: `<button class="btn primary" id="go">${u ? "Save" : "Create user"}</button>`,
    });
    $("#go", m.el).onclick = async () => {
      const f = formData($("#uf", m.el));
      if (!f.full_name) return toast("Name is required", true);
      try {
        if (u) {
          await q(sb.from("boh_users").update({ full_name: f.full_name, phone: f.phone, restaurant_id: u.role === "customer" ? f.restaurant_id : null }).eq("id", u.id));
        } else {
          await callUsersFn({ action: "create_user", ...f });
        }
        toast("Saved"); m.close(); team(el);
      } catch (e) { toast(e.message, true); }
    };
  };
  $("#add").onclick = () => editor(null);
  $$("[data-ed]", el).forEach((b) => (b.onclick = () => editor(users.find((x) => x.id === b.dataset.ed))));
}

// ====================================================================== SETTINGS
export async function settings(el) {
  const s = state.settings;
  el.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><div class="muted">Working hours drive every SLA timer. Only the super admin can change these.</div></div></div>
    <div class="card" id="sf">
      <div class="form-grid">
        <div class="field"><label>Company name</label><input name="company_name" value="${esc(s.company_name)}"></div>
        <div class="field"><label>Support phone (shown to restaurants)</label><input name="support_phone" value="${esc(s.support_phone || "")}"></div>
        <div class="field"><label>Order cut-off for next-day delivery</label><input name="order_cutoff" type="time" value="${s.order_cutoff.slice(0, 5)}"></div>
        <div class="field"><label>Working day starts</label><input name="work_start" type="time" value="${s.work_start.slice(0, 5)}"></div>
        <div class="field"><label>Working day ends</label><input name="work_end" type="time" value="${s.work_end.slice(0, 5)}"></div>
      </div>
      <div class="field"><label>Working days</label><div class="row">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => `<label class="row" style="margin:0;font-weight:400"><input type="checkbox" data-day="${i + 1}" ${s.work_days.includes(i + 1) ? "checked" : ""}> ${d}</label>`).join("")}</div></div>
      <h3>SLA (working hours)</h3>
      <div class="form-grid">
        <div class="field"><label>Admin allocates order within</label><input type="number" step="0.5" name="sla_allocate_hrs" value="${s.sla_allocate_hrs}"></div>
        <div class="field"><label>Coordinator acknowledges within</label><input type="number" step="0.5" name="sla_ack_hrs" value="${s.sla_ack_hrs}"></div>
        <div class="field"><label>Order placed with vendor within</label><input type="number" step="0.5" name="sla_vendor_order_hrs" value="${s.sla_vendor_order_hrs}"></div>
        <div class="field"><label>1st follow-up within</label><input type="number" step="0.5" name="sla_followup1_hrs" value="${s.sla_followup1_hrs}"></div>
        <div class="field"><label>2nd follow-up within</label><input type="number" step="0.5" name="sla_followup2_hrs" value="${s.sla_followup2_hrs}"></div>
        <div class="field"><label>Payment completed within (working hrs after delivery)</label><input type="number" step="0.5" name="sla_payment_hrs" value="${s.sla_payment_hrs}"></div>
      </div>
      <button class="btn primary" id="save">Save settings</button>
    </div>`;
  $("#save").onclick = async () => {
    const f = formData($("#sf"));
    f.work_days = $$("[data-day]:checked", el).map((i) => Number(i.dataset.day));
    f.updated_at = new Date().toISOString();
    const row = await q(sb.from("boh_settings").update(f).eq("id", 1).select().single());
    state.settings = row; toast("Settings saved");
  };
}
