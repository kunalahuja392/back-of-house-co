import { sb, state, $, $$, esc, money, num, fmtDT, fmtD, toast, modal, confirmBox, q, statusBadge, telLinks, payBadge, PAY_MODE } from "./lib.js?v=11";

const CART_KEY = () => "boh_cart_" + state.me.restaurant_id;
const loadCart = () => { try { return JSON.parse(localStorage.getItem(CART_KEY()) || "{}"); } catch { return {}; } };
const saveCart = (c) => { try { localStorage.setItem(CART_KEY(), JSON.stringify(c)); } catch {} };

let catalogCache = null;
async function myCatalog(force = false) {
  if (!catalogCache || force) catalogCache = await q(sb.rpc("boh_my_catalog"));
  return catalogCache;
}

function cutoffInfo() {
  const s = state.settings;
  const ist = new Date(Date.now() + 330 * 60000);
  const [h, m] = s.order_cutoff.split(":").map(Number);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const cut = h * 60 + m;
  const fmtCut = new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  const dayAfter = (n) => new Date(ist.getTime() + n * 86400000).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
  if (mins < cut) {
    const left = cut - mins;
    return { open: true, html: `⏰ Order in the next <b>${Math.floor(left / 60)}h ${left % 60}m</b> (before ${fmtCut}) for delivery <b>tomorrow, ${dayAfter(1)}</b>.` };
  }
  return { open: false, html: `Today's ${fmtCut} cut-off has passed — orders placed now are delivered on <b>${dayAfter(2)}</b>.` };
}

// ====================================================================== HOME
export async function home(el) {
  const [slides, orders, cat] = await Promise.all([
    q(sb.from("boh_featured").select("*, product:boh_products(id,name,image_url,description,unit,brand)").eq("active", true)),
    q(sb.from("boh_orders").select("*").order("created_at", { ascending: false }).limit(50)),
    myCatalog(true),
  ]);
  const unpaid = unpaidBanner(orders);
  const open = orders.filter((o) => !["paid", "cancelled"].includes(o.status)).slice(0, 3);
  const coords = await Promise.all(open.map((o) => q(sb.rpc("boh_order_coordinators", { p_order: o.id }))));
  const ci = cutoffInfo();
  el.innerHTML = `
    <div id="slides"></div>
    <div class="page-head"><div><h1>Hello, ${esc(state.me.restaurant?.name || state.me.full_name)}</h1></div>
      <a class="btn primary" href="#/order">🛒 Place today's order</a></div>
    <div class="notice ${ci.open ? "green" : ""}">${ci.html}</div>
    ${unpaid ? unpaid.replace("</div>", ' <a href="#/myorders">Go to my orders →</a></div>') : ""}
    <div class="grid c2">
      <div class="card"><h2>Your coordinators</h2>
        ${open.length ? open.map((o, i) => `<div style="margin-bottom:.6rem"><b>Order #${o.order_no}</b> <span class="small muted">delivery ${fmtD(o.delivery_date)}</span>
          ${coords[i].length ? coords[i].map((c) => `<div class="small">${esc(c.category_name)}: <b>${esc(c.full_name)}</b> 📞 ${telLinks([c.phone])}</div>`).join("")
            : '<div class="small muted">A coordinator will be assigned shortly.</div>'}</div>`).join("")
          : `<div class="muted">When you place an order, the coordinator handling it will appear here with their number.</div>`}
        ${state.settings.support_phone ? `<div class="small" style="margin-top:.75rem">Support: ${telLinks([state.settings.support_phone])}</div>` : ""}
      </div>
      <div class="card"><h2>Your ordering list</h2>
        <div class="stat"><div class="v">${cat.length}</div><div class="l">products ready to order</div></div>
        <div class="row" style="margin-top:.5rem"><a class="btn" href="#/browse">Browse more products</a></div></div>
    </div>
    <div class="card"><div class="row between"><h2>Recent orders</h2><a href="#/myorders">See all</a></div>
      ${orders.length ? `<table><tbody>${orders.slice(0, 5).map((o) => `<tr><td><b>#${o.order_no}</b></td><td>${fmtDT(o.created_at)}</td><td>Delivery ${fmtD(o.delivery_date)}</td><td class="right">${money(o.total)}</td><td>${statusBadge(o.status)}</td><td>${payBadge(o)}</td></tr>`).join("")}</tbody></table>`
        : `<div class="empty">No orders yet.</div>`}</div>`;
  renderSlides($("#slides", el), slides, cat);
}

