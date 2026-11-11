import {
  sb, state, $, $$, esc, money, num, pct, fmtDT, fmtD, toast, modal, confirmBox, formData, q, callUsersFn,
  uploadImage, tabs, statusBadge, dueBadge, dueText, stepsHTML, allocSteps, orderSteps, telLinks, DELIVERY_LABEL, NEXT_STEP, STEP_BUTTON,
  OVERHEAD_KINDS, payBadge, PAY_MODE, todayIST, daysAgoIST, downloadCSV, promptBox, orderAlloc, canDeliver,
} from "./lib.js?v=17";

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
  const [orders, reqs, comps, ohs, L, bals, prs] = await Promise.all([
    q(sb.from("boh_orders").select(ORDER_SELECT).gte("created_at", daysAgoIST(45) + "T00:00:00+05:30").order("created_at", { ascending: false })),
    q(sb.from("boh_product_requests").select("id").eq("status", "pending")),
    q(sb.from("boh_complaints").select("id").neq("status", "resolved")),
    q(sb.from("boh_order_overheads").select("amount, kind, ord:boh_orders!inner(created_at,status)").gte("ord.created_at", monthStart + "T00:00:00+05:30").neq("ord.status", "cancelled")),
    lookups(),
    q(sb.rpc("boh_balances")),
    q(sb.from("boh_price_reports").select("id").eq("status", "new")),
  ]);
  const bsum = (k) => bals.reduce((a, b) => a + Number(b[k]), 0);
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
      <div class="card stat"><div class="l">Pending balance (all restaurants)</div><div class="v">${money(bsum("pending"))}</div>
        <div class="small muted">Due now ${money(bsum("due"))} · <span style="color:var(--danger)">Overdue ${money(bsum("overdue"))}</span> · Under approval ${money(bsum("under_review"))} · Not delivered yet ${money(bsum("upcoming"))}</div></div>
      <div class="card stat"><div class="l">Sales this month</div><div class="v">${money(sales)}</div></div>
      <div class="card stat"><div class="l">Gross margin this month</div><div class="v">${money(sales - cost)}</div><div class="small muted">${sales ? pct(((sales - cost) / sales) * 100) : ""}</div></div>
      <div class="card stat"><div class="l">Overheads this month</div><div class="v">${money(oh)}</div><div class="small muted">Porter ${money(porter)}</div></div>
      <div class="card stat"><div class="l">Net margin this month</div><div class="v">${money(sales - cost - oh)}</div><div class="small muted">${sales ? pct(((sales - cost - oh) / sales) * 100) : ""}</div></div>
      <div class="card stat"><div class="l">Pending product requests</div><div class="v">${reqs.length}</div></div>
      <div class="card stat"><div class="l">Open complaints</div><div class="v">${comps.length}</div></div>
      <div class="card stat"><div class="l">Cheaper vendors reported</div><div class="v">${prs.length}</div><div class="small muted"><a href="#/pricereports">Review</a></div></div>
    </div>
    ${bals.length ? `<div class="card" style="margin-top:1rem"><h2>Pending balance by restaurant</h2><div class="table-wrap"><table><thead><tr><th>Restaurant</th><th class="right">Due now</th><th class="right">Overdue</th><th class="right">Under approval</th><th class="right">Not delivered yet</th><th class="right">Total pending</th></tr></thead><tbody>
      ${bals.sort((a, b) => b.pending - a.pending).map((b) => `<tr><td>${esc(L.restMap[b.restaurant_id]?.name || "—")}</td><td class="right">${money(b.due)}</td>
        <td class="right" style="color:${Number(b.overdue) ? "var(--danger)" : "inherit"}">${money(b.overdue)}</td><td class="right">${money(b.under_review)}</td><td class="right">${money(b.upcoming)}</td><td class="right"><b>${money(b.pending)}</b></td></tr>`).join("")}
      </tbody></table></div></div>` : ""}
    <div class="card" style="margin-top:1rem"><h2>Needs attention</h2>
      ${orderTable([...live.filter((o) => o.payment_status === "under_review"), ...overdue, ...live.filter((o) => o.status === "placed" && !overdue.includes(o))].filter((o, i, a) => a.indexOf(o) === i).slice(0, 20), L)}</div>`;
  bindOrderTable(el, L, () => dashboard(el));
}

// ====================================================================== ORDERS
function coordNames(o, L) {
  const ids = o.coordinator_id ? [o.coordinator_id, ...(o.allocs || []).map((a) => a.coordinator_id)] : (o.allocs || []).map((a) => a.coordinator_id);
  const names = [...new Set(ids.map((id) => L.teamMap[id]?.full_name || "—"))];
  return names.length ? esc(names.join(", ")) : '<span class="muted">Unassigned</span>';
}

function orderTable(rows, L) {
  if (!rows.length) return `<div class="empty">No orders here.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>#</th><th>Restaurant</th><th>Placed</th><th>Delivery</th><th class="right">Total</th><th>Status</th><th>Payment</th><th>Coordinator</th><th>SLA</th><th></th></tr></thead><tbody>
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

