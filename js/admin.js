import {
  sb, state, $, $$, esc, money, num, pct, fmtDT, fmtD, toast, modal, confirmBox, formData, q, callUsersFn,
  uploadImage, tabs, statusBadge, dueBadge, dueText, stepsHTML, allocSteps, orderSteps, telLinks, DELIVERY_LABEL, NEXT_STEP, STEP_BUTTON,
  OVERHEAD_KINDS, payBadge, PAY_MODE, todayIST, daysAgoIST, downloadCSV, promptBox,
} from "./lib.js?v=11";

const isSuper = () => state.me.role === "super_admin";
const isStaff = () => ["admin", "super_admin"].includes(state.me.role);
const refreshCounts = () => window.bohRefreshCounts?.();
const genPassword = () => "Boh@" + Math.random().toString(36).slice(2, 8) + Math.floor(10 + Math.random() * 89);

async function lookups() {
  const [cats, rests, team] = await Promise.all([
    q(sb.from("boh_categories").select("*").order("sort").order("name")),
    q(sb.from("boh_restaurants").select("id,name,active").order("name")),
    q(sb.from("boh_users").select("id,full_name,phone,role,active").in("role", ["coordinator", "admin", "super_admin"]).order("full_name")),
  ]);
  return { cats, rests, team, restMap: Object.fromEntries(rests.map((r) => [r.id, r])), teamMap: Object.fromEntries(team.map((t) => [t.id, t])) };
}

// passwords are only readable by the super admin (RLS); everyone else gets an empty map
async function secrets() {
  if (!isSuper()) return {};
  const rows = await q(sb.from("boh_user_secrets").select("user_id,password"));
  return Object.fromEntries(rows.map((r) => [r.user_id, r.password]));
}
const pwCell = (pw) => pw == null ? '<span class="muted small">not stored</span>'
  : `<span class="pwbox"><code data-pw="${esc(pw)}">••••••••</code> <button class="btn sm" data-reveal title="Show / hide">👁</button></span>`;
function bindReveal(root) {
  $$("[data-reveal]", root).forEach((b) => (b.onclick = () => {
    const c = b.previousElementSibling;
    c.textContent = c.textContent.startsWith("•") ? c.dataset.pw : "••••••••";
  }));
}

const ORDER_SELECT = "*, allocs:boh_order_allocations(*)";

// fixed price rules: never below the cheapest active vendor; confirm when profit is under 10%
async function okFixedPrice(price, cost) {
  if (price == null) return true;
  if (!(price > 0)) { toast("Fixed price must be more than 0", true); return false; }
  if (cost == null) return true;
  if (price < cost) { toast(`₹${price} is below the lowest active vendor rate ₹${cost}. Fixed price not saved.`, true); return false; }
  const margin = ((price / cost - 1) * 100);
  if (margin < 10) return confirmBox(`Margin might be low: ₹${price} is only ${margin.toFixed(2)}% above the lowest vendor rate ₹${cost} (under 10%). Set this fixed price anyway?`);
  return true;
}

// ====================================================================== DASHBOARD
export async function dashboard(el) {
  const monthStart = todayIST().slice(0, 8) + "01";
  const [orders, reqs, comps, ohs, L] = await Promise.all([
    q(sb.from("boh_orders").select(ORDER_SELECT).gte("created_at", daysAgoIST(45) + "T00:00:00+05:30").order("created_at", { ascending: false })),
    q(sb.from("boh_product_requests").select("id").eq("status", "pending")),
    q(sb.from("boh_complaints").select("id").neq("status", "resolved")),
    q(sb.from("boh_order_overheads").select("amount, kind, ord:boh_orders!inner(created_at,status)").gte("ord.created_at", monthStart + "T00:00:00+05:30").neq("ord.status", "cancelled")),
    lookups(),
  ]);
  const today = todayIST();
  const isToday = (d) => new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 10) === today;
  const live = orders.filter((o) => o.status !== "cancelled");
  const month = live.filter((o) => o.created_at >= monthStart);
  const sales = month.reduce((a, o) => a + Number(o.total), 0);
  const cost = month.reduce((a, o) => a + Number(o.cost_total), 0);
  const oh = ohs.reduce((a, x) => a + Number(x.amount), 0);
  const porter = ohs.filter((x) => x.kind === "Porter").reduce((a, x) => a + Number(x.amount), 0);
  const overdue = live.filter((o) => dueBadge(o).includes("Overdue"));
  el.innerHTML = `
    <div class="page-head"><div><h1>Dashboard</h1><div class="muted">Good to see you, ${esc(state.me.full_name.split(" ")[0])}.</div></div>
      <a class="btn primary" href="#/orders">Go to orders</a></div>
    <div class="grid k4">
      <div class="card stat"><div class="l">Orders today</div><div class="v">${live.filter((o) => isToday(o.created_at)).length}</div></div>
      <div class="card stat"><div class="l">Awaiting allocation</div><div class="v">${live.filter((o) => o.status === "placed").length}</div></div>
      <div class="card stat"><div class="l">Overdue</div><div class="v" style="color:var(--danger)">${overdue.length}</div></div>
      <div class="card stat"><div class="l">Payments to verify</div><div class="v" style="color:var(--warn)">${live.filter((o) => o.payment_status === "under_review").length}</div><div class="small muted"><a href="#/orders">Orders → Payment: Under approval</a></div></div>
      <div class="card stat"><div class="l">Unpaid (delivered / pre-pay)</div><div class="v">${money(live.filter((o) => o.payment_status !== "paid" && (o.payment_mode === "prepaid" || o.status === "delivered")).reduce((a, o) => a + Number(o.total), 0))}</div></div>
      <div class="card stat"><div class="l">Sales this month</div><div class="v">${money(sales)}</div></div>
      <div class="card stat"><div class="l">Gross margin this month</div><div class="v">${money(sales - cost)}</div><div class="small muted">${sales ? pct(((sales - cost) / sales) * 100) : ""}</div></div>
      <div class="card stat"><div class="l">Overheads this month</div><div class="v">${money(oh)}</div><div class="small muted">Porter ${money(porter)}</div></div>
      <div class="card stat"><div class="l">Net margin this month</div><div class="v">${money(sales - cost - oh)}</div><div class="small muted">${sales ? pct(((sales - cost - oh) / sales) * 100) : ""}</div></div>
      <div class="card stat"><div class="l">Pending product requests</div><div class="v">${reqs.length}</div></div>
      <div class="card stat"><div class="l">Open complaints</div><div class="v">${comps.length}</div></div>
    </div>
    <div class="card" style="margin-top:1rem"><h2>Needs attention</h2>
      ${orderTable([...live.filter((o) => o.payment_status === "under_review"), ...overdue, ...live.filter((o) => o.status === "placed" && !overdue.includes(o))].filter((o, i, a) => a.indexOf(o) === i).slice(0, 20), L)}</div>`;
  bindOrderTable(el, L, () => dashboard(el));
}

// ====================================================================== ORDERS
function coordNames(o, L) {
  const names = [...new Set((o.allocs || []).map((a) => L.teamMap[a.coordinator_id]?.full_name || "—"))];
  return names.length ? esc(names.join(", ")) : '<span class="muted">Unassigned</span>';
}