function renderSlides(box, slides, cat) {
  slides = slides.filter((s) => s.image_url || s.product?.image_url || s.title);
  if (!slides.length) { box.remove(); return; }
  // random order each visit
  for (let i = slides.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [slides[i], slides[j]] = [slides[j], slides[i]]; }
  box.className = "slides";
  box.innerHTML = slides.map((s, i) => `<div class="slide ${i === 0 ? "on" : ""}" data-i="${i}">
      ${s.image_url || s.product?.image_url ? `<img src="${esc(s.image_url || s.product.image_url)}" alt="">` : ""}
      <div class="cap"><div class="small" style="opacity:.8">NEW FROM BACK OF HOUSE CO</div><h2>${esc(s.title)}</h2><div>${esc(s.caption || "")}</div></div></div>`).join("")
    + `<div class="dots">${slides.map((_, i) => `<span class="${i === 0 ? "on" : ""}"></span>`).join("")}</div>`;
  let cur = 0;
  const show = (n) => {
    cur = n;
    $$(".slide", box).forEach((s, i) => s.classList.toggle("on", i === n));
    $$(".dots span", box).forEach((s, i) => s.classList.toggle("on", i === n));
  };
  if (slides.length > 1) {
    const timer = setInterval(() => {
      if (!document.body.contains(box)) return clearInterval(timer);
      let n = Math.floor(Math.random() * slides.length);
      if (n === cur) n = (n + 1) % slides.length;
      show(n);
    }, 5000);
  }
  box.onclick = () => {
    const s = slides[cur];
    if (s.product) productDetail(s.product, cat, s);
  };
}