// one coordinator handles the whole order
async function allocateModal(orderId, L, reload) {
  const [o, items] = await Promise.all([
    q(sb.from("boh_orders").select(ORDER_SELECT).eq("id", orderId).single()),
    q(sb.from("boh_order_items").select("category_name, vendor_name, line_total").eq("order_id", orderId)),
  ]);
  const cur = o.coordinator_id || o.allocs?.[0]?.coordinator_id || "";
  const people = L.team.filter((t) => t.active);
  const cats = [...new Set(items.map((i) => i.category_name))];
  const vendors = [...new Set(items.map((i) => i.vendor_name || "No vendor"))];
  const m = modal({
    title: `${o.status === "placed" ? "Allocate" : "Reassign"} order #${o.order_no}`,
    body: `<p class="muted">${esc(L.restMap[o.restaurant_id]?.name)} · placed ${fmtDT(o.created_at)} · ${dueBadge(o)}</p>
      <p class="small">${items.length} items · ${money(o.total)} · ${cats.length} categor${cats.length > 1 ? "ies" : "y"} · ${vendors.length} vendor${vendors.length > 1 ? "s" : ""}: ${esc(vendors.join(", "))}</p>
      <div class="field"><label>Coordinator for this order</label><select id="co"><option value="">— choose —</option>
        ${people.map((t) => `<option value="${t.id}" ${t.id === cur ? "selected" : ""}>${esc(t.full_name)} (${t.role.replace("_", " ")})${t.phone ? " · " + esc(t.phone) : ""}</option>`).join("")}</select>
        <div class="small muted">They get the full order with each vendor's numbers, and must acknowledge within ${state.settings.sla_ack_hrs} working hr.</div></div>`,
    footer: `<button class="btn primary" id="go">${o.status === "placed" ? "Allocate" : "Save"}</button>`,
  });
  $("#go", m.el).onclick = async () => {
    const co = $("#co", m.el).value;
    if (!co) return toast("Choose a coordinator", true);
    await q(sb.rpc("boh_allocate_order_to", { p_order: orderId, p_coordinator: co }));
    toast("Order allocated to " + (L.teamMap[co]?.full_name || "coordinator"));
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

// move the whole order forward; delivery asks for overhead charges
export async function advanceOrder(o, step, done) {
  let note = null, overheads = [];
  if (["followup1", "followup2"].includes(step)) {
    note = await promptBox(`Order #${o.order_no} — ${step === "followup1" ? "1st" : "2nd"} follow-up`, "What did the vendor(s) say?");
    if (note === null) return;
  }
  if (step === "delivered") {
    overheads = await overheadForm(`Order #${o.order_no} delivered — overheads`, true);
    if (overheads === null) return;
  }
  await q(sb.rpc("boh_advance_order_all", { p_order: o.id, p_step: step, p_note: note, p_overheads: overheads }));
  toast(step === "delivered" ? "Marked delivered" : "Updated");
  refreshCounts(); done?.();
}

// vendor not responding: move its lines to another vendor, skip it for this order or disable it
export async function changeVendor(o, vendorId, lines, done) {
  const opts = await q(sb.rpc("boh_vendor_options", { p_order: o.id }));
  const pids = new Set(lines.map((l) => l.product_id));
  const alts = opts.filter((x) => pids.has(x.product_id) && x.vendor_id !== vendorId);
  const byVendor = {};
  alts.forEach((x) => { const v = (byVendor[x.vendor_id] ||= { id: x.vendor_id, name: x.vendor_name, phones: x.phones, style: x.delivery_style, skipped: x.skipped, rates: {} }); v.rates[x.product_id] = Number(x.rate); });
  const vlist = Object.values(byVendor);
  // what "next cheapest" would pick per line (skipped vendors excluded)
  const auto = (pid) => alts.filter((x) => x.product_id === pid && !x.skipped).sort((a, b) => a.rate - b.rate)[0];
  const fromName = lines[0]?.vendor_name || "this vendor";
  const marginTxt = (price, rate) => rate ? ((price / rate - 1) * 100) : null;
  const preview = (target) => lines.map((l) => {
    const pick = target ? (byVendor[target]?.rates[l.product_id] != null ? { vendor_name: byVendor[target].name, rate: byVendor[target].rates[l.product_id] } : null) : auto(l.product_id);
    const mg = pick ? marginTxt(Number(l.unit_price), Number(pick.rate)) : null;
    return `<tr><td>${esc(l.product_name)}</td><td class="right">${money(l.unit_cost)}</td>
      <td>${pick ? esc(pick.vendor_name) : '<span class="badge danger">No other vendor</span>'}</td>
      <td class="right">${pick ? money(pick.rate) : "—"}</td>
      <td class="right">${mg == null ? "—" : `<span style="color:${mg < 0 ? "var(--danger)" : mg < 10 ? "var(--warn)" : "inherit"}">${mg.toFixed(1)}%</span>`}</td></tr>`;
  }).join("");
  const m = modal({
    wide: true,
    title: `Change vendor — ${fromName}`,
    body: `<p class="muted">Order #${o.order_no}. The restaurant's price does not change; only who we buy from.</p>
      <div class="field"><label>What should happen to ${esc(fromName)}?</label>
        <label class="row" style="gap:.4rem;font-weight:400"><input type="radio" name="mode" value="skip" checked> Skip for this order only <span class="small muted">(not responding today — still used next time)</span></label>
        <label class="row" style="gap:.4rem;font-weight:400"><input type="radio" name="mode" value="disable"> Disable this vendor <span class="small muted">(made inactive — not used for any future order until re-activated)</span></label></div>
      <div class="field"><label>Move these items to</label><select id="tg"><option value="">Next cheapest vendor automatically</option>
        ${vlist.map((v) => `<option value="${v.id}">${esc(v.name)}${v.skipped ? " (skipped earlier)" : ""} · ${Object.keys(v.rates).length}/${pids.size} items</option>`).join("")}</select></div>
      <div class="field"><label>Reason</label><input id="rs" placeholder="e.g. Not picking up since 11 am"></div>
      <table><thead><tr><th>Item</th><th class="right">Now</th><th>New vendor</th><th class="right">New rate</th><th class="right">Our margin</th></tr></thead><tbody id="pv">${preview("")}</tbody></table>
      <div id="vph" class="small" style="margin-top:.5rem"></div>`,
    footer: `<button class="btn primary" id="go">Change vendor</button>`,
  });
  const showPh = () => { const v = byVendor[$("#tg", m.el).value]; $("#vph", m.el).innerHTML = v ? `📞 ${telLinks(v.phones)} · ${esc(DELIVERY_LABEL[v.style] || "")}` : ""; };
  $("#tg", m.el).onchange = () => { $("#pv", m.el).innerHTML = preview($("#tg", m.el).value); showPh(); };
  $("#go", m.el).onclick = async () => {
    const mode = $("input[name=mode]:checked", m.el).value;
    if (mode === "disable" && !(await confirmBox(`Disable ${fromName}? It will not be used for any future order until an admin re-activates it in Vendors.`))) return;
    const stuck = await q(sb.rpc("boh_reassign_vendor", { p_order: o.id, p_vendor: vendorId, p_mode: mode, p_target: $("#tg", m.el).value || null, p_reason: $("#rs", m.el).value.trim() || null }));
    m.close();
    if (stuck?.length) toast(`Changed, but no other vendor for: ${stuck.map((x) => x.product_name).join(", ")} — still with ${fromName}`, true);
    else toast(mode === "disable" ? `${fromName} disabled and items moved` : `Items moved — ${fromName} skipped for this order`);
    done?.();
  };
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
  const [o, items, events, ohs, skips] = await Promise.all([
    q(sb.from("boh_orders").select("*, coordinator:boh_users!boh_orders_coordinator_id_fkey(full_name,phone), allocs:boh_order_allocations(*, coordinator:boh_users!boh_order_allocations_coordinator_id_fkey(full_name,phone)), restaurant:boh_restaurants(name,phone,address)").eq("id", orderId).single()),
    q(sb.from("boh_order_items").select("*, vendor:boh_vendors(name,phones,delivery_style,active)").eq("order_id", orderId).order("vendor_name").order("product_name")),
    q(sb.from("boh_order_events").select("*, actor:boh_users(full_name)").eq("order_id", orderId).order("created_at")),
    q(sb.from("boh_order_overheads").select("*, by:boh_users(full_name)").eq("order_id", orderId).order("created_at")),
    q(sb.from("boh_order_vendor_skips").select("*, vendor:boh_vendors(name)").eq("order_id", orderId)),
  ]);
  const staff = isStaff();
  const onOrder = o.coordinator_id === state.me.id || (o.allocs || []).some((a) => a.coordinator_id === state.me.id);
  const can = (staff || onOrder) && !["cancelled", "paid", "delivered"].includes(o.status);
  const A = orderAlloc(o);
  const coName = o.coordinator?.full_name || A?.coordinator?.full_name;
  const coPhone = o.coordinator?.phone || A?.coordinator?.phone;
  const ohTotal = ohs.reduce((a, x) => a + Number(x.amount), 0);
  const byVendor = {};
  items.forEach((i) => (byVendor[i.vendor_id || "x"] ||= { id: i.vendor_id, v: i.vendor, name: i.vendor_name, style: i.delivery_style, lines: [] }).lines.push(i));
  const skipped = skips.filter((x) => x.vendor);
  const next = A && o.status !== "placed" ? NEXT_STEP[A.status] : null;

  const vendorSection = (g) => `<div class="card" style="padding:.8rem;margin-bottom:.6rem">
      <div class="row between"><div><b>🏪 ${esc(g.name || "No vendor")}</b> <span class="badge info">${esc(DELIVERY_LABEL[g.style] || "")}</span>
        ${g.v && g.v.active === false ? '<span class="badge danger">Disabled</span>' : ""}
        <div class="small phones">📞 ${telLinks(g.v?.phones)}</div></div>
        ${can && g.id ? `<button class="btn sm" data-chv="${g.id}" title="Vendor not responding? Move these items to another vendor">⇄ Change vendor</button>` : ""}</div>
      <table style="margin-top:.4rem"><thead><tr><th>Item</th><th>Category</th><th class="right">Qty</th>${staff ? '<th class="right">Cost</th><th class="right">Margin</th>' : ""}<th class="right">Price</th><th class="right">Total</th></tr></thead><tbody>
      ${g.lines.map((i) => `<tr><td>${esc(i.product_name)}</td><td class="small muted">${esc(i.category_name || "")}</td><td class="right">${num(i.qty, 3)} ${esc(i.unit || "")}</td>
        ${staff ? `<td class="right">${money(i.unit_cost)}</td><td class="right">${pct(i.margin_pct)}</td>` : ""}
        <td class="right">${money(i.unit_price)}</td><td class="right">${money(i.line_total)}</td></tr>`).join("")}</tbody></table></div>`;

  const m = modal({
    wide: true,
    title: `Order #${o.order_no} — ${o.restaurant?.name || ""}`,
    body: `
      <div class="row" style="margin-bottom:1rem">${statusBadge(o.status)} ${dueBadge(o)}
        <span class="muted">Placed ${fmtDT(o.created_at)} · Delivery ${fmtD(o.delivery_date)} · ${esc(o.restaurant?.phone || "")} · ${esc(o.restaurant?.address || "")}</span></div>
      ${o.notes ? `<div class="notice">Restaurant note: ${esc(o.notes)}</div>` : ""}
      <div class="grid c2" style="align-items:start">
        <div>
          <div class="card" style="padding:.8rem;margin-bottom:.6rem"><div class="row between">
            <div>${coName ? `👤 <b>${esc(coName)}</b> ${coPhone ? "· " + telLinks([coPhone]) : ""}` : '<span class="badge warn">Not allocated</span>'}</div>
            <div class="row">${A ? statusBadge(A.status) : ""}</div></div>
            ${A ? `<details style="margin-top:.5rem"><summary class="small">Coordinator timeline</summary>${stepsHTML(allocSteps(o, A))}
              ${A.followup1_note ? `<p class="small"><b>1st follow-up:</b> ${esc(A.followup1_note)}</p>` : ""}${A.followup2_note ? `<p class="small"><b>2nd follow-up:</b> ${esc(A.followup2_note)}</p>` : ""}</details>` : ""}
            ${can && A && o.status !== "placed" ? `<div class="row" style="justify-content:flex-end;margin-top:.5rem">
              ${canDeliver(A.status) && next !== "delivered" ? `<button class="btn sm" data-oadv="delivered">Mark delivered</button>` : ""}
              ${next ? `<button class="btn sm primary" data-oadv="${next}">${STEP_BUTTON[next]}</button>` : ""}</div>` : ""}
          </div>
          <h3 style="margin:.4rem 0">Vendors — whom to order from</h3>
          ${Object.values(byVendor).map(vendorSection).join("")}
          ${skipped.length ? `<div class="small muted">Not used on this order: ${skipped.map((x) => `${esc(x.vendor.name)} (${x.mode === "disable" ? "disabled" : "skipped"}${x.reason ? " — " + esc(x.reason) : ""})`).join(", ")}</div>` : ""}
          <div class="row between" style="margin-top:.75rem"><b>Order total</b><b>${money(o.total)}</b></div>
          ${staff ? `<div class="row between small muted"><span>Cost ${money(o.cost_total)} · Overheads ${money(ohTotal)}</span><span>Net margin ${money(o.total - o.cost_total - ohTotal)}</span></div>` : ""}
        </div>
        <div>
          <h3>Payment</h3>
          <div class="card" style="padding:.7rem">
            <div class="row between"><span>${PAY_MODE[o.payment_mode] || ""}</span>${payBadge(o)}</div>
            ${o.payment_claim_ref && o.payment_status !== "paid" ? `<div class="small" style="margin-top:.3rem">Restaurant says paid${o.payment_claim_method ? " via " + esc(o.payment_claim_method) : ""} · ref <b>${esc(o.payment_claim_ref)}</b> · ${fmtDT(o.payment_claimed_at)}</div>` : ""}
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
  $$("[data-oadv]", m.el).forEach((b) => (b.onclick = () => advanceOrder(o, b.dataset.oadv, reopen)));
  $$("[data-chv]", m.el).forEach((b) => (b.onclick = () => changeVendor(o, b.dataset.chv, byVendor[b.dataset.chv].lines, reopen)));
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
    <div class="page-head"><div><h1>Orders & allocation</h1><div class="muted">Allocate each order to one coordinator within ${state.settings.sla_allocate_hrs} working hours.</div></div></div>
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
    if ($("#fc").value) rows = rows.filter((o) => o.coordinator_id === $("#fc").value || (o.allocs || []).some((a) => a.coordinator_id === $("#fc").value));
    $("#list").innerHTML = orderTable(rows, L);
    bindOrderTable($("#list"), L, load);
  };
  $$("select, input", el).forEach((i) => (i.onchange = load));
  load();
}

// ====================================================================== RESTAURANTS
export async function restaurants(el) {
  const [rows, admins, logins, cats, bals] = await Promise.all([
    q(sb.from("boh_restaurants").select("*, boh_restaurant_products(count)").order("name")),
    q(sb.from("boh_restaurant_admins").select("restaurant_id, user:boh_users(full_name)")),
    q(sb.from("boh_users").select("restaurant_id").eq("role", "customer")),
    q(sb.from("boh_restaurant_category_margins").select("restaurant_id").eq("active", true)),
    q(sb.rpc("boh_balances")),
  ]);
  const balOf = (id) => bals.find((b) => b.restaurant_id === id);
  const count = (arr, id) => arr.filter((x) => x.restaurant_id === id).length;
  el.innerHTML = `
    <div class="page-head"><div><h1>Restaurants</h1><div class="muted">Create a restaurant with its login, switch on its categories, then allocate its ordering list.</div></div>
      <button class="btn primary" id="add">+ Add restaurant</button></div>
    <div class="row" style="margin-bottom:.75rem"><input id="s" placeholder="Search restaurants…" style="max-width:320px"></div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Contact</th><th>Our admins</th><th class="right">Categories on</th><th class="right">Items on list</th><th class="right">Logins</th><th class="right">Pending balance</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr data-name="${esc(r.name.toLowerCase())}">
      <td><b>${esc(r.name)}</b><div class="small muted">${esc(r.address || "")}</div></td><td>${esc(r.outlet_type || "")}</td>
      <td>${esc(r.contact_name || "")}<div class="small">${esc(r.phone || "")}</div></td>
      <td class="small">${esc(admins.filter((a) => a.restaurant_id === r.id).map((a) => a.user?.full_name).join(", ") || "—")}</td>
      <td class="right">${count(cats, r.id)}</td>
      <td class="right">${r.boh_restaurant_products?.[0]?.count ?? 0}</td>
      <td class="right">${count(logins, r.id)}</td>
      <td class="right">${balOf(r.id) ? `<b>${money(balOf(r.id).pending)}</b>${Number(balOf(r.id).overdue) ? `<div class="small" style="color:var(--danger)">Overdue ${money(balOf(r.id).overdue)}</div>` : ""}` : '<span class="muted">—</span>'}</td>
      <td>${r.active ? '<span class="badge ok">Active</span>' : '<span class="badge">Inactive</span>'}</td>
      <td class="right"><button class="btn sm primary" data-edit="${r.id}">✎ Edit</button></td></tr>`).join("") || `<tr><td colspan="10" class="empty">No restaurants yet.</td></tr>`}</tbody></table></div>`;
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
      <td><button class="btn sm" data-tog="${v.id}" data-on="${v.active}">${v.active ? "✅ Active" : "⛔ Inactive"}</button>
        ${!v.active && v.disabled_at ? `<div class="small muted">Disabled ${fmtD(v.disabled_at)}${v.disabled_reason ? " — " + esc(v.disabled_reason) : ""}</div>` : ""}</td>
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
    $("#list").innerHTML = `<div class="table-wrap"><table><thead><tr><th>When</th><th>Restaurant</th><th>Product</th><th>From</th><th>Note</th><th>Status</th><th class="right">Mark-up</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${fmtDT(r.created_at)}</td><td>${esc(r.restaurant?.name)}<div class="small muted">${esc(r.by?.full_name || "")}</div></td>
        <td>${r.product ? esc(r.product.name) : `<i>New item:</i> ${esc(r.item_name)}`}</td>
        <td>${r.source === "slideshow" ? '<span class="badge info">Slideshow enquiry</span>' : '<span class="badge">Browse</span>'}</td><td class="small">${esc(r.note || "")}</td>
        <td><span class="badge ${r.status === "approved" ? "ok" : r.status === "rejected" ? "danger" : "warn"}">${r.status}</span>${r.admin_note ? `<div class="small muted">${esc(r.admin_note)}</div>` : ""}</td>
        <td class="right">${pct(r.margin_pct)}</td>
        <td class="right">${r.status === "pending" ? `<button class="btn sm primary" data-rev="${r.id}">Review</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="8" class="empty">Nothing here.</td></tr>'}
      </tbody></table></div>`;
    $$("[data-rev]", el).forEach((b) => (b.onclick = () => reviewRequest(rows.find((x) => x.id === b.dataset.rev), L, load)));
  };
  $("#st").onchange = load;
  load();
}

// ====================================================================== CHEAPER VENDOR REPORTS
const PR_STATUS = { new: ["New", "warn"], reviewing: ["Checking", "info"], matched: ["Matched / added", "ok"], rejected: ["Not valid", "danger"] };
export async function priceReports(el) {
  el.innerHTML = `
    <div class="page-head"><div><h1>Cheaper vendors reported</h1><div class="muted">Restaurants tell us when they find a lower price. Check the vendor, add them with a rate, or adjust the restaurant's price.</div></div>
      <select id="st" style="max-width:200px"><option value="open">Open</option><option value="">All</option>${Object.entries(PR_STATUS).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join("")}</select></div>
    <div id="list"></div>`;
  const load = async () => {
    let qq = sb.from("boh_price_reports").select("*, restaurant:boh_restaurants(name), by:boh_users(full_name)").order("created_at", { ascending: false });
    const st = $("#st").value;
    if (st === "open") qq = qq.in("status", ["new", "reviewing"]); else if (st) qq = qq.eq("status", st);
    const rows = await q(qq);
    const pids = [...new Set(rows.map((r) => r.product_id).filter(Boolean))];
    const best = pids.length ? await q(sb.from("boh_product_best_rate").select("product_id, rate, vendor_name").in("product_id", pids)) : [];
    const bestOf = (pid) => best.find((b) => b.product_id === pid);
    $("#list").innerHTML = `<div class="table-wrap"><table><thead><tr><th>When</th><th>Restaurant</th><th>Product</th><th class="right">Their price</th><th class="right">Our price</th><th class="right">Our best cost</th><th>Vendor they found</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((r) => { const b = bestOf(r.product_id); const diff = r.our_price ? ((r.our_price - r.reported_price) / r.our_price) * 100 : null;
        return `<tr><td>${fmtDT(r.created_at)}</td><td>${esc(r.restaurant?.name)}<div class="small muted">${esc(r.by?.full_name || "")}</div></td>
        <td>${esc(r.product_name)} <span class="small muted">/${esc(r.unit || "")}</span>${r.note ? `<div class="small muted">${esc(r.note)}</div>` : ""}</td>
        <td class="right"><b>${money(r.reported_price)}</b>${diff != null ? `<div class="small" style="color:var(--danger)">${diff.toFixed(1)}% lower</div>` : ""}</td>
        <td class="right">${money(r.our_price)}</td>
        <td class="right">${b ? `${money(b.rate)}<div class="small muted">${esc(b.vendor_name)}</div>` : "—"}</td>
        <td><b>${esc(r.vendor_name)}</b><div class="small phones">📞 ${telLinks([r.vendor_contact])}</div></td>
        <td><span class="badge ${PR_STATUS[r.status][1]}">${PR_STATUS[r.status][0]}</span>${r.admin_note ? `<div class="small muted">${esc(r.admin_note)}</div>` : ""}</td>
        <td class="right" style="white-space:nowrap"><button class="btn sm primary" data-pr="${r.id}">Act</button></td></tr>`; }).join("") || '<tr><td colspan="9" class="empty">Nothing here.</td></tr>'}
      </tbody></table></div>`;
    $$("[data-pr]", el).forEach((b) => (b.onclick = () => priceReportAction(rows.find((x) => x.id === b.dataset.pr), load)));
  };
  $("#st").onchange = load;
  load();
}

async function priceReportAction(r, reload) {
  const vendors = await q(sb.from("boh_vendors").select("id, name, phones, active").order("name"));
  const digits = (x) => String(x || "").replace(/\D/g, "").slice(-10);
  const match = vendors.find((v) => (v.phones || []).some((p) => digits(p) && digits(p) === digits(r.vendor_contact))) || vendors.find((v) => v.name.toLowerCase() === r.vendor_name.toLowerCase());
  const m = modal({
    title: `Cheaper vendor — ${r.product_name}`,
    body: `<p class="small">${esc(r.restaurant?.name)} found <b>${esc(r.product_name)}</b> at <b>${money(r.reported_price)}</b> from <b>${esc(r.vendor_name)}</b> (${telLinks([r.vendor_contact])}). Our price to them: ${money(r.our_price)}.</p>
      <div class="field"><label>Status</label><select id="st">${Object.entries(PR_STATUS).map(([k, v]) => `<option value="${k}" ${k === r.status ? "selected" : ""}>${v[0]}</option>`).join("")}</select></div>
      <div class="field"><label>Note (for our team)</label><input id="nt" value="${esc(r.admin_note || "")}" placeholder="e.g. Called — rate valid for 25 kg bags only"></div>
      ${r.product_id ? `<details ${r.status === "new" ? "open" : ""}><summary><b>Add this vendor's rate for ${esc(r.product_name)}</b></summary>
        <div class="field" style="margin-top:.5rem"><label>Vendor</label><select id="vd"><option value="__new">+ New vendor: ${esc(r.vendor_name)} (${esc(r.vendor_contact)})</option>
          ${vendors.map((v) => `<option value="${v.id}" ${match?.id === v.id ? "selected" : ""}>${esc(v.name)}${v.active ? "" : " (inactive)"}</option>`).join("")}</select>
          ${match ? `<div class="small muted">Matched an existing vendor by ${digits(r.vendor_contact) && (match.phones || []).some((p) => digits(p) === digits(r.vendor_contact)) ? "phone number" : "name"}.</div>` : ""}</div>
        <div class="field"><label>Our buying rate from them (₹)</label><input id="rt" type="number" step="0.01" min="0" value="${r.reported_price}">
          <div class="small muted">Prefilled with the price the restaurant was offered — change it to what the vendor quotes us.</div></div>
        <button class="btn" id="addv" type="button">Save vendor + rate and mark Matched</button></details>` : ""}`,
    footer: `<button class="btn primary" id="save">Save status</button>`,
  });
  const done = async (status) => {
    await q(sb.from("boh_price_reports").update({ status, admin_note: $("#nt", m.el).value.trim() || null, updated_at: new Date().toISOString() }).eq("id", r.id));
    m.close(); refreshCounts(); reload();
  };
  $("#save", m.el).onclick = () => done($("#st", m.el).value).then(() => toast("Saved"));
  $("#addv", m.el)?.addEventListener("click", async () => {
    const rate = Number($("#rt", m.el).value);
    if (!(rate > 0)) return toast("Enter the rate", true);
    let vid = $("#vd", m.el).value;
    if (vid === "__new") {
      const [v] = await q(sb.from("boh_vendors").insert({ name: r.vendor_name, phones: [r.vendor_contact], notes: `Reported by ${r.restaurant?.name || "restaurant"} on ${fmtD(r.created_at)}` }).select("id"));
      vid = v.id;
    }
    await q(sb.from("boh_vendor_rates").upsert({ vendor_id: vid, product_id: r.product_id, rate, active: true, updated_at: new Date().toISOString() }, { onConflict: "vendor_id,product_id" }));
    toast("Vendor rate saved — it will be used if it's the cheapest");
    await done("matched");
  });
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
  const [rows, prods, enq, reqs] = await Promise.all([
    q(sb.from("boh_featured").select("*, product:boh_products(name,image_url,description,unit)").order("created_at", { ascending: false })),
    q(sb.from("boh_products").select("id,name,image_url,description,unit").eq("active", true).order("name")),
    q(sb.from("boh_enquiries").select("featured_id")),
    q(sb.from("boh_product_requests").select("featured_id").eq("source", "slideshow")),
  ]);
  const cnt = (arr, id) => arr.filter((x) => x.featured_id === id).length;
  el.innerHTML = `
    <div class="page-head"><div><h1>Showcase slideshow</h1><div class="muted">Shown to every restaurant at the top of their home screen, in random order. “Know more” opens the details below with an Enquire button.
      Enquiries on a slide linked to a catalogue product go to <a href="#/requests">Product requests</a>; others go to <a href="#/enquiries">Enquiries</a>.</div></div>
      <button class="btn primary" id="add">+ Add slide</button></div>
    <div class="prod-grid">${rows.map((f) => `<div class="prod">
      <div class="img" style="background-image:url('${esc(f.image_url || f.product?.image_url || "")}')">${f.image_url || f.product?.image_url ? "" : "🖼️"}</div>
      <div class="b"><b>${esc(f.title)}</b>${f.price_label ? `<div style="color:var(--brand);font-weight:650">${esc(f.price_label)}</div>` : ""}
        <div class="small muted">${esc(f.caption || "")}</div>
        <div class="small">${f.product ? "Product: " + esc(f.product.name) : "No product linked"}</div>
        <div class="small">${f.product ? `${cnt(reqs, f.id)} request(s)` : `${cnt(enq, f.id)} enquiry(ies)`}</div>
        <div class="row"><label class="row" style="margin:0"><input type="checkbox" data-act="${f.id}" ${f.active ? "checked" : ""}> Live</label><span class="grow"></span>
          <button class="btn sm" data-ed="${f.id}">Edit</button><button class="btn sm danger" data-del="${f.id}">Delete</button></div></div></div>`).join("") || '<div class="empty">No slides yet.</div>'}</div>`;
  $$("[data-act]", el).forEach((i) => (i.onchange = async () => { await q(sb.from("boh_featured").update({ active: i.checked }).eq("id", i.dataset.act)); toast("Updated"); }));
  $$("[data-del]", el).forEach((b) => (b.onclick = async () => { if (await confirmBox("Delete this slide?")) { await q(sb.from("boh_featured").delete().eq("id", b.dataset.del)); showcase(el); } }));
  $("#add").onclick = () => slideEditor(null);
  $$("[data-ed]", el).forEach((b) => (b.onclick = () => slideEditor(rows.find((x) => x.id === b.dataset.ed))));

  function slideEditor(f) {
    f = f || { gallery: [], active: true };
    let banner = f.image_url || null;
    let gallery = [...(f.gallery || [])];
    const m = modal({
      wide: true,
      title: f.id ? `Edit slide — ${f.title}` : "Add showcase slide",
      body: `<div class="grid c2" style="align-items:start"><div>
          <div class="field"><label>Catalogue product (optional — enquiries then become product requests)</label><select id="fp"><option value="">— none (new / non-catalogue item) —</option>${prods.map((p) => `<option value="${p.id}" ${p.id === f.product_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
          <div class="field"><label>Headline *</label><input id="ftl" value="${esc(f.title || "")}"></div>
          <div class="field"><label>Short caption (on the slide)</label><input id="fc" value="${esc(f.caption || "")}"></div>
          <div class="field"><label>Price shown (free text)</label><input id="fpr" value="${esc(f.price_label || "")}" placeholder="e.g. ₹120 / pack of 50 · From ₹2,500 · Intro offer ₹99"></div>
          <div class="field"><label>Full description (in “Know more”)</label><textarea id="fd" rows="5">${esc(f.details || "")}</textarea></div>
          <div class="field"><label>Highlights (one per line)</label><textarea id="fh" rows="4" placeholder="Food-grade material&#10;Pack of 50&#10;Next-day delivery">${esc(f.highlights || "")}</textarea></div>
          <div class="field"><label>More information link (optional)</label><input id="fl" value="${esc(f.more_link || "")}" placeholder="https://…"></div>
        </div><div>
          <div class="field"><label>Banner image (wide works best; falls back to the product image)</label><input type="file" id="fi" accept="image/*"><div id="fprev"></div></div>
          <div class="field"><label>More photos (shown in “Know more”)</label><input type="file" id="fg" accept="image/*" multiple><div id="gprev" class="row" style="margin-top:.4rem"></div></div>
        </div></div>`,
      footer: `<button class="btn primary" id="go">${f.id ? "Save slide" : "Add slide"}</button>`,
    });
    const drawBanner = () => ($("#fprev", m.el).innerHTML = banner ? `<img src="${esc(banner)}" style="max-height:120px;border-radius:8px;margin-top:.4rem"> <button class="btn sm" id="rmb" type="button">Remove</button>` : "");
    const drawGallery = () => {
      $("#gprev", m.el).innerHTML = gallery.map((u, i) => `<div style="position:relative"><img src="${esc(u)}" style="width:72px;height:72px;object-fit:cover;border-radius:6px"><button class="btn sm" data-rg="${i}" type="button" style="position:absolute;top:2px;right:2px;padding:0 .3rem">×</button></div>`).join("");
      $$("[data-rg]", m.el).forEach((b) => (b.onclick = () => { gallery.splice(Number(b.dataset.rg), 1); drawGallery(); }));
    };
    drawBanner(); drawGallery();
    $("#fprev", m.el).addEventListener("click", (e) => { if (e.target.id === "rmb") { banner = null; drawBanner(); } });
    const busy = (on) => ($("#go", m.el).disabled = on);
    $("#fp", m.el).onchange = (e) => {
      const p = prods.find((x) => x.id === e.target.value);
      if (p && !$("#ftl", m.el).value) $("#ftl", m.el).value = p.name;
      if (p && !$("#fd", m.el).value) $("#fd", m.el).value = p.description || "";
    };
    $("#fi", m.el).onchange = async (e) => { if (!e.target.files[0]) return; busy(true); try { banner = await uploadImage(e.target.files[0], "showcase"); drawBanner(); } finally { busy(false); } };
    $("#fg", m.el).onchange = async (e) => {
      busy(true);
      try { for (const file of e.target.files) gallery.push(await uploadImage(file, "showcase")); drawGallery(); } finally { busy(false); }
    };
    $("#go", m.el).onclick = async () => {
      const title = $("#ftl", m.el).value.trim();
      if (!title) return toast("Headline is required", true);
      const rec = { product_id: $("#fp", m.el).value || null, title, caption: $("#fc", m.el).value.trim() || null, price_label: $("#fpr", m.el).value.trim() || null,
        details: $("#fd", m.el).value.trim() || null, highlights: $("#fh", m.el).value.trim() || null, more_link: $("#fl", m.el).value.trim() || null,
        image_url: banner, gallery };
      if (f.id) await q(sb.from("boh_featured").update(rec).eq("id", f.id)); else await q(sb.from("boh_featured").insert(rec));
      toast(f.id ? "Slide saved" : "Slide added"); m.close(); showcase(el);
    };
  }
}

// ====================================================================== ENQUIRIES (from the slideshow, non-catalogue items)
const ENQ_STATUS = { new: ["New", "warn"], interested: ["Interested", "info"], dropped: ["Dropped interest", "danger"], converted: ["Converted", "ok"] };
export async function enquiries(el) {
  const [rows, rests] = await Promise.all([
    q(sb.from("boh_enquiries").select("*, restaurant:boh_restaurants(name,phone), by:boh_users!boh_enquiries_created_by_fkey(full_name,phone), upd:boh_users!boh_enquiries_updated_by_fkey(full_name), slide:boh_featured(title,price_label)").order("created_at", { ascending: false })),
    q(sb.from("boh_restaurants").select("id,name").order("name")),
  ]);
  const count = (k) => rows.filter((r) => r.status === k).length;
  el.innerHTML = `
    <div class="page-head"><div><h1>Enquiries</h1><div class="muted">Who enquired about what from the slideshow. Enquiries about catalogue products appear under <a href="#/requests">Product requests</a> instead.</div></div>
      <button class="btn" id="csv">⬇ Export CSV</button></div>
    <div class="grid k4" style="margin-bottom:1rem">${Object.entries(ENQ_STATUS).map(([k, [l]]) => `<div class="card stat"><div class="l">${l}</div><div class="v">${count(k)}</div></div>`).join("")}</div>
    <div class="row" style="margin-bottom:.75rem">
      <select id="fs" style="max-width:200px"><option value="">All statuses</option>${Object.entries(ENQ_STATUS).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join("")}</select>
      <select id="fr" style="max-width:240px"><option value="">All restaurants</option>${rests.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("")}</select>
      <input id="fq" placeholder="Search item…" style="max-width:240px"></div>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Restaurant / person</th><th>Enquired about</th><th>Message</th><th>Qty</th><th>Status</th><th>Our note</th></tr></thead><tbody>
    ${rows.map((r) => `<tr data-s="${r.status}" data-r="${r.restaurant_id}" data-q="${esc(r.subject.toLowerCase())}">
      <td class="small">${fmtDT(r.created_at)}</td>
      <td><b>${esc(r.restaurant?.name)}</b><div class="small">${esc(r.by?.full_name || "")} ${r.by?.phone ? "· " + telLinks([r.by.phone]) : r.restaurant?.phone ? "· " + telLinks([r.restaurant.phone]) : ""}</div></td>
      <td><b>${esc(r.subject)}</b>${r.slide?.price_label ? `<div class="small muted">${esc(r.slide.price_label)}</div>` : ""}</td>
      <td class="small">${esc(r.message || "")}</td><td class="small">${esc(r.quantity || "")}</td>
      <td><select data-st="${r.id}" style="min-width:150px">${Object.entries(ENQ_STATUS).map(([k, [l]]) => `<option value="${k}" ${k === r.status ? "selected" : ""}>${l}</option>`).join("")}</select>
        ${r.updated_at ? `<div class="small muted">${esc(r.upd?.full_name || "")} · ${fmtDT(r.updated_at)}</div>` : ""}</td>
      <td><input data-note="${r.id}" value="${esc(r.admin_note || "")}" placeholder="Add note…" style="min-width:160px"></td></tr>`).join("") || '<tr><td colspan="7" class="empty">No enquiries yet.</td></tr>'}
    </tbody></table></div>`;
  const filter = () => $$("tr[data-s]", el).forEach((tr) => tr.classList.toggle("hidden",
    !((!$("#fs").value || tr.dataset.s === $("#fs").value) && (!$("#fr").value || tr.dataset.r === $("#fr").value) && tr.dataset.q.includes($("#fq").value.toLowerCase()))));
  $("#fs").onchange = filter; $("#fr").onchange = filter; $("#fq").oninput = filter;
  const save = async (id, patch) => { await q(sb.from("boh_enquiries").update({ ...patch, updated_by: state.me.id, updated_at: new Date().toISOString() }).eq("id", id)); };
  $$("[data-st]", el).forEach((i) => (i.onchange = async () => { await save(i.dataset.st, { status: i.value }); toast(`Marked ${ENQ_STATUS[i.value][0]}`); refreshCounts(); enquiries(el); }));
  $$("[data-note]", el).forEach((i) => (i.onchange = async () => { await save(i.dataset.note, { admin_note: i.value.trim() || null }); toast("Note saved"); }));
  $("#csv").onclick = () => downloadCSV("enquiries.csv", rows.map((r) => ({ Date: fmtDT(r.created_at), Restaurant: r.restaurant?.name, Person: r.by?.full_name, Phone: r.by?.phone || r.restaurant?.phone || "",
    Item: r.subject, Price: r.slide?.price_label || "", Message: r.message || "", Quantity: r.quantity || "", Status: ENQ_STATUS[r.status][0], Note: r.admin_note || "" })));
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
        <div class="field"><label>Order cut-off for next-day delivery</label><input name="order_cutoff" type="time" value="${s.order_cutoff.slice(0, 5)}"></div>
        <div class="field"><label>Working day starts</label><input name="work_start" type="time" value="${s.work_start.slice(0, 5)}"></div>
        <div class="field"><label>Working day ends</label><input name="work_end" type="time" value="${s.work_end.slice(0, 5)}"></div>
      </div>
      <div class="field"><label>Working days</label><div class="row">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => `<label class="row" style="margin:0;font-weight:400"><input type="checkbox" data-day="${i + 1}" ${s.work_days.includes(i + 1) ? "checked" : ""}> ${d}</label>`).join("")}</div></div>
      <h3>Payment details shown to restaurants</h3>
      <p class="small muted">Restaurants see these when they tap <b>Pay now</b>. Fill in the QR / UPI option, the bank account, or both.</p>
      <div class="grid c2" style="align-items:start">
        <div class="card" style="padding:.8rem"><b>Option 1 — QR code / UPI</b>
          <div class="field" style="margin-top:.5rem"><label>QR code image</label><input type="file" id="qrfile" accept="image/*">
            <div id="qrprev" style="margin-top:.4rem"></div><input type="hidden" name="pay_qr_url" value="${esc(s.pay_qr_url || "")}"></div>
          <div class="field"><label>UPI ID</label><input name="pay_upi_id" value="${esc(s.pay_upi_id || "")}" placeholder="backofhouse@okbank"></div>
        </div>
        <div class="card" style="padding:.8rem;margin-top:0"><b>Option 2 — Bank transfer</b>
          <div class="field" style="margin-top:.5rem"><label>Account holder name</label><input name="bank_account_name" value="${esc(s.bank_account_name || "")}"></div>
          <div class="field"><label>Account number</label><input name="bank_account_no" value="${esc(s.bank_account_no || "")}"></div>
          <div class="form-grid">
            <div class="field"><label>IFSC</label><input name="bank_ifsc" value="${esc(s.bank_ifsc || "")}" style="text-transform:uppercase"></div>
            <div class="field"><label>Bank name</label><input name="bank_name" value="${esc(s.bank_name || "")}"></div>
          </div>
          <div class="field"><label>Branch</label><input name="bank_branch" value="${esc(s.bank_branch || "")}"></div>
        </div>
      </div>
      <div class="field"><label>Other payment notes (optional, e.g. "Cheques in favour of …")</label><textarea name="payment_instructions" rows="2">${esc(s.payment_instructions || "")}</textarea></div>
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
  const qr = () => $('[name="pay_qr_url"]').value;
  const drawQr = () => ($("#qrprev").innerHTML = qr() ? `<img src="${esc(qr())}" style="width:160px;height:160px;object-fit:contain;border:1px solid var(--line);border-radius:8px;background:#fff"> <button class="btn sm" id="qrrm" type="button">Remove</button>` : '<span class="small muted">No QR uploaded</span>');
  drawQr();
  $("#qrprev").addEventListener("click", (e) => { if (e.target.id === "qrrm") { $('[name="pay_qr_url"]').value = ""; drawQr(); } });
  $("#qrfile").onchange = async (e) => {
    if (!e.target.files[0]) return;
    $("#save").disabled = true;
    try { $('[name="pay_qr_url"]').value = await uploadImage(e.target.files[0], "payment"); drawQr(); toast("QR uploaded — click Save settings"); }
    finally { $("#save").disabled = false; }
  };
  $("#save").onclick = async () => {
    const f = formData($("#sf"));
    if (f.bank_ifsc) f.bank_ifsc = f.bank_ifsc.toUpperCase();
    f.work_days = $$("[data-day]:checked", el).map((i) => Number(i.dataset.day));
    f.updated_at = new Date().toISOString();
    const row = await q(sb.from("boh_settings").update(f).eq("id", 1).select().single());
    state.settings = row; toast("Settings saved");
  };
  notificationSettings(el);
}