function orderTable(rows, L) {
  if (!rows.length) return `<div class="empty">No orders here.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>#</th><th>Restaurant</th><th>Placed</th><th>Delivery</th><th class="right">Total</th><th>Status</th><th>Payment</th><th>Coordinators</th><th>SLA</th><th></th></tr></thead><tbody>
    ${rows.map((o) => `<tr>
      <td><b>${o.order_no}</b></td>
      <td>${esc(L.restMap[o.restaurant_id]?.name || "—")}</td>
      <td>${fmtDT(o.created_at)}</td>
      <td>${fmtD(o.delivery_date)}</td>
      <td class="right">${money(o.total)}</td>
      <td>${statusBadge(o.status)}</td>
      <td>${payBadge(o)}<div class="small muted">${PAY_MODE[o.payment_mode] || ""}</div></td>
      <td>${coordNames(o, L)}</td>
      <td>${dueBadge(o)}</td>
      <td class="right" style="white-space:nowrap">
        ${isStaff() && !["delivered", "paid", "cancelled"].includes(o.status) ? `<button class="btn sm" data-alloc="${o.id}">${o.status === "placed" ? "Allocate" : "Reassign"}</button>` : ""}
        <button class="btn sm" data-view="${o.id}">Open</button></td>
    </tr>`).join("")}</tbody></table></div>`;
}

function bindOrderTable(el, L, reload) {
  $$("[data-alloc]", el).forEach((b) => (b.onclick = () => allocateModal(b.dataset.alloc, L, reload)));
  $$("[data-view]", el).forEach((b) => (b.onclick = () => orderModal(b.dataset.view, reload)));
}

// category-wise allocation: one pick at the top fills every category, each can be changed
async function allocateModal(orderId, L, reload) {
  const [o, items] = await Promise.all([
    q(sb.from("boh_orders").select(ORDER_SELECT).eq("id", orderId).single()),
    q(sb.from("boh_order_items").select("category_id, category_name, line_total").eq("order_id", orderId)),
  ]);
  const cats = {};
  items.forEach((i) => { const c = (cats[i.category_id] ||= { id: i.category_id, name: i.category_name, n: 0, amt: 0 }); c.n++; c.amt += Number(i.line_total); });
  const existing = Object.fromEntries((o.allocs || []).map((a) => [a.category_id, a]));
  const people = L.team.filter((t) => t.active);
  const opts = (sel) => `<option value="">— choose —</option>` + people.map((t) => `<option value="${t.id}" ${t.id === sel ? "selected" : ""}>${esc(t.full_name)} (${t.role.replace("_", " ")})${t.phone ? " · " + esc(t.phone) : ""}</option>`).join("");
  const m = modal({
    title: `Allocate order #${o.order_no}`,
    body: `<p class="muted">${esc(L.restMap[o.restaurant_id]?.name)} · placed ${fmtDT(o.created_at)} · ${dueBadge(o)}</p>
      <div class="field"><label>Coordinator for all categories</label><select id="all">${opts("")}</select>
        <div class="small muted">Picking someone here fills every category below. You can then change any single category.</div></div>
      <table><thead><tr><th>Category</th><th class="right">Items</th><th class="right">Value</th><th>Coordinator</th><th></th></tr></thead><tbody>
      ${Object.values(cats).map((c) => `<tr><td><b>${esc(c.name)}</b></td><td class="right">${c.n}</td><td class="right">${money(c.amt)}</td>
        <td><select data-cat="${c.id}">${opts(existing[c.id]?.coordinator_id)}</select></td>
        <td class="small">${existing[c.id] ? statusBadge(existing[c.id].status) : ""}</td></tr>`).join("")}
      </tbody></table>`,
    footer: `<button class="btn primary" id="go">Save allocation</button>`,
  });
  $("#all", m.el).onchange = (e) => { if (e.target.value) $$("[data-cat]", m.el).forEach((s) => (s.value = e.target.value)); };
  $("#go", m.el).onclick = async () => {
    const map = $$("[data-cat]", m.el).filter((s) => s.value).map((s) => ({ category_id: s.dataset.cat, coordinator_id: s.value }));
    if (!map.length) return toast("Choose at least one coordinator", true);
    await q(sb.rpc("boh_allocate_order", { p_order: orderId, p_map: map }));
    const left = Object.keys(cats).length - map.length;
    toast(left ? `Saved — ${left} categor${left > 1 ? "ies" : "y"} still unallocated` : "Order allocated");
    m.close(); refreshCounts(); reload?.();
  };
}

// payment: approve / reject a restaurant's "already paid", or record a collection directly
export async function paymentAction(o, action, done) {
  if (action === "approve") {
    if (!(await confirmBox(`Approve payment for order #${o.order_no} (${money(o.total)})? Reference given: ${o.payment_claim_ref || "—"}`))) return;
    await q(sb.rpc("boh_mark_paid", { p_order: o.id, p_ref: o.payment_claim_ref }));
    toast("Payment approved");
  } else if (action === "reject") {
    const note = await promptBox("Reject payment", "Reason (shown to the restaurant), e.g. amount not received / wrong UTR");
    if (!note) return;
    await q(sb.rpc("boh_reject_payment", { p_order: o.id, p_note: note }));
    toast("Payment rejected — restaurant will see it as Not paid");
  } else {
    const ref = await promptBox("Payment collected", "Payment reference (UPI / cheque / cash)");
    if (ref === null) return;
    await q(sb.rpc("boh_mark_paid", { p_order: o.id, p_ref: ref || "Collected" }));
    toast("Payment recorded");
  }
  refreshCounts(); done?.();
}
export function paymentButtons(o) {
  if (o.status === "cancelled" || o.payment_status === "paid") return "";
  if (o.payment_status === "under_review")
    return `<button class="btn sm danger" data-payact="reject" data-oid="${o.id}">Reject</button> <button class="btn sm primary" data-payact="approve" data-oid="${o.id}">Approve payment</button>`;
  return `<button class="btn sm" data-payact="collect" data-oid="${o.id}">Mark payment collected</button>`;
}
export function bindPaymentButtons(root, list, done) {
  $$("[data-payact]", root).forEach((b) => (b.onclick = () => paymentAction(list.find((o) => o.id === b.dataset.oid), b.dataset.payact, done)));
}

// move one category forward; delivery asks for overhead charges
export async function advanceAlloc(alloc, step, done) {
  let note = null, overheads = [];
  if (["followup1", "followup2"].includes(step)) {
    note = await promptBox(`${alloc.category_name} — follow-up note`, "What did the vendor say?");
    if (note === null) return;
  }
  if (step === "delivered") {
    overheads = await overheadForm(`${alloc.category_name} delivered — overheads`, true);
    if (overheads === null) return;
  }
  await q(sb.rpc("boh_advance_allocation", { p_alloc: alloc.id, p_step: step, p_note: note, p_overheads: overheads }));
  toast(step === "delivered" ? "Marked delivered" : "Updated");
  refreshCounts(); done?.();
}

