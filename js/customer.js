import { sb, state, $, $$, esc, money, num, fmtDT, fmtD, toast, modal, confirmBox, promptBox, q, statusBadge, telLinks, payBadge, PAY_MODE, todayIST, tabs, openBill, billNo } from "./lib.js?v=23";

const CART_KEY = () => "boh_cart_" + state.me.restaurant_id;
const loadCart = () => { try { return JSON.parse(localStorage.getItem(CART_KEY()) || "{}"); } catch { return {}; } };
const saveCart = (c) => { try { localStorage.setItem(CART_KEY(), JSON.stringify(c)); } catch {} };

let catalogCache = null;
let dnCache = null;
// The restaurant's own names for products (set by our team per restaurant); falls back to the real name.
async function displayNames(force = false) {
  if (!dnCache || force) {
    try { dnCache = Object.fromEntries((await q(sb.rpc("boh_my_display_names"))).map((r) => [r.product_id, r.display_name])); }
    catch { dnCache = {}; }
  }
  return dnCache;
}
async function withDN(rows) {
  const m = await displayNames();
  (rows || []).forEach((r) => { if (r && m[r.product_id]) r.product_name = m[r.product_id]; });
  return rows;
}
async function myCatalog(force = false) {
  if (!catalogCache || force) catalogCache = await withDN(await q(sb.rpc("boh_my_catalog")));
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

// pending balance: everything not yet paid, split into due now / under approval / not delivered yet
async function balanceCard() {
  const [b] = await q(sb.rpc("boh_balances"));
  if (!b || !Number(b.pending)) return `<div class="card"><h2>Pending balance</h2><div class="stat"><div class="v" style="color:var(--ok)">${money(0)}</div><div class="l">Nothing pending — thank you!</div></div></div>`;
  const line = (l, v, c) => Number(v) ? `<div class="row between small"><span>${l}</span><b style="${c ? "color:" + c : ""}">${money(v)}</b></div>` : "";
  return `<div class="card"><h2>Pending balance</h2>
    <div class="stat"><div class="v">${money(b.pending)}</div><div class="l">total not yet paid</div></div>
    <div style="margin-top:.5rem">${line("Due now (delivered / pre-pay)", b.due, "var(--danger)")}${line("…of which overdue", b.overdue, "var(--danger)")}
      ${line("Under approval (you've paid, we're checking)", b.under_review, "var(--warn)")}${line("Not delivered yet (pay on delivery)", b.upcoming)}</div>
    ${Number(b.due) ? `<div class="row" style="margin-top:.6rem"><a class="btn sm accent" href="#/myorders">Pay now →</a></div>` : ""}</div>`;
}
const uniqCoords = (list) => [...new Map((list || []).map((c) => [c.full_name + "|" + (c.phone || ""), c])).values()];

// ====================================================================== HOME
export async function home(el) {
  const [slides, orders, cat] = await Promise.all([
    q(sb.from("boh_featured").select("*, product:boh_products(id,name,image_url,description,unit,brand)").eq("active", true)),
    q(sb.from("boh_orders").select("*").order("created_at", { ascending: false }).limit(50)),
    myCatalog(true),
  ]);
  const unpaid = unpaidBanner(orders);
  const open = orders.filter((o) => !["paid", "cancelled"].includes(o.status)).slice(0, 3);
  const [coords, bal] = await Promise.all([Promise.all(open.map((o) => q(sb.rpc("boh_order_coordinators", { p_order: o.id })).then(uniqCoords))), balanceCard()]);
  const ci = cutoffInfo();
  el.innerHTML = `
    <div id="slides"></div>
    <div class="page-head"><div><h1>Hello, ${esc(state.me.restaurant?.name || state.me.full_name)}</h1></div>
      <a class="btn primary" href="#/order">🛒 Place today's order</a></div>
    <div class="notice ${ci.open ? "green" : ""}">${ci.html}</div>
    ${unpaid ? unpaid.replace("</div>", ' <a href="#/myorders">Go to my orders →</a></div>') : ""}
    <div class="grid c2">
      <div class="card"><h2>Your coordinator</h2>
        ${open.length ? open.map((o, i) => `<div style="margin-bottom:.6rem"><b>Order #${o.order_no}</b> <span class="small muted">delivery ${fmtD(o.delivery_date)}</span>
          ${coords[i].length ? coords[i].map((c) => `<div class="small">Coordinator: <b>${esc(c.full_name)}</b> 📞 ${telLinks([c.phone])}</div>`).join("")
            : '<div class="small muted">A coordinator will be assigned shortly.</div>'}</div>`).join("")
          : `<div class="muted">When you place an order, the coordinator handling it will appear here with their number.</div>`}
        ${state.settings.support_phone ? `<div class="small" style="margin-top:.75rem">Support: ${telLinks([state.settings.support_phone])}</div>` : ""}
      </div>
      ${bal}
      <div class="card"><h2>Your ordering list</h2>
        <div class="stat"><div class="v">${cat.length}</div><div class="l">products ready to order</div></div>
        <div class="row" style="margin-top:.5rem"><a class="btn" href="#/browse">Browse more products</a></div>
        <div class="small muted" style="margin-top:.5rem">Found something cheaper elsewhere? Tap <b>Found it cheaper?</b> on any item in Place order and tell us.</div></div>
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
      <div class="cap"><div class="small" style="opacity:.8">NEW FROM BACK OF HOUSE CO</div><h2>${esc(s.title)}</h2>
        <div>${esc(s.caption || "")}${s.price_label ? ` <b class="slide-price">${esc(s.price_label)}</b>` : ""}</div>
        <button class="btn sm accent" style="margin-top:.6rem">Know more →</button></div></div>`).join("")
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
      if (document.querySelector(".modal-bg")) return; // pause while details are open
      let n = Math.floor(Math.random() * slides.length);
      if (n === cur) n = (n + 1) % slides.length;
      show(n);
    }, 5000);
  }
  box.onclick = () => slideDetail(slides[cur], cat);
}