async function productDetail(p, cat, slide) {
  const onList = cat.find((c) => c.product_id === p.id);
  const pending = await q(sb.from("boh_product_requests").select("id").eq("product_id", p.id).eq("status", "pending"));
  const img = slide?.image_url || p.image_url;
  const m = modal({
    title: p.name,
    body: `${img ? `<img src="${esc(img)}" style="width:100%;max-height:300px;object-fit:cover;border-radius:10px;margin-bottom:1rem">` : ""}
      <div class="row">${p.brand ? `<span class="badge">${esc(p.brand)}</span>` : ""}<span class="badge">per ${esc(p.unit || "")}</span></div>
      <p>${esc(p.description || slide?.caption || "")}</p>
      ${onList ? `<div class="notice green">This product is already on your ordering list at ${money(onList.price)} / ${esc(onList.unit)}.</div>`
        : pending.length ? `<div class="notice">You've already requested this product — our team will get back to you.</div>`
        : `<div class="field"><label>Anything we should know? (expected quantity, brand, etc.)</label><textarea id="rn" rows="2"></textarea></div>`}`,
    footer: onList ? `<a class="btn primary" href="#/order">Order now</a>` : pending.length ? "" : `<button class="btn accent" id="req">Request this product</button>`,
  });
  $("a", m.el)?.addEventListener("click", m.close);
  const r = $("#req", m.el);
  if (r) r.onclick = async () => {
    await q(sb.from("boh_product_requests").insert({ restaurant_id: state.me.restaurant_id, product_id: p.id, note: $("#rn", m.el).value || null, requested_by: state.me.id }));
    toast("Request sent — our team will approve and add it to your list"); m.close();
  };
}

// ====================================================================== PLACE ORDER
export async function placeOrder(el) {
  const cat = await myCatalog(true);
  let cart = loadCart();
  // drop anything no longer on the list
  Object.keys(cart).forEach((k) => { if (!cat.find((c) => c.product_id === k)) delete cart[k]; });
  const cats = [...new Map(cat.map((c) => [c.category_id, c.category_name])).entries()];
  const ci = cutoffInfo();
  const VKEY = "boh_order_view";
  const view = () => { try { return localStorage.getItem(VKEY) || "grid"; } catch { return "grid"; } };
  el.innerHTML = `
    <div class="page-head"><div><h1>Place order</h1><div class="muted">Your ordering list with your prices. Enter quantities and review.</div></div>
      <div class="row"><button class="btn" id="repeat">↻ Repeat last order</button><button class="btn" id="clear">Clear</button></div></div>
    <div class="notice ${ci.open ? "green" : ""}">${ci.html}</div>
    ${cat.length ? `
    <div class="row" style="margin-bottom:.75rem"><input id="s" placeholder="Search your list…" style="max-width:320px">
      <select id="c" style="max-width:240px"><option value="">All categories</option>${cats.map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join("")}</select>
      <label class="row" style="margin:0"><input type="checkbox" id="only"> Show only items in cart</label>
      <span class="grow"></span>
      <div class="seg"><button data-view="grid" class="${view() === "grid" ? "on" : ""}">▦ Photos</button><button data-view="list" class="${view() === "list" ? "on" : ""}">☰ List</button></div></div>
    <div class="olist ${view()}" id="olist">
      ${cat.map((p) => `<div class="item" data-id="${p.product_id}" data-n="${esc((p.product_name + " " + (p.brand || "")).toLowerCase())}" data-c="${p.category_id}">
        <div class="pic" ${p.image_url ? `style="background-image:url('${esc(p.image_url)}')"` : ""}>${p.image_url ? "" : "📦"}</div>
        <div class="nm"><b>${esc(p.product_name)}</b>${p.brand ? ` <span class="small muted">${esc(p.brand)}</span>` : ""}<div class="small muted">${esc(p.category_name)}</div></div>
        <div class="pr">${p.price == null ? '<span class="small muted">Price on request</span>' : money(p.price) + ` <span class="small muted">/${esc(p.unit)}</span>`}</div>
        <div class="qty"><button class="btn sm" data-dec>−</button><input type="number" min="0" step="any" data-q value="${cart[p.product_id] || ""}" ${p.price == null ? "disabled" : ""}><button class="btn sm" data-inc>+</button></div>
        <div class="amt" data-amt></div></div>`).join("")}
    </div>
    <div class="cart-bar"><div><b id="cnt">0</b> items · <b id="tot">₹0</b> <span class="small" style="opacity:.7">(prices excl. taxes if applicable)</span></div>
      <button class="btn accent" id="review">Review & place order →</button></div>`
    : `<div class="card empty">Your ordering list is being set up by our team. You can <a href="#/browse">browse products</a> and request what you need.</div>`}`;
  if (!cat.length) return;

  const byId = Object.fromEntries(cat.map((c) => [c.product_id, c]));
  const recalc = () => {
    let cnt = 0, tot = 0;
    $$(".item[data-id]", el).forEach((tr) => {
      const v = Number($("[data-q]", tr).value) || 0;
      const p = byId[tr.dataset.id];
      if (v > 0) { cart[tr.dataset.id] = v; cnt++; tot += v * Number(p.price || 0); } else delete cart[tr.dataset.id];
      $("[data-amt]", tr).textContent = v > 0 ? money(v * Number(p.price || 0)) : "";
      tr.classList.toggle("has", v > 0);
    });
    $("#cnt").textContent = cnt; $("#tot").textContent = money(tot);
    saveCart(cart);
  };
  const filter = () => {
    const s = $("#s").value.toLowerCase(), c = $("#c").value, only = $("#only").checked;
    $$(".item[data-id]", el).forEach((tr) => tr.classList.toggle("hidden", !(tr.dataset.n.includes(s) && (!c || tr.dataset.c === c) && (!only || cart[tr.dataset.id]))));
  };
  $$(".item[data-id]", el).forEach((tr) => {
    const inp = $("[data-q]", tr);
    inp.oninput = recalc;
    $("[data-inc]", tr).onclick = () => { if (!inp.disabled) { inp.value = (Number(inp.value) || 0) + 1; recalc(); } };
    $("[data-dec]", tr).onclick = () => { inp.value = Math.max(0, (Number(inp.value) || 0) - 1) || ""; recalc(); };
  });
  $("#s").oninput = filter; $("#c").onchange = filter; $("#only").onchange = filter;
  $$("[data-view]", el).forEach((b) => (b.onclick = () => {
    try { localStorage.setItem(VKEY, b.dataset.view); } catch {}
    $("#olist").className = "olist " + b.dataset.view;
    $$("[data-view]", el).forEach((x) => x.classList.toggle("on", x === b));
  }));
  $("#clear").onclick = () => { $$("[data-q]", el).forEach((i) => (i.value = "")); recalc(); };
  $("#repeat").onclick = async () => {
    const last = await q(sb.from("boh_orders").select("id,order_no").neq("status", "cancelled").order("created_at", { ascending: false }).limit(1));
    if (!last.length) return toast("No previous order yet", true);
    const lines = await q(sb.rpc("boh_order_lines", { p_order: last[0].id }));
    let n = 0;
    lines.forEach((l) => { const tr = $(`.item[data-id="${l.product_id}"]`, el); if (tr && !$("[data-q]", tr).disabled) { $("[data-q]", tr).value = Number(l.qty); n++; } });
    recalc(); toast(`Filled ${n} items from order #${last[0].order_no}`);
  };
  $("#review").onclick = () => {
    const items = Object.entries(cart).filter(([, v]) => v > 0).map(([id, qty]) => ({ product_id: id, qty, p: byId[id] }));
    if (!items.length) return toast("Add quantities first", true);
    const total = items.reduce((a, i) => a + i.qty * Number(i.p.price), 0);
    const m = modal({
      title: "Review your order",
      body: `<div class="notice ${cutoffInfo().open ? "green" : ""}">${cutoffInfo().html}</div>
        <table><thead><tr><th>Product</th><th class="right">Qty</th><th class="right">Price</th><th class="right">Amount</th></tr></thead><tbody>
        ${items.map((i) => `<tr><td>${esc(i.p.product_name)}</td><td class="right">${num(i.qty, 3)} ${esc(i.p.unit)}</td><td class="right">${money(i.p.price)}</td><td class="right">${money(i.qty * i.p.price)}</td></tr>`).join("")}
        <tr><td colspan="3"><b>Total</b></td><td class="right"><b>${money(total)}</b></td></tr></tbody></table>
        <div class="field" style="margin-top:1rem"><label>How will you pay? *</label>
          <div class="row">
            <label class="paymode"><input type="radio" name="pm" value="cod" checked> <span><b>Pay on delivery</b><br><span class="small muted">Pay when the goods arrive</span></span></label>
            <label class="paymode"><input type="radio" name="pm" value="prepaid"> <span><b>Pre-pay</b><br><span class="small muted">Pay now, before delivery</span></span></label>
          </div></div>
        <div class="field"><label>Note for our team (optional)</label><textarea id="nt" rows="2" placeholder="e.g. deliver before 9 AM, call on arrival"></textarea></div>`,
      footer: `<button class="btn" id="back">Edit</button><button class="btn primary" id="place">Confirm order</button>`,
    });
    $("#back", m.el).onclick = m.close;
    $("#place", m.el).onclick = async (e) => {
      e.target.disabled = true;
      try {
        const mode = $('[name="pm"]:checked', m.el).value;
        const oid = await q(sb.rpc("boh_place_order", { p_items: items.map(({ product_id, qty }) => ({ product_id, qty })), p_notes: $("#nt", m.el).value || null, p_payment_mode: mode }));
        cart = {}; saveCart(cart); m.close();
        toast("Order placed! Your coordinator will take it from here.");
        location.hash = "#/myorders";
        if (mode === "prepaid") {
          const o = await q(sb.from("boh_orders").select("*").eq("id", oid).single());
          payNow(o, () => window.dispatchEvent(new HashChangeEvent("hashchange")));
        }
      } catch { e.target.disabled = false; }
    };
  };
  recalc();
}