// returns [{kind, amount, note}] or null if cancelled
function overheadForm(title, forDelivery) {
  return new Promise((res) => {
    const row = () => `<div class="row oh" style="margin-bottom:.4rem">
      <select style="flex:2">${OVERHEAD_KINDS.map((k) => `<option>${k}</option>`).join("")}</select>
      <input type="number" step="0.01" min="0" placeholder="₹ amount" style="flex:1">
      <input placeholder="Note (optional)" style="flex:2"><button class="btn sm" data-rm type="button">×</button></div>`;
    const m = modal({
      title,
      body: `<p class="muted">${forDelivery ? "Enter any extra costs for this delivery — porter, delivery charge, anything paid. Leave blank if none." : "Add an extra cost for this order."}</p>
        <div id="ohs">${row()}</div><button class="btn sm" id="more" type="button">+ Add another charge</button>`,
      footer: `<button class="btn" id="cancel">Cancel</button><button class="btn primary" id="ok">${forDelivery ? "Confirm delivered" : "Add"}</button>`,
    });
    const bind = () => $$("[data-rm]", m.el).forEach((b) => (b.onclick = () => b.parentElement.remove()));
    bind();
    $("#more", m.el).onclick = () => { $("#ohs", m.el).insertAdjacentHTML("beforeend", row()); bind(); };
    $("#cancel", m.el).onclick = () => { m.close(); res(null); };
    $("#ok", m.el).onclick = () => {
      const list = $$(".oh", m.el).map((r) => { const [k, a, n] = $$("select,input", r); return { kind: k.value, amount: Number(a.value) || 0, note: n.value.trim() }; }).filter((x) => x.amount > 0);
      if (!forDelivery && !list.length) return toast("Enter an amount", true);
      m.close(); res(list);
    };
    m.el.querySelector(".x").onclick = () => { m.close(); res(null); };
  });
}

export async function orderModal(orderId, reload) {
  const [o, items, events, ohs] = await Promise.all([
    q(sb.from("boh_orders").select("*, allocs:boh_order_allocations(*, coordinator:boh_users!boh_order_allocations_coordinator_id_fkey(full_name,phone)), restaurant:boh_restaurants(name,phone,address)").eq("id", orderId).single()),
    q(sb.from("boh_order_items").select("*, vendor:boh_vendors(name,phones,delivery_style)").eq("order_id", orderId).order("vendor_name").order("product_name")),
    q(sb.from("boh_order_events").select("*, actor:boh_users(full_name)").eq("order_id", orderId).order("created_at")),
    q(sb.from("boh_order_overheads").select("*, by:boh_users(full_name)").eq("order_id", orderId).order("created_at")),
  ]);
  const staff = isStaff();
  const onOrder = (o.allocs || []).some((a) => a.coordinator_id === state.me.id);
  const allocByCat = Object.fromEntries((o.allocs || []).map((a) => [a.category_id, a]));
  const cats = {};
  items.forEach((i) => (cats[i.category_id] ||= { name: i.category_name, items: [] }).items.push(i));
  const ohTotal = ohs.reduce((a, x) => a + Number(x.amount), 0);

  const catSection = (cid, c) => {
    const a = allocByCat[cid];
    const mine = a && (staff || a.coordinator_id === state.me.id);
    const next = a && NEXT_STEP[a.status];
    const byVendor = {};
    c.items.forEach((i) => (byVendor[i.vendor_id || "x"] ||= { v: i.vendor, name: i.vendor_name, style: i.delivery_style, lines: [] }).lines.push(i));
    return `<div class="card" style="padding:.8rem">
      <div class="row between"><h3 style="margin:0">${esc(c.name)}</h3>
        <div class="row">${a ? `${statusBadge(a.status)} <span class="small">👤 ${esc(a.coordinator?.full_name || "")} ${a.coordinator?.phone ? "· " + telLinks([a.coordinator.phone]) : ""}</span>` : '<span class="badge warn">Not allocated</span>'}</div></div>
      ${Object.values(byVendor).map((g) => `
        <div style="margin-top:.6rem"><div class="row between small"><b>${esc(g.name || "No vendor")}</b><span>${esc(DELIVERY_LABEL[g.style] || "")} · 📞 ${telLinks(g.v?.phones)}</span></div>
        <table><thead><tr><th>Item</th><th class="right">Qty</th>${staff ? '<th class="right">Cost</th><th class="right">Margin</th>' : ""}<th class="right">Price</th><th class="right">Total</th></tr></thead><tbody>
        ${g.lines.map((i) => `<tr><td>${esc(i.product_name)}</td><td class="right">${num(i.qty, 3)} ${esc(i.unit || "")}</td>
          ${staff ? `<td class="right">${money(i.unit_cost)}</td><td class="right">${pct(i.margin_pct)}</td>` : ""}
          <td class="right">${money(i.unit_price)}</td><td class="right">${money(i.line_total)}</td></tr>`).join("")}</tbody></table></div>`).join("")}
      ${a ? `<details style="margin-top:.6rem"><summary class="small">Timeline</summary>${stepsHTML(allocSteps(o, a))}
        ${a.followup1_note ? `<p class="small"><b>1st follow-up:</b> ${esc(a.followup1_note)}</p>` : ""}${a.followup2_note ? `<p class="small"><b>2nd follow-up:</b> ${esc(a.followup2_note)}</p>` : ""}</details>` : ""}
      ${mine && o.status !== "cancelled" ? `<div class="row" style="justify-content:flex-end;margin-top:.5rem">
        ${["vendor_ordered", "followup1"].includes(a.status) ? `<button class="btn sm" data-adv="${a.id}" data-step="delivered">Mark delivered</button>` : ""}
        ${next ? `<button class="btn sm primary" data-adv="${a.id}" data-step="${next}">${STEP_BUTTON[next]}</button>` : ""}</div>` : ""}
    </div>`;
  };

  const m = modal({
    wide: true,
    title: `Order #${o.order_no} — ${o.restaurant?.name || ""}`,
    body: `
      <div class="row" style="margin-bottom:1rem">${statusBadge(o.status)} ${dueBadge(o)}
        <span class="muted">Placed ${fmtDT(o.created_at)} · Delivery ${fmtD(o.delivery_date)} · ${esc(o.restaurant?.phone || "")} · ${esc(o.restaurant?.address || "")}</span></div>
      ${o.notes ? `<div class="notice">Restaurant note: ${esc(o.notes)}</div>` : ""}
      <div class="grid c2" style="align-items:start">
        <div>${Object.entries(cats).map(([cid, c]) => catSection(cid, c)).join("")}
          <div class="row between" style="margin-top:.75rem"><b>Order total</b><b>${money(o.total)}</b></div>
          ${staff ? `<div class="row between small muted"><span>Cost ${money(o.cost_total)} · Overheads ${money(ohTotal)}</span><span>Net margin ${money(o.total - o.cost_total - ohTotal)}</span></div>` : ""}
        </div>
        <div>
          <h3>Payment</h3>
          <div class="card" style="padding:.7rem">
            <div class="row between"><span>${PAY_MODE[o.payment_mode] || ""}</span>${payBadge(o)}</div>
            ${o.payment_claim_ref && o.payment_status !== "paid" ? `<div class="small" style="margin-top:.3rem">Restaurant says paid · ref <b>${esc(o.payment_claim_ref)}</b> · ${fmtDT(o.payment_claimed_at)}</div>` : ""}
            ${o.payment_rejected_note && o.payment_status === "unpaid" ? `<div class="small" style="color:var(--danger);margin-top:.3rem">Rejected ${fmtDT(o.payment_rejected_at)}: ${esc(o.payment_rejected_note)}</div>` : ""}
            ${o.payment_status === "paid" ? `<div class="small" style="margin-top:.3rem">Confirmed ${fmtDT(o.paid_at)}${o.payment_ref ? " · ref " + esc(o.payment_ref) : ""}</div>` : ""}
            ${staff || onOrder ? `<div class="row" style="justify-content:flex-end;margin-top:.5rem">${paymentButtons(o)}</div>` : ""}
          </div>
          <h3 style="margin-top:1rem">Order status</h3>${stepsHTML(orderSteps(o))}
          <h3 style="margin-top:1rem">Overheads ${ohTotal ? "· " + money(ohTotal) : ""}</h3>
          ${ohs.length ? `<table><tbody>${ohs.map((x) => `<tr><td>${esc(x.kind)}</td><td class="small muted">${esc(x.note || "")} · ${esc(x.by?.full_name || "")}</td><td class="right">${money(x.amount)}</td></tr>`).join("")}</tbody></table>` : '<div class="small muted">None recorded.</div>'}
          ${(staff || onOrder) && o.status !== "cancelled" ? `<button class="btn sm" id="addoh" style="margin-top:.4rem">+ Add overhead</button>` : ""}
          <h3 style="margin-top:1rem">Activity</h3>
          <div class="small">${events.map((e) => `<div>${fmtDT(e.created_at)} — <b>${esc(e.event)}</b> ${e.note ? "· " + esc(e.note) : ""} <span class="muted">${esc(e.actor?.full_name || "")}</span></div>`).join("")}</div>
        </div>
      </div>`,
    footer: `${staff && !["paid", "cancelled"].includes(o.status) ? `<button class="btn danger" id="cancel">Cancel order</button>` : ""}
      <span class="grow"></span>
      ${staff && !["delivered", "paid", "cancelled"].includes(o.status) ? `<button class="btn" id="realloc">${o.status === "placed" ? "Allocate" : "Reassign"}</button>` : ""}
`,
  });
  const reopen = () => { m.close(); reload?.(); orderModal(orderId, reload); };
  $$("[data-adv]", m.el).forEach((b) => (b.onclick = () => advanceAlloc(o.allocs.find((a) => a.id === b.dataset.adv), b.dataset.step, reopen)));
  $("#addoh", m.el)?.addEventListener("click", async () => {
    const list = await overheadForm(`Add overhead — order #${o.order_no}`, false);
    if (!list) return;
    for (const x of list) await q(sb.rpc("boh_add_overhead", { p_order: orderId, p_kind: x.kind, p_amount: x.amount, p_note: x.note || null }));
    toast("Overhead added"); reopen();
  });
  bindPaymentButtons(m.el, [o], reopen);
  $("#realloc", m.el)?.addEventListener("click", async () => { m.close(); allocateModal(orderId, await lookups(), reload); });
  $("#cancel", m.el)?.addEventListener("click", async () => {
    if (!(await confirmBox(`Cancel order #${o.order_no}?`))) return;
    await q(sb.rpc("boh_cancel_order", { p_order: orderId }));
    toast("Order cancelled"); m.close(); reload?.(); refreshCounts();
  });
}