// ---------------------------------------------------------------- notifications (super admin)
const BOT_FOLDER_URL = "https://github.com/kunalahuja392/back-of-house-co/tree/main/whatsapp-bot";
async function notificationSettings(el) {
  const s = state.settings;
  const [cfgRows, cloudSaved] = await Promise.all([q(sb.rpc("boh_notify_config")), q(sb.rpc("boh_wa_cloud_configured"))]);
  const cfg = cfgRows?.[0] || {};
  const cloud = s.wa_provider === "cloud";
  const online = s.bot_last_seen && Date.now() - new Date(s.bot_last_seen) < 3 * 60000;
  el.insertAdjacentHTML("beforeend", `
    <div class="card" id="nf" style="margin-top:1rem">
      <div class="row between"><h2 style="margin:0">Notifications</h2><a href="#/notifications">View sent messages →</a></div>
      <p class="muted small">Restaurants, coordinators and admins get email and WhatsApp messages for orders, allocations, deadlines, deliveries, payments, requests, enquiries and complaints.
        People only get WhatsApp if their phone number is filled in (Team & logins / restaurant logins).</p>
      <div class="row" style="gap:1.5rem;margin-bottom:.8rem">
        <label class="row" style="margin:0"><input type="checkbox" name="notify_email" ${s.notify_email ? "checked" : ""}> Email notifications</label>
        <label class="row" style="margin:0"><input type="checkbox" name="notify_whatsapp" ${s.notify_whatsapp ? "checked" : ""}> WhatsApp notifications</label>
      </div>
      <div class="grid c2" style="align-items:start">
        <div class="card" style="padding:.8rem;margin-top:0"><b>📧 Email — free via Brevo (300 emails/day)</b>
          <ol class="small muted" style="padding-left:1.1rem;margin:.4rem 0">
            <li>Sign up free at <a href="https://www.brevo.com" target="_blank" rel="noopener">brevo.com</a>.</li>
            <li>Senders, domains & dedicated IPs → Senders → add and verify the email you'll send from.</li>
            <li>SMTP & API → API keys → Generate a new API key, and paste it below.</li>
          </ol>
          <div class="field"><label>Send from (verified in Brevo)</label><input name="email_from" type="email" value="${esc(s.email_from || "")}" placeholder="orders@yourcompany.com"></div>
          <div class="field"><label>Sender name</label><input name="email_from_name" value="${esc(s.email_from_name || s.company_name)}"></div>
          <div class="field"><label>Brevo API key ${cfg.brevo_configured ? '<span class="badge ok">saved</span>' : '<span class="badge warn">not set</span>'}</label>
            <div class="row"><input id="brevo" type="text" name="boh-brevo-key" autocomplete="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-1p-ignore style="flex:1;font-family:monospace"
              placeholder="${cfg.brevo_configured ? "Saved — paste a new key to replace it" : "xkeysib-…"}"><button class="btn primary" id="savebrevo" type="button">Save key</button></div>
            <div class="small muted">Paste the key that starts with <b>xkeysib-</b> (Brevo → SMTP & API → <b>API keys</b> tab, not SMTP).</div></div>
          <div class="row"><input id="testemail" type="email" value="${esc(state.me.email)}" style="flex:1"><button class="btn sm" id="sendtestemail" type="button">Send test email</button></div>
        </div>
        <div class="card" style="padding:.8rem;margin-top:0"><b>💬 WhatsApp</b>
          <div class="row" style="gap:1rem;margin:.4rem 0">
            <label class="row" style="margin:0;font-weight:400"><input type="radio" name="wa_provider" value="cloud" ${cloud ? "checked" : ""}> Official WhatsApp (Meta) <span class="small muted">≈ ₹0.145 / message</span></label>
            <label class="row" style="margin:0;font-weight:400"><input type="radio" name="wa_provider" value="bot" ${cloud ? "" : "checked"}> WhatsApp Web bot <span class="small muted">free, unofficial</span></label></div>
          <div id="wacloud" class="${cloud ? "" : "hidden"}">
            <ol class="small muted" style="padding-left:1.1rem;margin:.4rem 0">
              <li><a href="https://developers.facebook.com/apps/create/" target="_blank" rel="noopener">Meta for Developers</a> → Create app → Business → add <b>WhatsApp</b>.</li>
              <li>WhatsApp → API Setup: add your business phone number and verify it; copy the <b>Phone number ID</b> and <b>WhatsApp Business Account ID</b>.</li>
              <li>Business settings → System users → add an admin user → assign the app and the WhatsApp account → <b>Generate token</b> (never expires, permissions whatsapp_business_messaging + whatsapp_business_management).</li>
              <li>WhatsApp Manager → add a payment method.</li>
              <li>Paste below, Save, then <b>Create message templates</b> and wait for Meta to approve them (minutes to a day).</li>
            </ol>
            <div class="form-grid">
              <div class="field"><label>Phone number ID</label><input name="wa_phone_number_id" value="${esc(s.wa_phone_number_id || "")}" inputmode="numeric"></div>
              <div class="field"><label>WhatsApp Business Account ID</label><input name="wa_waba_id" value="${esc(s.wa_waba_id || "")}" inputmode="numeric"></div>
            </div>
            <div class="field"><label>Permanent access token ${cloudSaved ? '<span class="badge ok">saved</span>' : '<span class="badge warn">not set</span>'}</label>
              <input id="watoken" type="text" name="boh-wa-token" autocomplete="off" spellcheck="false" data-lpignore="true" data-1p-ignore style="font-family:monospace" placeholder="${cloudSaved ? "Saved — paste a new token to replace it" : "EAAG…"}"></div>
            <div class="row"><button class="btn sm" type="button" id="wastatus">Check setup</button><button class="btn sm" type="button" id="watpl">Create message templates</button></div>
            <div id="wainfo" class="small" style="margin-top:.5rem"></div>
          </div>
          <div id="wabot" class="${cloud ? "hidden" : ""}">
          <div style="margin:.4rem 0">${online ? `<span class="badge ok">Bot online</span> <span class="small muted">last seen ${fmtDT(s.bot_last_seen)}</span>`
            : `<span class="badge danger">Bot offline</span> <span class="small muted">${s.bot_last_seen ? "last seen " + fmtDT(s.bot_last_seen) : "never connected"}</span>`}</div>
          <div class="notice small" style="margin:.4rem 0">⚠️ Unofficial — WhatsApp may ban the number. Use a separate business SIM.</div>
          <ol class="small muted" style="padding-left:1.1rem;margin:.4rem 0">
            <li>On a computer that stays on, install Node.js (LTS) from nodejs.org.</li>
            <li>Download the <a href="${BOT_FOLDER_URL}" target="_blank" rel="noopener">whatsapp-bot folder</a> and follow its README.</li>
            <li>Paste this bot key into its config.json, start it and scan the QR with the business phone.</li>
          </ol>
          <div class="field"><label>Bot key</label><div class="row" style="flex-wrap:nowrap"><input id="botkey" type="password" readonly value="${esc(cfg.bot_secret || "")}">
            <button class="btn sm" type="button" id="showkey">👁</button><button class="btn sm" type="button" id="copykey">Copy</button><button class="btn sm" type="button" id="newkey">New key</button></div></div>
          </div>
          <div class="row" style="margin-top:.5rem"><input id="testphone" value="${esc(state.me.phone || "")}" placeholder="WhatsApp number" style="flex:1"><button class="btn sm" id="sendtestwa" type="button">Send test WhatsApp</button></div>
        </div>
      </div>
      <h3 style="margin-top:1rem">📊 Daily report to super admins</h3>
      <p class="small muted">Sales, cost, gross & net profit, overheads, collected today, payments to verify, total due (top restaurants), overdue work, new requests/enquiries/complaints, by-restaurant and month-to-date figures. Goes to every active super admin by email and WhatsApp.</p>
      <div class="form-grid">
        <div class="field"><label>Send every day at</label><input type="time" name="report_time" value="${(s.report_time || "21:00").slice(0, 5)}"></div>
        <div class="field"><label>Also email to (comma separated)</label><input name="report_emails" value="${esc(s.report_emails || "")}" placeholder="partner@x.com, accounts@x.com"></div>
        <div class="field"><label>Also WhatsApp to (comma separated)</label><input name="report_phones" value="${esc(s.report_phones || "")}" placeholder="98xxxxxxxx, 97xxxxxxxx"></div>
      </div>
      <div class="row"><button class="btn" id="preview" type="button">Preview today's report</button><button class="btn" id="sendreport" type="button">Send today's report now</button>
        <span class="grow"></span><button class="btn primary" id="savenf" type="button">Save notification settings</button></div>
    </div>`);
  const nf = $("#nf", el);
  $$("[name=wa_provider]", nf).forEach((r) => (r.onchange = () => {
    const c = $("[name=wa_provider]:checked", nf).value === "cloud";
    $("#wacloud", nf).classList.toggle("hidden", !c); $("#wabot", nf).classList.toggle("hidden", c);
  }));
  const TPL_BADGE = { APPROVED: "ok", PENDING: "warn", REJECTED: "danger", PAUSED: "danger", DISABLED: "danger" };
  const showWa = (d) => {
    const ph = d.phone || {};
    const tpls = Array.isArray(d.templates) ? d.templates : [];
    $("#wainfo", nf).innerHTML = `
      <div>${ph.error ? `<span class="badge danger">Phone</span> ${esc(ph.error)}` : `<span class="badge ok">Phone</span> ${esc(ph.display_phone_number || "")} · ${esc(ph.verified_name || "")}
        ${ph.name_status ? ` · name ${esc(ph.name_status)}` : ""}${ph.quality_rating ? ` · quality ${esc(ph.quality_rating)}` : ""}${ph.messaging_limit_tier ? ` · limit ${esc(ph.messaging_limit_tier)}` : ""}`}</div>
      ${d.error ? `<div style="color:var(--danger)">${esc(d.error)}</div>` : ""}
      ${d.templates?.error ? `<div style="color:var(--danger)">Templates: ${esc(d.templates.error)}</div>` : ""}
      ${(d.created || []).filter((c) => !c.ok).map((c) => `<div style="color:var(--danger)">${esc(c.name)}: ${esc(c.error || "error")}</div>`).join("")}
      <div style="margin-top:.3rem">${["boh_order_update", "boh_team_alert", "boh_daily_report"].map((n) => { const t = tpls.find((x) => x.name === n);
        return `<div>${esc(n)}: ${t ? `<span class="badge ${TPL_BADGE[t.status] || "info"}">${esc(t.status)}</span> ${t.rejected_reason && t.rejected_reason !== "NONE" ? esc(t.rejected_reason) : ""}` : '<span class="badge">not created</span>'}</div>`; }).join("")}</div>`;
  };
  const waCall = async (action) => {
    $("#wainfo", nf).textContent = "Checking with Meta…";
    const { data, error } = await sb.functions.invoke("boh-notify", { body: { action } });
    if (error) { let m = error.message; try { m = (await error.context.json()).error || m; } catch {} $("#wainfo", nf).innerHTML = `<span style="color:var(--danger)">${esc(m)}</span>`; return; }
    showWa(data);
  };
  $("#wastatus", nf).onclick = () => waCall("wa_status");
  $("#watpl", nf).onclick = () => waCall("wa_create_templates");
  $("#showkey", nf).onclick = () => { const i = $("#botkey", nf); i.type = i.type === "password" ? "text" : "password"; };
  $("#copykey", nf).onclick = async () => { try { await navigator.clipboard.writeText($("#botkey", nf).value); toast("Bot key copied"); } catch { toast("Select the key and copy it", true); } };
  $("#newkey", nf).onclick = async () => {
    if (!(await confirmBox("Create a new bot key? The bot stops working until you put the new key in its config.json."))) return;
    $("#botkey", nf).value = await q(sb.rpc("boh_rotate_bot_secret")); $("#botkey", nf).type = "text"; toast("New bot key created");
  };
  // Brevo API keys look like xkeysib-<64 hex>-<16 chars>; catch SMTP keys and browser-autofilled passwords
  const brevoOk = (k) => {
    if (k.startsWith("xsmtpsib-")) { toast("That's the SMTP key. Use the API key (starts with xkeysib-) from Brevo → SMTP & API → API keys.", true); return false; }
    if (!k.startsWith("xkeysib-") || k.length < 40) { toast("That doesn't look like a Brevo API key — it should start with xkeysib- and be about 90 characters long.", true); return false; }
    return true;
  };
  $("#savebrevo", nf).onclick = async () => {
    const k = $("#brevo", nf).value.trim();
    if (!k) return toast("Paste the Brevo API key first", true);
    if (!brevoOk(k)) return;
    await q(sb.rpc("boh_set_notify_secret", { p_key: "brevo_api_key", p_value: k }));
    $("#brevo", nf).value = ""; toast("Brevo key saved — now click Send test email");
    sb.functions.invoke("boh-notify", { body: {} }).catch(() => {});
  };
  $("#savenf", nf).onclick = async () => {
    const f = formData(nf);
    const patch = { notify_email: f.notify_email, notify_whatsapp: f.notify_whatsapp, email_from: f.email_from, email_from_name: f.email_from_name,
      wa_provider: $("[name=wa_provider]:checked", nf).value, wa_phone_number_id: (f.wa_phone_number_id || "").trim() || null, wa_waba_id: (f.wa_waba_id || "").trim() || null,
      report_time: f.report_time || "21:00", report_emails: f.report_emails, report_phones: f.report_phones, updated_at: new Date().toISOString() };
    const row = await q(sb.from("boh_settings").update(patch).eq("id", 1).select().single());
    state.settings = row;
    const key = $("#brevo", nf).value.trim();
    if (key) { if (!brevoOk(key)) return; await q(sb.rpc("boh_set_notify_secret", { p_key: "brevo_api_key", p_value: key })); $("#brevo", nf).value = ""; }
    const wt = $("#watoken", nf).value.trim();
    if (wt) { await q(sb.rpc("boh_set_notify_secret", { p_key: "wa_cloud_token", p_value: wt })); $("#watoken", nf).value = ""; }
    toast("Notification settings saved"); settings(el);
  };
  const sendNow = () => sb.functions.invoke("boh-notify", { body: {} }).catch(() => {});
  $("#sendtestemail", nf).onclick = async () => {
    await q(sb.rpc("boh_test_notification", { p_channel: "email", p_address: $("#testemail", nf).value }));
    const { data } = await sb.functions.invoke("boh-notify", { body: {} });
    if (data && data.configured === false) toast("Test queued — it will send once the Brevo key and sender email are saved", true);
    else toast("Test email sent — check the inbox (and spam)");
  };
  $("#sendtestwa", nf).onclick = async () => {
    await q(sb.rpc("boh_test_notification", { p_channel: "whatsapp", p_address: $("#testphone", nf).value }));
    if (cloud) { sendNow(); toast("Test WhatsApp sent through Meta — check the phone (needs approved templates)"); }
    else toast(online ? "Test WhatsApp queued — it should arrive within a minute" : "Test queued — it will send when the bot is online");
  };
  $("#preview", nf).onclick = async () => {
    const text = await q(sb.rpc("boh_report_preview", {}));
    modal({ title: "Today's report (preview)", body: `<div style="white-space:pre-wrap;font-size:13px">${esc(text).replace(/\*([^*\n]+)\*/g, "<b>$1</b>")}</div>` });
  };
  $("#sendreport", nf).onclick = async () => {
    const n = await q(sb.rpc("boh_send_daily_report", { p_day: null, p_force: true }));
    sendNow(); toast(n ? `Report queued to ${n} recipient(s)` : "No recipients — add phone/email to super admins or the extra lists", !n);
  };
}