// ====================================================================== PAYMENT
function unpaidBanner(orders) {
  const due = orders.filter((o) => o.status !== "cancelled" && o.payment_status === "unpaid" && (o.payment_mode === "prepaid" || ["delivered", "paid"].includes(o.status)));
  if (!due.length) return "";
  const rej = due.filter((o) => o.payment_rejected_note).length;
  return `<div class="notice" style="background:#fbeeed;border-color:#efc5c1;color:#8a2a23">💳 <b>${money(due.reduce((a, o) => a + Number(o.total), 0))} unpaid</b> across ${due.length} order${due.length > 1 ? "s" : ""}${rej ? ` (${rej} payment${rej > 1 ? "s" : ""} rejected — please check)` : ""}. Please pay and tap <b>Pay now → I've already paid</b>.</div>`;
}

function payInstructions() {
  const t = (state.settings.payment_instructions || "").trim();
  return t ? `<div class="card" style="padding:.75rem;white-space:pre-wrap">${esc(t)}</div>`
    : `<div class="muted">Please contact your coordinator or ${state.settings.support_phone ? "call " + esc(state.settings.support_phone) : "our team"} for payment details.</div>`;
}

// "Pay now": shows how to pay, and lets the restaurant say "I've already paid" with a reference
export function payNow(o, done) {
  const m = modal({
    title: `Pay for order #${o.order_no} — ${money(o.total)}`,
    body: `${o.payment_rejected_note ? `<div class="notice" style="background:#fbeeed;border-color:#efc5c1;color:#8a2a23"><b>Your last payment was not approved:</b> ${esc(o.payment_rejected_note)}</div>` : ""}
      <h3>How to pay</h3>${payInstructions()}
      <h3 style="margin-top:1rem">Already paid?</h3>
      <p class="small muted">Enter the UPI / bank transaction ID (UTR), or cheque number. Our team will check and confirm it.</p>
      <div class="field"><label>Payment reference *</label><input id="ref" placeholder="e.g. UTR 4123 5678 9012"></div>`,
    footer: `<button class="btn" id="later">Pay later</button><button class="btn primary" id="paid">I've already paid</button>`,
  });
  $("#later", m.el).onclick = m.close;
  $("#paid", m.el).onclick = async () => {
    const ref = $("#ref", m.el).value.trim();
    if (!ref) return toast("Enter the payment reference", true);
    await q(sb.rpc("boh_claim_payment", { p_order: o.id, p_ref: ref }));
    toast("Thanks! Payment is under approval."); m.close(); done?.();
  };
}