export async function orders(el) {
  const L = await lookups();
  const mine = await q(sb.from("boh_restaurant_admins").select("restaurant_id").eq("user_id", state.me.id));
  const mySet = new Set(mine.map((x) => x.restaurant_id));
  el.innerHTML = `
    <div class="page-head"><div><h1>Orders & allocation</h1><div class="muted">Allocate every category of an order to a coordinator within ${state.settings.sla_allocate_hrs} working hours.</div></div></div>
    <div class="card"><div class="row">
      <div><label>Status</label><select id="fs"><option value="open">Open (not paid)</option><option value="placed">Awaiting allocation</option><option value="">All</option>
        ${["allocated", "acknowledged", "vendor_ordered", "followup1", "followup2", "delivered", "paid", "cancelled"].map((s) => `<option value="${s}">${s}</option>`).join("")}</select></div>
      <div><label>Payment</label><select id="fp"><option value="">All</option><option value="under_review">Under approval (to verify)</option><option value="unpaid">Unpaid</option><option value="paid">Paid</option></select></div>
      <div><label>Restaurant</label><select id="fr"><option value="">All</option>${mySet.size ? `<option value="__mine">My restaurants (${mySet.size})</option>` : ""}${L.rests.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("")}</select></div>
      <div><label>Coordinator</label><select id="fc"><option value="">All</option>${L.team.map((t) => `<option value="${t.id}">${esc(t.full_name)}</option>`).join("")}</select></div>
      <div><label>From</label><input type="date" id="ff" value="${daysAgoIST(30)}"></div>
      <div><label>To</label><input type="date" id="ft" value="${todayIST()}"></div>
    </div></div>
    <div id="list" style="margin-top:1rem"></div>`;
  const load = async () => {
    let qq = sb.from("boh_orders").select(ORDER_SELECT).order("created_at", { ascending: false })
      .gte("created_at", $("#ff").value + "T00:00:00+05:30").lte("created_at", $("#ft").value + "T23:59:59+05:30");
    const s = $("#fs").value;
    if (s === "open") qq = qq.not("status", "in", "(paid,cancelled)"); else if (s) qq = qq.eq("status", s);
    if ($("#fp").value) qq = qq.eq("payment_status", $("#fp").value);
    const r = $("#fr").value;
    if (r === "__mine") qq = qq.in("restaurant_id", [...mySet]); else if (r) qq = qq.eq("restaurant_id", r);
    let rows = await q(qq);
    if ($("#fc").value) rows = rows.filter((o) => (o.allocs || []).some((a) => a.coordinator_id === $("#fc").value));
    $("#list").innerHTML = orderTable(rows, L);
    bindOrderTable($("#list"), L, load);
  };
  $$("select, input", el).forEach((i) => (i.onchange = load));
  load();
}