// "Know more" for a showcase slide, with an Enquire button
async function slideDetail(s, cat) {
  const p = s.product;
  const onList = p && cat.find((c) => c.product_id === p.id);
  const pending = p ? await q(sb.from("boh_product_requests").select("id").eq("product_id", p.id).eq("status", "pending")) : [];
  const imgs = [s.image_url || p?.image_url, ...(s.gallery || [])].filter(Boolean);
  const lines = (s.highlights || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const m = modal({
    wide: true,
    title: s.title,
    body: `<div class="${imgs.length ? "grid c2" : ""}" style="align-items:start">
        <div class="${imgs.length ? "" : "hidden"}">${imgs.length ? `<img id="bigimg" src="${esc(imgs[0])}" style="width:100%;max-height:340px;object-fit:cover;border-radius:10px">
          ${imgs.length > 1 ? `<div class="row" style="margin-top:.5rem">${imgs.map((u, i) => `<img data-thumb="${esc(u)}" src="${esc(u)}" style="width:64px;height:64px;object-fit:cover;border-radius:6px;cursor:pointer;${i === 0 ? "outline:2px solid var(--brand-2)" : ""}">`).join("")}</div>` : ""}` : ""}</div>
        <div>
          ${s.price_label ? `<div style="font-size:1.4rem;font-weight:750;color:var(--brand)">${esc(s.price_label)}</div>` : ""}
          ${s.caption ? `<p class="muted">${esc(s.caption)}</p>` : ""}
          ${s.details ? `<p style="white-space:pre-wrap">${esc(s.details)}</p>` : p?.description ? `<p>${esc(p.description)}</p>` : ""}
          ${lines.length ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
          ${p ? `<div class="row small muted">${p.brand ? `<span class="badge">${esc(p.brand)}</span>` : ""}<span class="badge">per ${esc(p.unit || "")}</span></div>` : ""}
          ${s.more_link ? `<p><a href="${esc(s.more_link)}" target="_blank" rel="noopener">More information ↗</a></p>` : ""}
          <hr style="border:0;border-top:1px solid var(--line);margin:1rem 0">
          ${onList ? `<div class="notice green">This is already on your ordering list at ${money(onList.price)} / ${esc(onList.unit)}.</div>`
            : pending.length ? `<div class="notice">You've already asked about this — our team will get back to you. You can add more details below.</div>` : ""}
          ${onList ? "" : `<h3>Enquire about this</h3>
            <div class="field"><label>Your question / requirement</label><textarea id="em" rows="3" placeholder="e.g. Need samples, monthly requirement, preferred brand…"></textarea></div>
            <div class="field"><label>Expected quantity (optional)</label><input id="eq" placeholder="e.g. 20 packs a week"></div>`}
        </div></div>`,
    footer: onList ? `<a class="btn primary" href="#/order">Order now</a>` : `<button class="btn accent" id="enq">Send enquiry</button>`,
  });
  $$("[data-thumb]", m.el).forEach((t) => (t.onclick = () => {
    $("#bigimg", m.el).src = t.dataset.thumb;
    $$("[data-thumb]", m.el).forEach((x) => (x.style.outline = x === t ? "2px solid var(--brand-2)" : ""));
  }));
  $("a.btn", m.el)?.addEventListener("click", m.close);
  $("#enq", m.el)?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const res = await q(sb.rpc("boh_enquire", { p_featured: s.id, p_message: $("#em", m.el).value, p_quantity: $("#eq", m.el).value }));
      toast({ request: "Request sent — our team will approve and add it to your list", request_updated: "Added to your existing request",
        enquiry: "Enquiry sent — our team will contact you", on_list: "Already on your ordering list" }[res] || "Sent");
      m.close();
    } catch { e.target.disabled = false; }
  });
}

async function productDetail(p, cat, slide) {
  const onList = cat.find((c) => c.product_id === p.id);
  const pending = await q(sb.from("boh_product_requests").select("id").eq("product_id", p.id).eq("status", "pending"));
  const img = slide?.image_url || p.image_url;
  const m = modal({
    title: onList?.product_name || p.name,
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
const DAYN = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
async function deliveryInfo(cat) {
  const [dl, pr] = await Promise.all([
    q(sb.rpc("boh_category_delivery")),
    cat.length ? q(sb.from("boh_products").select("id, moq").in("id", cat.map((c) => c.product_id))) : [],
  ]);
  const base = dl.reduce((m, d) => (!m || d.delivery_date < m ? d.delivery_date : m), null);
  return { byCat: Object.fromEntries(dl.map((d) => [d.category_id, d])), base, moq: Object.fromEntries(pr.filter((p) => p.moq).map((p) => [p.id, Number(p.moq)])) };
}
const dayLabel = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

export async function placeOrder(el) {
  const cat = await myCatalog(true);
  const DI = await deliveryInfo(cat);
  const late = (p) => { const d = DI.byCat[p.category_id]; return d && DI.base && d.delivery_date > DI.base ? d : null; };
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
    ${(() => { const ls = [...new Map(cat.filter(late).map((p) => [p.category_id, [p.category_name, late(p)]])).values()];
      return ls.length ? `<div class="notice">🗓️ Delivery days off: ${ls.map(([n, d]) => `<b>${esc(n)}</b> — no delivery ${d.off_days.map((x) => DAYN[x]).join(", ")}, so these items come <b>${dayLabel(d.delivery_date)}</b>`).join(" · ")}. Your order is split automatically.</div>` : ""; })()}
    ${cat.length ? `
    <div class="row" style="margin-bottom:.75rem"><input id="s" placeholder="Search your list…" style="max-width:320px">
      <select id="c" style="max-width:240px"><option value="">All categories</option>${cats.map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join("")}</select>
      <label class="row" style="margin:0"><input type="checkbox" id="only"> Show only items in cart</label>
      <span class="grow"></span>
      <div class="seg"><button data-view="grid" class="${view() === "grid" ? "on" : ""}">▦ Photos</button><button data-view="list" class="${view() === "list" ? "on" : ""}">☰ List</button></div></div>
    <div class="olist ${view()}" id="olist">
      ${cat.map((p) => `<div class="item" data-id="${p.product_id}" data-n="${esc((p.product_name + " " + (p.brand || "")).toLowerCase())}" data-c="${p.category_id}">
        <div class="pic" ${p.image_url ? `style="background-image:url('${esc(p.image_url)}')"` : ""}>${p.image_url ? "" : "📦"}</div>
        <div class="nm"><b>${esc(p.product_name)}</b>${p.brand ? ` <span class="small muted">${esc(p.brand)}</span>` : ""}<div class="small muted">${esc(p.category_name)}</div>
          ${DI.moq[p.product_id] ? `<span class="badge info" title="Minimum order quantity">Min ${num(DI.moq[p.product_id], 3)} ${esc(p.unit)}</span>` : ""}
          ${late(p) ? `<span class="badge warn" title="Day off for this category">🗓 ${dayLabel(late(p).delivery_date)}</span>` : ""}
          <button class="linkbtn small" type="button" data-cheap title="Tell us if you found a lower price">💡 Found it cheaper?</button></div>
        <div class="pr">${p.price == null ? `<span class="small" style="color:var(--warn)" title="You can order it — our team confirms the price before delivery">Price on request</span> <span class="small muted">/${esc(p.unit)}</span>` : money(p.price) + ` <span class="small muted">/${esc(p.unit)}</span>`}</div>
        <div class="qty"><button class="btn sm" data-dec>−</button><input type="number" min="0" step="any" data-q value="${cart[p.product_id] || ""}"><button class="btn sm" data-inc>+</button></div>
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
      $("[data-amt]", tr).textContent = v > 0 ? (p.price == null ? "Price to confirm" : money(v * Number(p.price))) : "";
      tr.classList.toggle("has", v > 0);
    });
    const pend = Object.keys(cart).filter((id) => byId[id]?.price == null).length;
    $("#cnt").textContent = cnt; $("#tot").textContent = money(tot) + (pend ? ` + ${pend} item${pend > 1 ? "s" : ""} at price to confirm` : "");
    saveCart(cart);
  };
  const filter = () => {
    const s = $("#s").value.toLowerCase(), c = $("#c").value, only = $("#only").checked;
    $$(".item[data-id]", el).forEach((tr) => tr.classList.toggle("hidden", !(tr.dataset.n.includes(s) && (!c || tr.dataset.c === c) && (!only || cart[tr.dataset.id]))));
  };
  $$(".item[data-id]", el).forEach((tr) => {
    const inp = $("[data-q]", tr);
    inp.oninput = recalc;
    const mq = DI.moq[tr.dataset.id] || 0;
    $("[data-inc]", tr).onclick = () => { if (!inp.disabled) { inp.value = Math.max(mq, (Number(inp.value) || 0) + 1); recalc(); } };
    $("[data-dec]", tr).onclick = () => { inp.value = Math.max(0, (Number(inp.value) || 0) - 1) || ""; recalc(); };
  });
  $$("[data-cheap]", el).forEach((b) => (b.onclick = () => reportCheaper(byId[b.closest(".item").dataset.id])));
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
    const under = items.filter((i) => DI.moq[i.product_id] && i.qty < DI.moq[i.product_id]);
    if (under.length) return toast(`Minimum order: ${under.map((i) => `${i.p.product_name} ${num(DI.moq[i.product_id], 3)} ${i.p.unit}`).join(", ")}`, true);
    const dates = [...new Set(items.map((i) => (DI.byCat[i.p.category_id]?.delivery_date) || DI.base))].sort();
    const total = items.reduce((a, i) => a + i.qty * Number(i.p.price || 0), 0);
    const pend = items.filter((i) => i.p.price == null);
    const m = modal({
      title: "Review your order",
      body: `<div class="notice ${cutoffInfo().open ? "green" : ""}">${cutoffInfo().html}</div>
        ${dates.length > 1 ? `<div class="notice">🗓️ This will be placed as <b>${dates.length} orders</b> because of category days off: ${dates.map((d) => `<b>${dayLabel(d)}</b> — ${esc([...new Set(items.filter((i) => ((DI.byCat[i.p.category_id]?.delivery_date) || DI.base) === d).map((i) => i.p.category_name))].join(", "))}`).join(" · ")}</div>` : ""}
        <table><thead><tr><th>Product</th><th class="right">Qty</th><th class="right">Price</th><th class="right">Amount</th></tr></thead><tbody>
        ${items.map((i) => `<tr><td>${esc(i.p.product_name)}</td><td class="right">${num(i.qty, 3)} ${esc(i.p.unit)}</td><td class="right">${i.p.price == null ? "Price on request" : money(i.p.price)}</td><td class="right">${i.p.price == null ? '<span class="small" style="color:var(--warn)">To be confirmed</span>' : money(i.qty * i.p.price)}</td></tr>`).join("")}
        <tr><td colspan="3"><b>Total${pend.length ? " (priced items)" : ""}</b></td><td class="right"><b>${money(total)}</b></td></tr></tbody></table>
        ${pend.length ? `<div class="notice">${pend.length} item${pend.length > 1 ? "s are" : " is"} <b>price on request</b> (${esc(pend.map((i) => i.p.product_name).join(", "))}). Our team confirms the price and sends you the final bill before delivery.</div>` : ""}
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
        toast(dates.length > 1 ? `${dates.length} orders placed (split by delivery day)! Your coordinator will take it from here.` : "Order placed! Your coordinator will take it from here.");
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

// restaurant tells us about a cheaper vendor: price, vendor name and contact are required
async function reportCheaper(p) {
  const past = await q(sb.from("boh_price_reports").select("*").eq("product_id", p.product_id).order("created_at", { ascending: false }).limit(3));
  const ST = { new: "Sent", reviewing: "We're checking", matched: "Matched", rejected: "Not valid" };
  const m = modal({
    title: `Found ${p.product_name} cheaper?`,
    body: `<p class="small muted">Tell us where — our team will check the vendor and get back to you. Our price now: <b>${p.price == null ? "on request" : money(p.price) + " / " + esc(p.unit)}</b></p>
      <div class="form-grid">
        <div class="field"><label>Price you were offered (₹ per ${esc(p.unit)}) *</label><input id="pr" type="number" step="0.01" min="0" inputmode="decimal"></div>
        <div class="field"><label>Vendor name *</label><input id="vn" placeholder="e.g. Sharma Traders"></div>
        <div class="field"><label>Vendor contact number *</label><input id="vc" type="tel" placeholder="+91…"></div>
        <div class="field"><label>Note (optional)</label><input id="nt" placeholder="brand, pack size, minimum quantity…"></div>
      </div>
      ${past.length ? `<div class="small muted" style="margin-top:.5rem">You reported before: ${past.map((r) => `${money(r.reported_price)} from ${esc(r.vendor_name)} (${ST[r.status]}, ${fmtD(r.created_at)})`).join(" · ")}</div>` : ""}`,
    footer: `<button class="btn" id="cn">Cancel</button><button class="btn primary" id="go">Send to Back of House</button>`,
  });
  $("#cn", m.el).onclick = m.close;
  $("#go", m.el).onclick = async () => {
    const price = Number($("#pr", m.el).value), vn = $("#vn", m.el).value.trim(), vc = $("#vc", m.el).value.trim();
    if (!(price > 0)) return toast("Enter the price you were offered", true);
    if (!vn) return toast("Enter the vendor name", true);
    if (vc.replace(/\D/g, "").length < 8) return toast("Enter the vendor's contact number", true);
    await q(sb.rpc("boh_report_cheaper", { p_product: p.product_id, p_price: price, p_vendor: vn, p_contact: vc, p_note: $("#nt", m.el).value.trim() || null }));
    m.close(); toast("Thanks! Our team will check this vendor.");
  };
}

// ====================================================================== PAYMENT
function unpaidBanner(orders) {
  const due = orders.filter((o) => o.status !== "cancelled" && o.payment_status === "unpaid" && (o.payment_mode === "prepaid" || ["delivered", "paid"].includes(o.status)));
  if (!due.length) return "";
  const rej = due.filter((o) => o.payment_rejected_note).length;
  return `<div class="notice" style="background:#fbeeed;border-color:#efc5c1;color:#8a2a23">💳 <b>${money(due.reduce((a, o) => a + Number(o.total), 0))} unpaid</b> across ${due.length} order${due.length > 1 ? "s" : ""}${rej ? ` (${rej} payment${rej > 1 ? "s" : ""} rejected — please check)` : ""}. Please pay and tap <b>Pay now → I've already paid</b>.</div>`;
}

const copyBtn = (v) => v ? ` <button class="btn sm" type="button" data-copy="${esc(v)}" title="Copy">⧉</button>` : "";
function payInstructions() {
  const st = state.settings;
  const hasQr = st.pay_qr_url || st.pay_upi_id;
  const hasBank = st.bank_account_no;
  const qr = hasQr ? `<div class="card paybox" style="padding:.8rem;margin-top:0"><b>📱 Scan QR / pay by UPI</b>
      ${st.pay_qr_url ? `<div style="text-align:center;margin:.6rem 0"><img src="${esc(st.pay_qr_url)}" style="width:200px;height:200px;object-fit:contain;background:#fff;border:1px solid var(--line);border-radius:8px"></div>` : ""}
      ${st.pay_upi_id ? `<div class="small">UPI ID: <b>${esc(st.pay_upi_id)}</b>${copyBtn(st.pay_upi_id)}</div>` : ""}</div>` : "";
  const row = (l, v) => v ? `<tr><td class="muted">${l}</td><td><b>${esc(v)}</b>${copyBtn(v)}</td></tr>` : "";
  const bank = hasBank ? `<div class="card paybox" style="padding:.8rem;margin-top:0"><b>🏦 Bank transfer (NEFT / IMPS / RTGS)</b>
      <table class="small" style="margin-top:.4rem"><tbody>${row("Account name", st.bank_account_name)}${row("Account no.", st.bank_account_no)}${row("IFSC", st.bank_ifsc)}${row("Bank", st.bank_name)}${row("Branch", st.bank_branch)}</tbody></table></div>` : "";
  const notes = (st.payment_instructions || "").trim() ? `<div class="small" style="white-space:pre-wrap;margin-top:.6rem">${esc(st.payment_instructions)}</div>` : "";
  if (!qr && !bank && !notes) return `<div class="muted">Please contact your coordinator or ${st.support_phone ? "call " + esc(st.support_phone) : "our team"} for payment details.</div>`;
  return `<div class="grid ${qr && bank ? "c2" : ""}" style="align-items:start">${qr}${bank}</div>${notes}`;
}
function bindCopy(root) {
  $$("[data-copy]", root).forEach((b) => (b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast("Copied"); } catch { toast(b.dataset.copy); }
  }));
}

// "Pay now": shows how to pay, and lets the restaurant say "I've already paid" with a reference
export function payNow(o, done) {
  const m = modal({
    wide: true,
    title: `Pay for order #${o.order_no} — ${money(o.total)}`,
    body: `${o.payment_rejected_note ? `<div class="notice" style="background:#fbeeed;border-color:#efc5c1;color:#8a2a23"><b>Your last payment was not approved:</b> ${esc(o.payment_rejected_note)}</div>` : ""}
      <h3>How to pay</h3>${payInstructions()}
      <h3 style="margin-top:1rem">Already paid?</h3>
      <p class="small muted">Tell us how you paid and the transaction ID (UTR) or cheque number. Our team will check and confirm it.</p>
      <div class="form-grid">
        <div class="field"><label>Paid via *</label><select id="pmeth"><option>UPI / QR code</option><option>Bank transfer</option><option>Cheque</option><option>Cash</option><option>Other</option></select></div>
        <div class="field"><label>Payment reference *</label><input id="ref" placeholder="e.g. UTR 4123 5678 9012"></div>
      </div>`,
    footer: `<button class="btn" id="later">Pay later</button><button class="btn primary" id="paid">I've already paid</button>`,
  });
  bindCopy(m.el);
  $("#later", m.el).onclick = m.close;
  $("#paid", m.el).onclick = async () => {
    const ref = $("#ref", m.el).value.trim();
    if (!ref) return toast("Enter the payment reference", true);
    await q(sb.rpc("boh_claim_payment", { p_order: o.id, p_ref: ref, p_method: $("#pmeth", m.el).value }));
    toast("Thanks! Payment is under approval."); m.close(); done?.();
  };
}

// ====================================================================== MY ORDERS
const CUST_STEPS = [["created_at", "Order placed"], ["allocated_at", "Coordinator assigned"], ["acknowledged_at", "Acknowledged"], ["vendor_ordered_at", "Being procured"], ["delivered_at", "Delivered"], ["paid_at", "Payment received"]];

export async function myOrders(el) {
  const [orders, bal] = await Promise.all([q(sb.from("boh_orders").select("*").order("created_at", { ascending: false }).limit(200)), balanceCard()]);
  el.innerHTML = `
    <div class="page-head"><h1>My orders</h1><a class="btn primary" href="#/order">+ New order</a></div>
    ${unpaidBanner(orders)}
    <div style="max-width:520px;margin-bottom:1rem">${bal}</div>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Placed</th><th>Delivery</th><th class="right">Total</th><th>Order status</th><th>Payment</th><th>Bill</th><th></th></tr></thead><tbody>
    ${orders.map((o) => `<tr><td><b>${o.order_no}</b></td><td>${fmtDT(o.created_at)}</td><td>${fmtD(o.delivery_date)}</td><td class="right">${money(o.total)}</td><td>${statusBadge(o.status)}</td>
      <td>${payBadge(o)}<div class="small muted">${PAY_MODE[o.payment_mode] || ""}</div>${o.payment_status === "unpaid" && o.payment_rejected_note ? `<div class="small" style="color:var(--danger)">${esc(o.payment_rejected_note)}</div>` : ""}</td>
      <td>${o.status !== "cancelled" ? `<button class="btn sm" data-bill="${o.id}" title="${o.invoice_no ? "Invoice" : "Proforma invoice"}">🧾 ${esc(billNo(o))}</button>` : ""}</td>
      <td class="right" style="white-space:nowrap">${o.status !== "cancelled" && o.payment_status === "unpaid" ? `<button class="btn sm accent" data-pay="${o.id}">Pay now</button> ` : ""}<button class="btn sm" data-v="${o.id}">View</button></td></tr>`).join("") || '<tr><td colspan="8" class="empty">No orders yet.</td></tr>'}
    </tbody></table></div>`;
  const reload = () => myOrders(el);
  $$("[data-pay]", el).forEach((b) => (b.onclick = () => payNow(orders.find((x) => x.id === b.dataset.pay), reload)));
  $$("[data-bill]", el).forEach((b) => (b.onclick = async () => openBill(b.dataset.bill, { names: await displayNames() })));
  $$("[data-v]", el).forEach((b) => (b.onclick = async () => {
    const o = orders.find((x) => x.id === b.dataset.v);
    const [lines, coords] = await Promise.all([q(sb.rpc("boh_order_lines", { p_order: o.id })).then(withDN), q(sb.rpc("boh_order_coordinators", { p_order: o.id })).then(uniqCoords)]);
    const m = modal({
      title: `Order #${o.order_no}`,
      body: `<div class="row" style="margin-bottom:1rem">${statusBadge(o.status)} ${payBadge(o)}<span class="muted">${PAY_MODE[o.payment_mode] || ""} · Delivery ${fmtD(o.delivery_date)}</span></div>
        ${o.payment_status === "under_review" ? `<div class="notice">You told us you paid (ref <b>${esc(o.payment_claim_ref)}</b>). Our team is checking it.</div>` : ""}
        ${o.payment_status === "unpaid" && o.payment_rejected_note ? `<div class="notice" style="background:#fbeeed;border-color:#efc5c1;color:#8a2a23"><b>Not paid:</b> your payment could not be approved — ${esc(o.payment_rejected_note)}</div>` : ""}
        <div class="steps" style="margin-bottom:1rem">${CUST_STEPS.map(([k, l]) => `<div class="step ${o[k] ? "done" : ""}"><span class="dot"></span><div>${l}</div><div class="small muted">${o[k] ? fmtDT(o[k]) : ""}</div></div>`).join("")}</div>
        ${coords.length ? `<div class="card" style="padding:.7rem;margin-bottom:1rem"><b>Your coordinator</b>${coords.map((c) => `<div class="small">${esc(c.full_name)} 📞 ${telLinks([c.phone])}</div>`).join("")}</div>` : ""}
        <table><thead><tr><th>Product</th><th class="right">Qty</th><th class="right">Price</th><th class="right">Amount</th></tr></thead><tbody>
        ${lines.map((l) => `<tr><td>${esc(l.product_name)}</td><td class="right">${num(l.qty, 3)} ${esc(l.unit)}</td><td class="right">${l.unit_price == null ? "Price on request" : money(l.unit_price)}</td><td class="right">${l.line_total == null ? '<span class="small" style="color:var(--warn)">To be confirmed</span>' : money(l.line_total)}</td></tr>`).join("")}
        <tr><td colspan="3"><b>Total${o.price_pending ? " (priced items)" : ""}</b></td><td class="right"><b>${money(o.total)}</b></td></tr></tbody></table>
        ${o.price_pending ? '<div class="notice">Some items are price on request — our team will confirm their price and send you the final bill.</div>' : ""}
        ${o.notes ? `<p class="small muted">Your note: ${esc(o.notes)}</p>` : ""}`,
      footer: `<button class="btn" id="cmp">Raise a complaint</button><span class="grow"></span>${o.status !== "cancelled" ? `<button class="btn" id="mbill">🧾 ${o.invoice_no ? "Invoice" : "Proforma bill"} (PDF)</button>` : ""}${o.status !== "cancelled" && o.payment_status === "unpaid" ? '<button class="btn accent" id="paynow">Pay now</button>' : ""}`,
    });
    $("#mbill", m.el)?.addEventListener("click", async () => openBill(o.id, { names: await displayNames() }));
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

// ====================================================================== STOCK & AUTO-ORDER (feature switched on by the super admin)
export async function stock(el) {
  const fa = await q(sb.from("boh_feature_access").select("*").eq("feature", "auto_order").eq("restaurant_id", state.me.restaurant_id));
  const st = fa[0]?.status || "off";
  if (st !== "active") {
    el.innerHTML = `<div class="page-head"><h1>Stock & auto-order</h1></div><div class="card" style="max-width:640px">
      <h2>📋 Daily stock count & automatic ordering</h2>
      <p>Count your stock at the end of the day. For each product you set a reorder level and either a <b>target level</b> (we top you up to it) or a <b>fixed reorder quantity</b>. At the time you choose, the order is placed automatically for everything that is low — no typing.</p>
      ${st === "requested" ? '<span class="badge warn">Requested — waiting for approval</span>' : `${st === "declined" ? '<p class="small" style="color:var(--danger)">Your last request was declined.</p>' : ""}<button class="btn primary" id="req">Request access</button>`}</div>`;
    $("#req")?.addEventListener("click", async () => {
      const note = await promptBox("Request Stock & auto-order", "Anything we should know? (optional)"); if (note === null) return;
      await q(sb.rpc("boh_request_feature", { p_feature: "auto_order", p_note: note || null })); toast("Request sent"); stock(el);
    });
    return;
  }
  const today = todayIST();
  el.innerHTML = `<div class="page-head"><div><h1>Stock & auto-order</h1><div class="muted">End-of-day count → automatic order for what's running low.</div></div></div>
    <div class="tabs" id="t"></div><div id="body"></div>`;
  const show = async (i) => {
    const box = $("#body");
    if (i === 0) return countTab(box, today);
    if (i === 1) return levelsTab(box);
    return autoTab(box);
  };
  tabs($("#t"), ["Today's stock count", "Reorder levels", "Auto-order"], show);
}

async function countTab(box, today) {
  const rows = await withDN(await q(sb.rpc("boh_stock_list", { p_date: today })));
  const cats = [...new Set(rows.map((r) => r.category_name))];
  box.innerHTML = `<div class="row" style="margin:.5rem 0"><input id="s" placeholder="Search…" style="max-width:280px"><span class="grow"></span>
      <button class="btn" id="copy">Fill with last count</button><button class="btn primary" id="save">Save count</button></div>
    <div class="table-wrap"><table><thead><tr><th>Product</th><th class="right">Last count</th><th class="right">Reorder at</th><th style="width:140px">Stock now</th></tr></thead><tbody>
    ${cats.map((c) => `<tr><td colspan="4" style="background:#faf8f4"><b>${esc(c)}</b></td></tr>` + rows.filter((r) => r.category_name === c).map((r) => `<tr data-r="${r.product_id}" data-n="${esc(r.product_name.toLowerCase())}">
      <td>${esc(r.product_name)} <span class="small muted">/${esc(r.unit)}</span>${r.auto ? ' <span class="badge info">auto</span>' : ""}</td>
      <td class="right small">${r.last_qty != null ? num(r.last_qty, 3) + `<div class="muted">${fmtD(r.last_date)}</div>` : "—"}</td>
      <td class="right">${r.reorder_level != null && r.auto ? num(r.reorder_level, 3) : "—"}</td>
      <td><input type="number" min="0" step="any" data-c value="${r.count_qty ?? ""}" data-last="${r.last_qty ?? ""}"></td></tr>`).join("")).join("") || '<tr><td colspan="4" class="empty">Your ordering list is empty.</td></tr>'}
    </tbody></table></div><p class="small muted">Leave blank for items you didn't count. Products marked <b>auto</b> are ordered automatically when stock is at or below the reorder level.</p>`;
  $("#s", box).oninput = (e) => $$("[data-r]", box).forEach((tr) => tr.classList.toggle("hidden", !tr.dataset.n.includes(e.target.value.toLowerCase())));
  $("#copy", box).onclick = () => $$("[data-c]", box).forEach((i) => { if (i.value === "" && i.dataset.last !== "") i.value = i.dataset.last; });
  $("#save", box).onclick = async () => {
    const rowsOut = $$("[data-r]", box).map((tr) => ({ product_id: tr.dataset.r, qty: $("[data-c]", tr).value }));
    if (rowsOut.some((r) => r.qty !== "" && Number(r.qty) < 0)) return toast("Stock cannot be negative", true);
    const n = await q(sb.rpc("boh_save_stock_count", { p_rows: rowsOut, p_date: today }));
    toast(`Saved ${n} counts`);
  };
}

async function levelsTab(box) {
  const rows = await withDN(await q(sb.rpc("boh_stock_list")));
  box.innerHTML = `<div class="notice">For each product: <b>Top up</b> → when stock ≤ reorder level, order enough to reach the target level. <b>Fixed qty</b> → order the same quantity every time.
    Before a category's delivery day off, the order automatically covers the extra day(s). Minimum order quantities (MOQ) are respected.</div>
    <div class="row" style="margin:.5rem 0"><span class="grow"></span><button class="btn primary" id="save">Save levels</button></div>
    <div class="table-wrap"><table><thead><tr><th>Auto</th><th>Product</th><th>Method</th><th>Reorder level</th><th>Target level</th><th>Reorder qty</th><th class="right">MOQ</th></tr></thead><tbody>
    ${rows.map((r) => `<tr data-r="${r.product_id}"><td><input type="checkbox" data-a ${r.auto ? "checked" : ""}></td>
      <td>${esc(r.product_name)} <span class="small muted">/${esc(r.unit)} · ${esc(r.category_name)}</span></td>
      <td><select data-m style="min-width:120px"><option value="topup" ${r.method === "topup" ? "selected" : ""}>Top up to target</option><option value="fixed" ${r.method === "fixed" ? "selected" : ""}>Fixed qty</option></select></td>
      <td><input type="number" step="any" min="0" data-rl value="${r.reorder_level ?? ""}" style="max-width:110px"></td>
      <td><input type="number" step="any" min="0" data-tl value="${r.target_level ?? ""}" style="max-width:110px"></td>
      <td><input type="number" step="any" min="0" data-rq value="${r.reorder_qty ?? ""}" style="max-width:110px"></td>
      <td class="right">${r.moq ? num(r.moq, 3) : "—"}</td></tr>`).join("") || '<tr><td colspan="7" class="empty">Your ordering list is empty.</td></tr>'}</tbody></table></div>`;
  const sync = (tr) => { const fixed = $("[data-m]", tr).value === "fixed"; $("[data-tl]", tr).disabled = fixed; $("[data-rq]", tr).disabled = !fixed; };
  $$("[data-r]", box).forEach((tr) => { sync(tr); $("[data-m]", tr).onchange = () => sync(tr); });
  $("#save", box).onclick = async () => {
    const out = $$("[data-r]", box).map((tr) => ({ product_id: tr.dataset.r, auto: $("[data-a]", tr).checked, method: $("[data-m]", tr).value,
      reorder_level: $("[data-rl]", tr).value, target_level: $("[data-tl]", tr).value, reorder_qty: $("[data-rq]", tr).value }));
    const bad = out.find((r) => r.auto && (r.reorder_level === "" || (r.method === "topup" ? !(Number(r.target_level) > Number(r.reorder_level)) : !(Number(r.reorder_qty) > 0))));
    if (bad) return toast("For every auto product set the reorder level, and a target above it (top up) or a reorder qty (fixed)", true);
    await q(sb.rpc("boh_save_stock_settings", { p_rows: out })); toast("Levels saved");
  };
}

async function autoTab(box) {
  const [cfg, prev] = await Promise.all([
    q(sb.from("boh_auto_order_config").select("*").eq("restaurant_id", state.me.restaurant_id).maybeSingle()),
    q(sb.rpc("boh_auto_order_preview")).then(withDN),
  ]);
  const c = cfg || { enabled: false, order_time: "22:00", payment_mode: "cod" };
  const total = prev.reduce((a, r) => a + Number(r.line_total || 0), 0);
  box.innerHTML = `<div class="grid" style="grid-template-columns:minmax(260px,380px) 1fr;gap:1rem;align-items:start">
    <div class="card"><h2>Auto-order settings</h2>
      <label class="row" style="gap:.4rem"><input type="checkbox" id="en" ${c.enabled ? "checked" : ""}> <b>Place my order automatically every day</b></label>
      <div class="field" style="margin-top:.6rem"><label>Order time</label><input type="time" id="tm" value="${String(c.order_time).slice(0, 5)}">
        <div class="small muted">Count your stock before this time. Orders before ${String(state.settings.order_cutoff || "16:00").slice(0, 5)} are delivered the next day; later ones the day after.</div></div>
      <div class="field"><label>Payment</label><select id="pm"><option value="cod" ${c.payment_mode === "cod" ? "selected" : ""}>Pay on delivery</option><option value="prepaid" ${c.payment_mode === "prepaid" ? "selected" : ""}>Pre-pay</option></select></div>
      <div class="field"><label>Note on every auto order (optional)</label><input id="nt" value="${esc(c.notes || "")}"></div>
      <button class="btn primary" id="save">Save</button>
      ${c.last_run_date ? `<p class="small" style="margin-top:.8rem">Last run ${fmtD(c.last_run_date)}: ${esc(c.last_result || "")}</p>` : ""}</div>
    <div class="card"><h2>If it ran now (from today's count)</h2>
      ${prev.length ? `<table><thead><tr><th>Product</th><th class="right">Stock</th><th class="right">Order</th><th>Delivery</th><th class="right">Amount</th></tr></thead><tbody>
        ${prev.map((r) => `<tr><td>${esc(r.product_name)}</td><td class="right">${num(r.stock, 3)}</td><td class="right"><b>${num(r.order_qty, 3)}</b> ${esc(r.unit)}
          ${r.days_covered > 1 ? `<div class="small muted">covers ${r.days_covered} days</div>` : ""}${r.moq && Number(r.order_qty) === Number(r.moq) ? '<div class="small muted">MOQ</div>' : ""}</td>
          <td class="small">${dayLabel(r.delivery_date)}</td><td class="right">${money(r.line_total)}</td></tr>`).join("")}
        <tr><td colspan="4"><b>Total</b></td><td class="right"><b>${money(total)}</b></td></tr></tbody></table>`
      : '<p class="muted">Nothing to order — either no count saved today, or everything is above its reorder level.</p>'}</div></div>`;
  $("#save", box).onclick = async () => {
    await q(sb.rpc("boh_save_auto_config", { p_enabled: $("#en", box).checked, p_time: $("#tm", box).value || "22:00", p_payment_mode: $("#pm", box).value, p_notes: $("#nt", box).value || null }));
    toast($("#en", box).checked ? "Auto-order is on" : "Auto-order is off");
  };
}