// ====================================================================== MY ORDERS
const CUST_STEPS = [["created_at", "Order placed"], ["allocated_at", "Coordinator assigned"], ["acknowledged_at", "Acknowledged"], ["vendor_ordered_at", "Being procured"], ["delivered_at", "Delivered"], ["paid_at", "Payment received"]];

export async function myOrders(el) {
  const orders = await q(sb.from("boh_orders").select("*").order("created_at", { ascending: false }).limit(200));
  el.innerHTML = `
    <div class="page-head"><h1>My orders</h1><a class="btn primary" href="#/order">+ New order</a></div>
    ${unpaidBanner(orders)}
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Placed</th><th>Delivery</th><th class="right">Total</th><th>Order status</th><th>Payment</th><th></th></tr></thead><tbody>
    ${orders.map((o) => `<tr><td><b>${o.order_no}</b></td><td>${fmtDT(o.created_at)}</td><td>${fmtD(o.delivery_date)}</td><td class="right">${money(o.total)}</td><td>${statusBadge(o.status)}</td>
      <td>${payBadge(o)}<div class="small muted">${PAY_MODE[o.payment_mode] || ""}</div>${o.payment_status === "unpaid" && o.payment_rejected_note ? `<div class="small" style="color:var(--danger)">${esc(o.payment_rejected_note)}</div>` : ""}</td>
      <td class="right" style="white-space:nowrap">${o.status !== "cancelled" && o.payment_status === "unpaid" ? `<button class="btn sm accent" data-pay="${o.id}">Pay now</button> ` : ""}<button class="btn sm" data-v="${o.id}">View</button></td></tr>`).join("") || '<tr><td colspan="7" class="empty">No orders yet.</td></tr>'}
    </tbody></table></div>`;
  const reload = () => myOrders(el);
  $$("[data-pay]", el).forEach((b) => (b.onclick = () => payNow(orders.find((x) => x.id === b.dataset.pay), reload)));
  $$("[data-v]", el).forEach((b) => (b.onclick = async () => {
    const o = orders.find((x) => x.id === b.dataset.v);
    const [lines, coords] = await Promise.all([q(sb.rpc("boh_order_lines", { p_order: o.id })), q(sb.rpc("boh_order_coordinators", { p_order: o.id }))]);
    const m = modal({
      title: `Order #${o.order_no}`,
      body: `<div class="row" style="margin-bottom:1rem">${statusBadge(o.status)} ${payBadge(o)}<span class="muted">${PAY_MODE[o.payment_mode] || ""} · Delivery ${fmtD(o.delivery_date)}</span></div>
        ${o.payment_status === "under_review" ? `<div class="notice">You told us you paid (ref <b>${esc(o.payment_claim_ref)}</b>). Our team is checking it.</div>` : ""}
        ${o.payment_status === "unpaid" && o.payment_rejected_note ? `<div class="notice" style="background:#fbeeed;border-color:#efc5c1;color:#8a2a23"><b>Not paid:</b> your payment could not be approved — ${esc(o.payment_rejected_note)}</div>` : ""}
        <div class="steps" style="margin-bottom:1rem">${CUST_STEPS.map(([k, l]) => `<div class="step ${o[k] ? "done" : ""}"><span class="dot"></span><div>${l}</div><div class="small muted">${o[k] ? fmtDT(o[k]) : ""}</div></div>`).join("")}</div>
        ${coords.length ? `<div class="card" style="padding:.7rem;margin-bottom:1rem"><b>Your coordinators</b>${coords.map((c) => `<div class="small">${esc(c.category_name)}: ${esc(c.full_name)} 📞 ${telLinks([c.phone])}</div>`).join("")}</div>` : ""}
        <table><thead><tr><th>Product</th><th class="right">Qty</th><th class="right">Price</th><th class="right">Amount</th></tr></thead><tbody>
        ${lines.map((l) => `<tr><td>${esc(l.product_name)}</td><td class="right">${num(l.qty, 3)} ${esc(l.unit)}</td><td class="right">${money(l.unit_price)}</td><td class="right">${money(l.line_total)}</td></tr>`).join("")}
        <tr><td colspan="3"><b>Total</b></td><td class="right"><b>${money(o.total)}</b></td></tr></tbody></table>
        ${o.notes ? `<p class="small muted">Your note: ${esc(o.notes)}</p>` : ""}`,
      footer: `<button class="btn" id="cmp">Raise a complaint</button>${o.status !== "cancelled" && o.payment_status === "unpaid" ? '<button class="btn accent" id="paynow">Pay now</button>' : ""}`,
    });
    $("#cmp", m.el).onclick = () => { m.close(); complaintForm(o.id, () => (location.hash = "#/complaints")); };
    $("#paynow", m.el)?.addEventListener("click", () => { m.close(); payNow(o, reload); });
  }));
}