// ====================================================================== RESTAURANTS
export async function restaurants(el) {
  const [rows, admins, logins, cats] = await Promise.all([
    q(sb.from("boh_restaurants").select("*, boh_restaurant_products(count)").order("name")),
    q(sb.from("boh_restaurant_admins").select("restaurant_id, user:boh_users(full_name)")),
    q(sb.from("boh_users").select("restaurant_id").eq("role", "customer")),
    q(sb.from("boh_restaurant_category_margins").select("restaurant_id").eq("active", true)),
  ]);
  const count = (arr, id) => arr.filter((x) => x.restaurant_id === id).length;
  el.innerHTML = `
    <div class="page-head"><div><h1>Restaurants</h1><div class="muted">Create a restaurant with its login, switch on its categories, then allocate its ordering list.</div></div>
      <button class="btn primary" id="add">+ Add restaurant</button></div>
    <div class="row" style="margin-bottom:.75rem"><input id="s" placeholder="Search restaurants…" style="max-width:320px"></div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Contact</th><th>Our admins</th><th class="right">Categories on</th><th class="right">Items on list</th><th class="right">Logins</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr data-name="${esc(r.name.toLowerCase())}">
      <td><b>${esc(r.name)}</b><div class="small muted">${esc(r.address || "")}</div></td><td>${esc(r.outlet_type || "")}</td>
      <td>${esc(r.contact_name || "")}<div class="small">${esc(r.phone || "")}</div></td>
      <td class="small">${esc(admins.filter((a) => a.restaurant_id === r.id).map((a) => a.user?.full_name).join(", ") || "—")}</td>
      <td class="right">${count(cats, r.id)}</td>
      <td class="right">${r.boh_restaurant_products?.[0]?.count ?? 0}</td>
      <td class="right">${count(logins, r.id)}</td>
      <td>${r.active ? '<span class="badge ok">Active</span>' : '<span class="badge">Inactive</span>'}</td>
      <td class="right"><button class="btn sm primary" data-edit="${r.id}">✎ Edit</button></td></tr>`).join("") || `<tr><td colspan="9" class="empty">No restaurants yet.</td></tr>`}</tbody></table></div>`;
  $("#s").oninput = (e) => $$("tbody tr[data-name]", el).forEach((tr) => tr.classList.toggle("hidden", !tr.dataset.name.includes(e.target.value.toLowerCase())));
  const L = await lookups();
  $("#add").onclick = () => restaurantEditor(null, L, () => restaurants(el));
  $$("[data-edit]", el).forEach((b) => (b.onclick = () => restaurantEditor(b.dataset.edit, L, () => restaurants(el))));
}

async function restaurantEditor(id, L, reload, startTab = 0) {
  let r = { active: true, outlet_type: "Restaurant" };
  let margins = {}, admins = [];
  const staffList = L.team.filter((t) => ["admin", "super_admin"].includes(t.role) && t.active);
  if (id) {
    [r, admins] = await Promise.all([
      q(sb.from("boh_restaurants").select("*").eq("id", id).single()),
      q(sb.from("boh_restaurant_admins").select("user_id").eq("restaurant_id", id)),
    ]);
    admins = admins.map((a) => a.user_id);
    (await q(sb.from("boh_restaurant_category_margins").select("*").eq("restaurant_id", id))).forEach((m) => (margins[m.category_id] = m));
  }
  const m = modal({ wide: true, title: id ? `Edit — ${r.name}` : "Add restaurant", body: `<div class="tabs" id="rt"></div><div id="rb"></div>` });
  const body = $("#rb", m.el);

  const detailsFields = () => `
    <div class="form-grid">
      <div class="field"><label>Restaurant / cafe name *</label><input name="name" value="${esc(r.name || "")}"></div>
      <div class="field"><label>Outlet type</label><select name="outlet_type">${["Restaurant", "Cafe", "Bakery", "Cloud kitchen", "Hotel", "Bar", "Caterer", "Other"].map((t) => `<option ${t === r.outlet_type ? "selected" : ""}>${t}</option>`).join("")}</select></div>
      <div class="field"><label>Contact person</label><input name="contact_name" value="${esc(r.contact_name || "")}"></div>
      <div class="field"><label>Phone</label><input name="phone" value="${esc(r.phone || "")}"></div>
      <div class="field"><label>Email</label><input name="email" value="${esc(r.email || "")}"></div>
      <div class="field"><label>GSTIN</label><input name="gstin" value="${esc(r.gstin || "")}"></div>
      <div class="field"><label>Status</label><select name="active"><option value="true">Active</option><option value="false" ${r.active ? "" : "selected"}>Inactive</option></select></div>
    </div>
    <div class="field"><label>Delivery address</label><textarea name="address" rows="2">${esc(r.address || "")}</textarea></div>
    <div class="field"><label>Internal notes</label><textarea name="notes" rows="2">${esc(r.notes || "")}</textarea></div>
    <div class="field"><label>Our admins for this restaurant (internal — not shown to the restaurant)</label>
      <div class="row">${staffList.map((t) => `<label class="row" style="margin:0;font-weight:400;color:var(--ink)"><input type="checkbox" data-admin="${t.id}" ${admins.includes(t.id) ? "checked" : ""}> ${esc(t.full_name)}</label>`).join("") || '<span class="muted small">No admins yet — add them under Team.</span>'}</div></div>`;
  const readDetails = (root) => {
    const f = formData(root);
    return { name: f.name, outlet_type: f.outlet_type, contact_name: f.contact_name, phone: f.phone, email: f.email, gstin: f.gstin,
      active: f.active === "true", address: f.address, notes: f.notes };
  };
  const saveAdmins = async (rid, root) => {
    const ids = $$("[data-admin]:checked", root).map((x) => x.dataset.admin);
    await q(sb.from("boh_restaurant_admins").delete().eq("restaurant_id", rid));
    if (ids.length) await q(sb.from("boh_restaurant_admins").insert(ids.map((user_id) => ({ restaurant_id: rid, user_id }))));
  };
  const catGrid = () => `
    <div class="row between"><p class="muted" style="margin:0">Tick the categories this restaurant buys from us. Only these show on their ordering screen.</p>
      <label class="row" style="margin:0"><input type="checkbox" id="catall"> Select all</label></div>
    <div class="table-wrap" style="margin-top:.5rem"><table><thead><tr><th>On</th><th>Category</th><th class="right">Default</th><th class="right">Mark-up % for this restaurant</th></tr></thead><tbody>
    ${L.cats.filter((c) => c.active).map((c) => `<tr><td><input type="checkbox" data-con="${c.id}" ${margins[c.id]?.active ? "checked" : ""}></td><td>${esc(c.name)}</td>
      <td class="right muted">${pct(c.default_margin)}</td>
      <td class="right"><input type="number" step="0.01" style="width:110px" data-cat="${c.id}" value="${margins[c.id]?.margin_pct ?? c.default_margin}"></td></tr>`).join("")}
    </tbody></table></div>`;
  const bindCatAll = () => { $("#catall", body).onchange = (e) => $$("[data-con]", body).forEach((x) => (x.checked = e.target.checked)); };
  const saveCats = async (rid) => {
    const rows = $$("[data-cat]", body).map((i) => ({ restaurant_id: rid, category_id: i.dataset.cat, margin_pct: Number(i.value || 0),
      active: $(`[data-con="${i.dataset.cat}"]`, body).checked }));
    await q(sb.from("boh_restaurant_category_margins").upsert(rows));
    rows.forEach((x) => (margins[x.category_id] = x));
  };

  function createForm() {
    const pw = genPassword();
    body.innerHTML = `
      <h3>1. Restaurant details</h3>${detailsFields()}
      <h3 style="margin-top:1rem">2. Restaurant login</h3>
      <p class="small muted">The restaurant signs in with this to place orders. You can add more logins later from Edit → Logins.</p>
      <div class="form-grid" id="lg">
        <div class="field"><label>Login name *</label><input name="l_name" placeholder="e.g. Store manager"></div>
        <div class="field"><label>Login email *</label><input name="l_email" type="email"></div>
        <div class="field"><label>Login phone</label><input name="l_phone"></div>
        <div class="field"><label>Password * (min 8)</label><div class="row" style="flex-wrap:nowrap"><input name="l_pw" value="${pw}"><button class="btn sm" type="button" id="regen">↻</button></div></div>
      </div>
      <h3 style="margin-top:1rem">3. Categories & mark-up</h3>${catGrid()}
      <div class="row" style="justify-content:flex-end;margin-top:1rem"><button class="btn primary" id="save">Create restaurant & login →</button></div>`;
    bindCatAll();
    $("#regen", body).onclick = () => ($('[name="l_pw"]', body).value = genPassword());
    $("#save", body).onclick = async (e) => {
      const d = readDetails(body);
      const f = formData($("#lg", body));
      if (!d.name) return toast("Restaurant name is required", true);
      if (!f.l_name || !f.l_email || !f.l_pw || f.l_pw.length < 8) return toast("Login name, email and an 8+ character password are required", true);
      if (!$$("[data-con]:checked", body).length) return toast("Switch on at least one category", true);
      e.target.disabled = true;
      const created = await q(sb.from("boh_restaurants").insert(d).select().single()).catch(() => null);
      if (!created) { e.target.disabled = false; return; }
      try {
        await callUsersFn({ action: "create_user", role: "customer", restaurant_id: created.id, full_name: f.l_name, email: f.l_email, phone: f.l_phone, password: f.l_pw });
      } catch (err) {
        await sb.from("boh_restaurants").delete().eq("id", created.id);
        e.target.disabled = false;
        return toast("Login could not be created: " + err.message, true);
      }
      await saveCats(created.id);
      await saveAdmins(created.id, body);
      toast(`Restaurant created. Login: ${f.l_email} / ${f.l_pw}`);
      m.close(); reload();
      restaurantEditor(created.id, L, reload, 3); // straight to "Add products"
    };
  }

  function detailsTab() {
    body.innerHTML = detailsFields() + `<div class="row" style="justify-content:flex-end"><button class="btn primary" id="save">Save details</button></div>`;
    $("#save", body).onclick = async () => {
      const d = readDetails(body);
      if (!d.name) return toast("Name is required", true);
      await q(sb.from("boh_restaurants").update(d).eq("id", id));
      await saveAdmins(id, body);
      admins = $$("[data-admin]:checked", body).map((x) => x.dataset.admin);
      Object.assign(r, d); toast("Saved"); reload();
    };
  }

  function catTab() {
    body.innerHTML = catGrid() + `<p class="small muted">Mark-up applies to the best vendor rate. Individual products can be overridden in the ordering list tab.</p>
      <div class="row" style="justify-content:flex-end"><button class="btn primary" id="sm">Save categories & mark-up</button></div>`;
    bindCatAll();
    $("#sm", body).onclick = async () => { await saveCats(id); toast("Saved"); reload(); };
  }

  async function listTab() {
    body.innerHTML = `<div class="empty">Loading…</div>`;
    const rows = await q(sb.rpc("boh_restaurant_catalog", { p_restaurant: id }));
    body.innerHTML = `
      <div class="row between" style="margin-bottom:.6rem"><div class="muted">${rows.length} products on this ordering list. Set a mark-up override <b>or</b> a fixed price; leave both blank to use the category mark-up. A fixed price wins over any mark-up.</div>
        <input id="ls" placeholder="Filter…" style="max-width:240px"></div>
      <div class="table-wrap"><table><thead><tr><th>Product</th><th>Category</th><th class="right">Best cost</th><th>Vendor</th><th class="right">Mark-up override %</th><th class="right">Fixed price ₹</th><th class="right">Margin</th><th class="right">Selling price</th><th>On list</th><th></th></tr></thead><tbody>
      ${rows.map((x) => `<tr data-n="${esc((x.product_name + " " + x.category_name).toLowerCase())}">
        <td>${esc(x.product_name)} <span class="small muted">/${esc(x.unit)}</span></td><td>${esc(x.category_name)} ${x.category_active ? "" : `<span class="badge danger">category off — hidden from restaurant</span> <button class="btn sm" data-caton="${x.category_id}">Switch on</button>`}</td>
        <td class="right">${x.cost == null ? '<span class="badge danger">No rate</span>' : money(x.cost)}</td><td class="small">${esc(x.vendor_name || "")}</td>
        <td class="right"><input type="number" step="0.01" style="width:90px" data-ov="${x.rp_id}" value="${x.margin_override ?? ""}" placeholder="—" ${x.fixed_price != null ? 'disabled title="Click × Use mark-up to switch back"' : ""}></td>
        <td class="right" style="white-space:nowrap"><input type="number" step="0.01" min="0" style="width:100px" data-fp="${x.rp_id}" data-cost="${x.cost ?? ""}" value="${x.fixed_price ?? ""}" placeholder="—">
          ${x.fixed_price != null ? `<div><button class="btn sm" data-unfix="${x.rp_id}" title="Remove the fixed price and use the mark-up again">× Use mark-up</button></div>` : ""}</td>
        <td class="right">${x.cost != null && x.price != null && Number(x.price) < Number(x.cost) ? '<span class="badge danger">Below cost!</span>' : `<span class="${x.effective_margin != null && x.effective_margin < 10 ? "badge warn" : ""}">${pct(x.effective_margin)}</span>`}</td>
        <td class="right"><b>${money(x.price)}</b>${x.fixed_price != null ? ' <span class="badge info">fixed</span>' : ""}</td>
        <td><input type="checkbox" data-act="${x.rp_id}" ${x.rp_active ? "checked" : ""} title="Untick to hide from the restaurant"></td>
        <td><button class="btn sm danger" data-del="${x.rp_id}">Remove</button></td></tr>`).join("") || `<tr><td colspan="10" class="empty">No products allocated yet — use “Add products”.</td></tr>`}
      </tbody></table></div>`;
    $("#ls", body).oninput = (e) => $$("tr[data-n]", body).forEach((tr) => tr.classList.toggle("hidden", !tr.dataset.n.includes(e.target.value.toLowerCase())));
    $$("[data-ov]", body).forEach((i) => (i.onchange = async () => {
      await q(sb.from("boh_restaurant_products").update({ margin_override: i.value === "" ? null : Number(i.value) }).eq("id", i.dataset.ov));
      toast("Mark-up updated"); listTab();
    }));
    $$("[data-fp]", body).forEach((i) => (i.onchange = async () => {
      const price = i.value === "" ? null : Number(i.value);
      const cost = i.dataset.cost === "" ? null : Number(i.dataset.cost);
      if (!(await okFixedPrice(price, cost))) { listTab(); return; }
      try { await q(sb.from("boh_restaurant_products").update({ fixed_price: price }).eq("id", i.dataset.fp)); } catch { return listTab(); }
      toast(price == null ? "Fixed price cleared — mark-up applies" : `Fixed price set to ${money(price)}`); listTab();
    }));
    $$("[data-unfix]", body).forEach((b) => (b.onclick = async () => {
      await q(sb.from("boh_restaurant_products").update({ fixed_price: null }).eq("id", b.dataset.unfix));
      toast("Fixed price removed — mark-up applies again"); listTab();
    }));
    $$("[data-act]", body).forEach((i) => (i.onchange = async () => { await q(sb.from("boh_restaurant_products").update({ active: i.checked }).eq("id", i.dataset.act)); toast("Updated"); }));
    $$("[data-del]", body).forEach((b) => (b.onclick = async () => { await q(sb.from("boh_restaurant_products").delete().eq("id", b.dataset.del)); listTab(); }));
    $$("[data-caton]", body).forEach((b) => (b.onclick = async () => {
      const c = L.cats.find((x) => x.id === b.dataset.caton);
      const row = { restaurant_id: id, category_id: b.dataset.caton, margin_pct: margins[b.dataset.caton]?.margin_pct ?? c?.default_margin ?? 0, active: true };
      await q(sb.from("boh_restaurant_category_margins").upsert(row));
      margins[row.category_id] = row; toast(`${c?.name || "Category"} switched on`); listTab(); reload();
    }));
  }

  async function addProductsTab() {
    body.innerHTML = `<div class="empty">Loading…</div>`;
    const [prods, have] = await Promise.all([
      q(sb.from("boh_products").select("id,name,unit,brand,category_id,image_url").eq("active", true).order("name")),
      q(sb.from("boh_restaurant_products").select("product_id").eq("restaurant_id", id)),
    ]);
    const haveSet = new Set(have.map((h) => h.product_id));
    const onCats = L.cats.filter((c) => margins[c.id]?.active);
    const avail = prods.filter((p) => !haveSet.has(p.id) && onCats.some((c) => c.id === p.category_id));
    body.innerHTML = `
      <div class="row between" style="margin-bottom:.6rem"><div class="muted">Tick products from this restaurant's ordering list. Showing only switched-on categories (${onCats.length}).</div>
        <input id="ps" placeholder="Search products…" style="max-width:260px"></div>
      ${onCats.length ? "" : '<div class="notice">No categories are switched on yet — do that in “Categories & mark-up” first.</div>'}
      ${onCats.map((c) => {
        const list = avail.filter((p) => p.category_id === c.id);
        if (!list.length) return "";
        return `<div class="card" style="padding:.75rem"><div class="row between"><b>${esc(c.name)}</b>
          <label class="row" style="margin:0"><input type="checkbox" data-all="${c.id}"> Select all</label></div>
          <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.3rem;margin-top:.5rem">
          ${list.map((p) => `<label class="row" style="margin:0;font-weight:400;color:var(--ink)" data-pn="${esc(p.name.toLowerCase())}"><input type="checkbox" data-pick="${p.id}" data-c="${c.id}"> ${esc(p.name)} <span class="muted small">${esc(p.unit)}</span></label>`).join("")}
          </div></div>`;
      }).join("") || (onCats.length ? '<div class="empty">Every product in the switched-on categories is already on this list.</div>' : "")}
      <div class="row" style="justify-content:flex-end;margin-top:1rem"><button class="btn primary" id="addsel">Add selected to ordering list</button></div>`;
    $("#ps", body).oninput = (e) => $$("[data-pn]", body).forEach((l) => l.classList.toggle("hidden", !l.dataset.pn.includes(e.target.value.toLowerCase())));
    $$("[data-all]", body).forEach((a) => (a.onchange = () => $$(`[data-c="${a.dataset.all}"]`, body).forEach((x) => (x.checked = a.checked))));
    $("#addsel", body).onclick = async () => {
      const ids = $$("[data-pick]:checked", body).map((x) => x.dataset.pick);
      if (!ids.length) return toast("Nothing selected", true);
      await q(sb.from("boh_restaurant_products").insert(ids.map((pid) => ({ restaurant_id: id, product_id: pid }))));
      toast(`${ids.length} products added`); addProductsTab(); reload();
    };
  }

  async function loginsTab() {
    const [users, pw] = await Promise.all([q(sb.from("boh_users").select("*").eq("restaurant_id", id).eq("role", "customer").order("created_at")), secrets()]);
    body.innerHTML = `
      <p class="muted">People at ${esc(r.name)} who can sign in and place orders.</p>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email (login)</th><th>Phone</th>${isSuper() ? "<th>Password</th>" : ""}<th>Status</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.full_name)}</td><td>${esc(u.email)}</td><td>${esc(u.phone || "")}</td>${isSuper() ? `<td>${pwCell(pw[u.id])}</td>` : ""}
        <td>${u.active ? '<span class="badge ok">Active</span>' : '<span class="badge">Inactive</span>'}</td>
        <td class="right" style="white-space:nowrap"><button class="btn sm" data-ued="${u.id}">Edit</button> <button class="btn sm" data-pw="${u.id}">Reset password</button> <button class="btn sm" data-tog="${u.id}" data-on="${u.active}">${u.active ? "Deactivate" : "Activate"}</button></td></tr>`).join("") || '<tr><td colspan="6" class="empty">No logins yet.</td></tr>'}
      </tbody></table></div>
      <h3 style="margin-top:1rem">Add another login</h3>
      <div class="form-grid" id="nl">
        <div class="field"><label>Full name</label><input name="full_name"></div>
        <div class="field"><label>Email</label><input name="email" type="email"></div>
        <div class="field"><label>Phone</label><input name="phone"></div>
        <div class="field"><label>Password (min 8)</label><input name="password" value="${genPassword()}"></div>
      </div><button class="btn primary" id="cl">Create login</button>`;
    bindReveal(body);
    $("#cl", body).onclick = async () => {
      const f = formData($("#nl", body));
      try { await callUsersFn({ action: "create_user", ...f, role: "customer", restaurant_id: id }); toast(`Login created: ${f.email} / ${f.password}`); loginsTab(); }
      catch (e) { toast(e.message, true); }
    };
    $$("[data-ued]", body).forEach((b) => (b.onclick = () => editUser(users.find((u) => u.id === b.dataset.ued), loginsTab)));
    bindUserActions(body, loginsTab);
  }
  // start (after all helpers above are defined)
  if (!id) return createForm();
  tabs($("#rt", m.el), ["Details", "Categories & mark-up", "Ordering list & pricing", "Add products", "Logins"], (i) => [detailsTab, catTab, listTab, addProductsTab, loginsTab][i](), startTab);
}