// ====================================================================== NOTIFICATIONS LOG (staff)
export async function notifications(el) {
  el.innerHTML = `
    <div class="page-head"><div><h1>Notifications</h1><div class="muted">Every email and WhatsApp message the system has queued or sent.</div></div>
      <div class="row"><button class="btn" id="sendnow">Send pending emails now</button>${isSuper() ? '<a class="btn" href="#/settings">Notification settings</a>' : ""}</div></div>
    <div class="grid k4" id="nstats" style="margin-bottom:1rem"></div>
    <div class="row" style="margin-bottom:.75rem">
      <select id="fs" style="max-width:180px"><option value="">All statuses</option><option value="pending">Waiting</option><option value="sent">Sent</option><option value="failed">Failed</option></select>
      <select id="fc" style="max-width:180px"><option value="">Email & WhatsApp</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option></select>
      <input id="fq" placeholder="Search name / number / text…" style="max-width:260px"></div>
    <div id="nlist"></div>`;
  const load = async () => {
    let qq = sb.from("boh_notifications").select("*").order("id", { ascending: false }).limit(300);
    if ($("#fs").value === "pending") qq = qq.in("status", ["pending", "sending"]); else if ($("#fs").value) qq = qq.eq("status", $("#fs").value);
    if ($("#fc").value) qq = qq.eq("channel", $("#fc").value);
    const rows = await q(qq);
    const t = $("#fq").value.toLowerCase();
    const list = t ? rows.filter((r) => `${r.name || ""} ${r.address} ${r.subject || ""} ${r.body}`.toLowerCase().includes(t)) : rows;
    const c = (st) => rows.filter((r) => (st === "pending" ? ["pending", "sending"].includes(r.status) : r.status === st)).length;
    $("#nstats").innerHTML = `<div class="card stat"><div class="l">Waiting</div><div class="v">${c("pending")}</div></div>
      <div class="card stat"><div class="l">Sent</div><div class="v">${c("sent")}</div></div>
      <div class="card stat"><div class="l">Failed</div><div class="v" style="color:var(--danger)">${c("failed")}</div></div>
      <div class="card stat"><div class="l">WhatsApp bot</div><div class="v" style="font-size:1rem">${state.settings.bot_last_seen && Date.now() - new Date(state.settings.bot_last_seen) < 180000 ? '<span class="badge ok">online</span>' : '<span class="badge danger">offline</span>'}</div></div>`;
    const badge = (st) => ({ pending: '<span class="badge warn">Waiting</span>', sending: '<span class="badge info">Sending</span>', sent: '<span class="badge ok">Sent</span>', failed: '<span class="badge danger">Failed</span>', skipped: '<span class="badge">Skipped</span>' }[st] || st);
    $("#nlist").innerHTML = `<div class="table-wrap"><table><thead><tr><th>When</th><th>Via</th><th>To</th><th>Message</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((r) => `<tr><td class="small">${fmtDT(r.created_at)}${r.sent_at ? `<div class="muted">sent ${fmtDT(r.sent_at)}</div>` : ""}</td>
        <td>${r.channel === "email" ? "📧" : "💬"}</td>
        <td><b>${esc(r.name || "")}</b><div class="small muted">${esc(r.address)}</div></td>
        <td class="small"><span class="badge">${esc(r.event)}</span> ${esc((r.subject || r.body.split("\n")[0]).replace(/\*/g, "")).slice(0, 120)}
          <details><summary class="muted">full text</summary><div style="white-space:pre-wrap">${esc(r.body)}</div></details></td>
        <td>${badge(r.status)}${r.error ? `<div class="small" style="color:var(--danger)">${esc(r.error).slice(0, 140)}</div>` : ""}</td>
        <td>${r.status === "failed" ? `<button class="btn sm" data-retry="${r.id}">Retry</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="6" class="empty">Nothing yet.</td></tr>'}
      </tbody></table></div>`;
    $$("[data-retry]", el).forEach((b) => (b.onclick = async () => { await q(sb.rpc("boh_retry_notification", { p_id: Number(b.dataset.retry) })); toast("Queued again"); load(); }));
  };
  $("#fs").onchange = load; $("#fc").onchange = load; $("#fq").oninput = load;
  $("#sendnow").onclick = async () => {
    const { data, error } = await sb.functions.invoke("boh-notify", { body: {} });
    if (error) return toast(error.message, true);
    toast(data.configured === false ? data.message : `Sent ${data.sent}, failed ${data.failed}`, data.configured === false);
    load();
  };
  load();
}