// ====================================================================== BROWSE & REQUEST
export async function browse(el) {
  const [prods, cats, cat, reqs] = await Promise.all([
    q(sb.from("boh_products").select("id,name,unit,brand,description,image_url,show_image,category_id").eq("active", true).order("name")),
    q(sb.from("boh_categories").select("id,name").eq("active", true).order("sort")),
    myCatalog(true),
    q(sb.from("boh_product_requests").select("*, product:boh_products(name)").order("created_at", { ascending: false })),
  ]);
  prods.forEach((p) => { if (!p.show_image) p.image_url = null; });
  const onList = new Set(cat.map((c) => c.product_id));
  const pending = new Set(reqs.filter((r) => r.status === "pending").map((r) => r.product_id));
  el.innerHTML = `
    <div class="page-head"><div><h1>Browse & request</h1><div class="muted">Everything we supply. Items not on your ordering list can be requested — our team approves and adds them with your price.</div></div>
      <button class="btn accent" id="newitem">Request an item not listed</button></div>
    <div class="row" style="margin-bottom:.75rem"><input id="s" placeholder="Search products…" style="max-width:320px">
      <select id="c" style="max-width:240px"><option value="">All categories</option>${cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></div>
    <div class="prod-grid">${prods.map((p) => `<div class="prod" data-n="${esc((p.name + " " + (p.brand || "")).toLowerCase())}" data-c="${p.category_id}">
      <div class="img" style="${p.image_url ? `background-image:url('${esc(p.image_url)}')` : ""}">${p.image_url ? "" : "📦"}</div>
      <div class="b"><b>${esc(p.name)}</b><div class="small muted">${esc([p.brand, "per " + p.unit].filter(Boolean).join(" · "))}</div><span class="grow"></span>
        ${onList.has(p.id) ? '<span class="badge ok">On your list</span>' : pending.has(p.id) ? '<span class="badge warn">Requested</span>' : `<button class="btn sm" data-p="${p.id}">Details & request</button>`}</div></div>`).join("")}</div>
    <div class="card" style="margin-top:1.25rem"><h2>My requests</h2>
      ${reqs.length ? `<table><thead><tr><th>When</th><th>Item</th><th>Status</th><th>Our note</th></tr></thead><tbody>${reqs.map((r) => `<tr><td>${fmtDT(r.created_at)}</td><td>${esc(r.product?.name || r.item_name)}</td>
        <td><span class="badge ${r.status === "approved" ? "ok" : r.status === "rejected" ? "danger" : "warn"}">${r.status}</span></td><td class="small">${esc(r.admin_note || "")}</td></tr>`).join("")}</tbody></table>` : '<div class="muted">No requests yet.</div>'}</div>`;
  const filter = () => $$(".prod", el).forEach((d) => d.classList.toggle("hidden", !(d.dataset.n.includes($("#s").value.toLowerCase()) && (!$("#c").value || d.dataset.c === $("#c").value))));
  $("#s").oninput = filter; $("#c").onchange = filter;
  $$("[data-p]", el).forEach((b) => (b.onclick = () => productDetail(prods.find((p) => p.id === b.dataset.p), cat)));
  $("#newitem").onclick = () => {
    const m = modal({
      title: "Request an item",
      body: `<p class="muted">Tell us what you buy today that you'd like us to supply — anything from raw material to cleaning supplies or machines.</p>
        <div class="field"><label>Item name *</label><input id="in"></div>
        <div class="field"><label>Details (brand, pack size, monthly quantity)</label><textarea id="id" rows="3"></textarea></div>`,
      footer: `<button class="btn primary" id="go">Send request</button>`,
    });
    $("#go", m.el).onclick = async () => {
      if (!$("#in", m.el).value.trim()) return toast("Item name is required", true);
      await q(sb.from("boh_product_requests").insert({ restaurant_id: state.me.restaurant_id, item_name: $("#in", m.el).value.trim(), note: $("#id", m.el).value || null, requested_by: state.me.id }));
      toast("Request sent"); m.close(); browse(el);
    };
  };
}