// edit name / phone / login email of any user
function editUser(u, reload) {
  const m = modal({
    title: `Edit ${u.full_name}`,
    body: `<div class="form-grid" id="uf">
      <div class="field"><label>Full name</label><input name="full_name" value="${esc(u.full_name)}"></div>
      <div class="field"><label>Phone</label><input name="phone" value="${esc(u.phone || "")}"></div>
      <div class="field"><label>Login email</label><input name="email" type="email" value="${esc(u.email)}"></div></div>`,
    footer: `<button class="btn primary" id="go">Save</button>`,
  });
  $("#go", m.el).onclick = async () => {
    const f = formData($("#uf", m.el));
    if (!f.full_name || !f.email) return toast("Name and email are required", true);
    try {
      await q(sb.from("boh_users").update({ full_name: f.full_name, phone: f.phone }).eq("id", u.id));
      if (f.email.toLowerCase() !== u.email.toLowerCase()) await callUsersFn({ action: "update_login_email", user_id: u.id, email: f.email });
      toast("Saved"); m.close(); reload();
    } catch (e) { toast(e.message, true); }
  };
}

function bindUserActions(root, reload) {
  $$("[data-tog]", root).forEach((b) => (b.onclick = async () => {
    await q(sb.from("boh_users").update({ active: b.dataset.on !== "true" }).eq("id", b.dataset.tog)); toast("Updated"); reload();
  }));
  $$("[data-pw]", root).forEach((b) => (b.onclick = async () => {
    const pw = await promptBox("Reset password", "New password (min 8 characters)", genPassword());
    if (!pw) return;
    try { await callUsersFn({ action: "set_password", user_id: b.dataset.pw, password: pw }); toast(`Password changed to ${pw}`); reload(); } catch (e) { toast(e.message, true); }
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
  let p = { active: true, show_image: true, unit: "kg", category_id: L.cats[0]?.id };
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
          <label class="row" style="margin:0"><input type="checkbox" name="show_image" ${p.show_image !== false ? "checked" : ""}> Show this image to restaurants on their ordering screen</label>
          <label class="row" style="margin:0"><input type="checkbox" name="active" ${p.active ? "checked" : ""}> Active</label>
        </div>
        <div id="rates">${id ? "" : '<div class="notice">Save the product first, then add vendor rates.</div>'}</div>
      </div>`,
    footer: `<button class="btn primary" id="save">Save product</button>`,
  });
  $("#img", m.el).onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const save = $("#save", m.el);
    save.disabled = true;
    $("#imgp", m.el).innerHTML = `<span class="small muted">Uploading image…</span>`;
    try {
      const url = await uploadImage(file, "products");
      $('[name="image_url"]', m.el).value = url;
      $("#imgp", m.el).innerHTML = `<img src="${esc(url)}" style="max-height:100px;border-radius:8px">`;
      if (id) { await q(sb.from("boh_products").update({ image_url: url }).eq("id", id)); toast("Image saved"); reload(); }
      else toast("Image ready — click Save product");
    } catch { $("#imgp", m.el).innerHTML = `<span class="small" style="color:var(--danger)">Upload failed — try again</span>`; }
    save.disabled = false;
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
      <div class="form-grid">
        <div class="field"><label>Mark-up % for this restaurant</label><input type="number" step="0.01" id="mg" value="${suggest(r.product_id)}"></div>
        <div class="field"><label>…or fixed price ₹ (optional)</label><input type="number" step="0.01" min="0" id="fp" placeholder="—"></div>
      </div>
      <div class="small muted" id="costinfo"></div>
      <div class="field"><label>Note to restaurant (optional)</label><input id="nt"></div>`,
    footer: `<button class="btn danger" id="rej">Reject</button><button class="btn primary" id="ok">Approve & add to list</button>`,
  });
  let cost = null;
  const showCost = async (pid) => {
    cost = null;
    if (!pid) { $("#costinfo", m.el).textContent = ""; return; }
    const b = await q(sb.from("boh_product_best_rate").select("rate,vendor_name").eq("product_id", pid).maybeSingle());
    cost = b ? Number(b.rate) : null;
    $("#costinfo", m.el).innerHTML = b ? `Lowest active vendor rate: <b>${money(b.rate)}</b> (${esc(b.vendor_name)}). Fixed price can't go below this.` : "No active vendor rate yet.";
  };
  showCost(r.product_id);
  $("#pp", m.el).onchange = (e) => { $("#mg", m.el).value = suggest(e.target.value); showCost(e.target.value); };
  const go = async (approve) => {
    const pid = $("#pp", m.el).value;
    if (approve && !pid) return toast("Choose the catalogue product", true);
    const fixed = $("#fp", m.el).value === "" ? null : Number($("#fp", m.el).value);
    if (approve && !(await okFixedPrice(fixed, cost))) return;
    if (pid && pid !== r.product_id) await q(sb.from("boh_product_requests").update({ product_id: pid }).eq("id", r.id));
    await q(sb.rpc("boh_review_request", { p_request: r.id, p_approve: approve, p_margin: $("#mg", m.el).value === "" ? null : Number($("#mg", m.el).value), p_note: $("#nt", m.el).value || null }));
    if (approve && fixed != null) await q(sb.from("boh_restaurant_products").update({ fixed_price: fixed }).eq("restaurant_id", r.restaurant_id).eq("product_id", pid));
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
  const [users, rests, ra, pw] = await Promise.all([
    q(sb.from("boh_users").select("*, restaurant:boh_restaurants!boh_users_restaurant_id_fkey(name)").order("role").order("full_name")),
    q(sb.from("boh_restaurants").select("id,name").order("name")),
    q(sb.from("boh_restaurant_admins").select("user_id")),
    secrets(),
  ]);
  const load = {};
  ra.forEach((x) => (load[x.user_id] = (load[x.user_id] || 0) + 1));
  const roles = isSuper() ? ["coordinator", "admin", "super_admin"] : ["coordinator"];
  const canEdit = (u) => u.id !== state.me.id && (isSuper() || ["coordinator", "customer"].includes(u.role));
  el.innerHTML = `
    <div class="page-head"><div><h1>Team & logins</h1><div class="muted">Add coordinators${isSuper() ? " and admins" : ""} here. Restaurant logins are created from Restaurants → Add / Edit.</div></div>
      <button class="btn primary" id="add">+ Add team member</button></div>
    <div class="row" style="margin-bottom:.75rem"><select id="rf" style="max-width:220px"><option value="">All roles</option>${["super_admin", "admin", "coordinator", "customer"].map((r) => `<option value="${r}">${r === "customer" ? "restaurant login" : r.replace("_", " ")}</option>`).join("")}</select></div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Email (login)</th><th>Phone</th>${isSuper() ? "<th>Password</th>" : ""}<th>Restaurant / assigned</th><th>Status</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr data-role="${u.role}"><td><b>${esc(u.full_name)}</b></td><td><span class="badge info">${u.role === "customer" ? "restaurant" : u.role.replace("_", " ")}</span></td><td>${esc(u.email)}</td><td>${esc(u.phone || "")}</td>
      ${isSuper() ? `<td>${u.id === state.me.id && !pw[u.id] ? '<span class="muted small">you</span>' : pwCell(pw[u.id])}</td>` : ""}
      <td class="small">${u.role === "customer" ? esc(u.restaurant?.name || "—") : ["admin", "super_admin"].includes(u.role) ? `${load[u.id] || 0} restaurants` : ""}</td>
      <td>${u.active ? '<span class="badge ok">Active</span>' : '<span class="badge">Inactive</span>'}</td>
      <td class="right" style="white-space:nowrap">${canEdit(u) ? `<button class="btn sm" data-ued="${u.id}">Edit</button> <button class="btn sm" data-pw="${u.id}">Password</button> <button class="btn sm" data-tog="${u.id}" data-on="${u.active}">${u.active ? "Deactivate" : "Activate"}</button>` : ""}</td></tr>`).join("")}
    </tbody></table></div>`;
  bindReveal(el);
  $("#rf").onchange = (e) => $$("tr[data-role]", el).forEach((tr) => tr.classList.toggle("hidden", !!e.target.value && tr.dataset.role !== e.target.value));
  bindUserActions(el, () => team(el));
  $$("[data-ued]", el).forEach((b) => (b.onclick = () => editUser(users.find((x) => x.id === b.dataset.ued), () => team(el))));
  $("#add").onclick = () => {
    const m = modal({
      title: "Add team member",
      body: `<div class="form-grid" id="uf">
        <div class="field"><label>Full name *</label><input name="full_name"></div>
        <div class="field"><label>Phone</label><input name="phone"></div>
        <div class="field"><label>Email (login) *</label><input name="email" type="email"></div>
        <div class="field"><label>Password * (min 8)</label><input name="password" value="${genPassword()}"></div>
        <div class="field"><label>Role</label><select name="role">${roles.map((r) => `<option value="${r}">${r.replace("_", " ")}</option>`).join("")}</select></div>
      </div>`,
      footer: `<button class="btn primary" id="go">Create</button>`,
    });
    $("#go", m.el).onclick = async () => {
      const f = formData($("#uf", m.el));
      if (!f.full_name || !f.email) return toast("Name and email are required", true);
      try { await callUsersFn({ action: "create_user", ...f }); toast(`Created: ${f.email} / ${f.password}`); m.close(); team(el); }
      catch (e) { toast(e.message, true); }
    };
  };
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
        <div class="field" style="grid-column:1/-1"><label>Payment instructions shown to restaurants (UPI ID, bank account, QR link…)</label><textarea name="payment_instructions" rows="3" placeholder="UPI: backofhouse@okbank&#10;Bank: XYZ Bank, A/c 1234567890, IFSC XYZB0000123">${esc(s.payment_instructions || "")}</textarea></div>
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