// ====================================================================== COMPLAINTS
async function complaintForm(orderId, done) {
  const orders = await q(sb.from("boh_orders").select("id,order_no,created_at").order("created_at", { ascending: false }).limit(30));
  const m = modal({
    title: "Raise a complaint",
    body: `<div class="form-grid">
        <div class="field"><label>Order</label><select id="co"><option value="">General (not order-specific)</option>${orders.map((o) => `<option value="${o.id}" ${o.id === orderId ? "selected" : ""}>#${o.order_no} · ${fmtD(o.created_at)}</option>`).join("")}</select></div>
        <div class="field"><label>Type</label><select id="ct">${["Quality", "Short / missing items", "Wrong item", "Late delivery", "Damaged", "Billing", "Coordinator", "Other"].map((t) => `<option>${t}</option>`).join("")}</select></div></div>
      <div class="field"><label>Subject *</label><input id="cs"></div>
      <div class="field"><label>Details</label><textarea id="cd" rows="4"></textarea></div>`,
    footer: `<button class="btn primary" id="go">Submit complaint</button>`,
  });
  $("#go", m.el).onclick = async () => {
    if (!$("#cs", m.el).value.trim()) return toast("Subject is required", true);
    await q(sb.from("boh_complaints").insert({ restaurant_id: state.me.restaurant_id, order_id: $("#co", m.el).value || null, category: $("#ct", m.el).value,
      subject: $("#cs", m.el).value.trim(), description: $("#cd", m.el).value || null, created_by: state.me.id }));
    toast("Complaint registered — we'll get back to you"); m.close(); done?.();
  };
}

export async function complaints(el) {
  const rows = await q(sb.from("boh_complaints").select("*, order:boh_orders(order_no)").order("created_at", { ascending: false }));
  el.innerHTML = `<div class="page-head"><h1>Complaints</h1><button class="btn primary" id="new">+ Raise complaint</button></div>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Order</th><th>Type</th><th>Complaint</th><th>Status</th><th>Our response</th></tr></thead><tbody>
    ${rows.map((c) => `<tr><td>${fmtDT(c.created_at)}</td><td>${c.order ? "#" + c.order.order_no : "—"}</td><td>${esc(c.category || "")}</td><td><b>${esc(c.subject)}</b><div class="small">${esc(c.description || "")}</div></td>
      <td><span class="badge ${c.status === "resolved" ? "ok" : c.status === "in_progress" ? "info" : "warn"}">${c.status.replace("_", " ")}</span></td><td class="small">${esc(c.resolution || "")}</td></tr>`).join("") || '<tr><td colspan="6" class="empty">No complaints.</td></tr>'}
    </tbody></table></div>`;
  $("#new").onclick = () => complaintForm(null, () => complaints(el));
}
