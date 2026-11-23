// Back of House Co — vendor portal
import { sb, state, $, $$, esc, money, num, fmtDT, fmtD, toast, modal, confirmBox, promptBox, q, uploadImage, telLinks } from "./lib.js?v=20";

const PO_ST = { sent: ["New — please accept", "warn"], accepted: ["Accepted", "info"], dispatched: ["Dispatched", "info"], delivered: ["Delivered", "ok"], rejected: ["Rejected", "danger"], cancelled: ["Cancelled", ""] };
let ctx = null;
async function load() {
  const [vendor, fa] = await Promise.all([
    q(sb.from("boh_vendors").select("*").eq("id", state.me.vendor_id).single()),
    q(sb.from("boh_feature_access").select("*").eq("vendor_id", state.me.vendor_id)),
  ]);
  const st = (f) => fa.find((x) => x.feature === f)?.status || "off";
  ctx = { vendor, st };
  return ctx;
}
const pendingBox = (v) => `<div class="card" style="border-left:4px solid var(--warn)"><h2>Registration under review</h2>
  <p>Thanks for registering <b>${esc(v.name)}</b>. Our team will check your details and approve your account — you'll get a WhatsApp / email when it's done.</p></div>`;
const rejectedBox = (v) => `<div class="card" style="border-left:4px solid var(--danger)"><h2>Registration not approved</h2><p>${esc(v.approval_note || "Please contact Back of House Co for details.")}</p></div>`;

function featureCard(f, title, text) {
  const s = ctx.st(f);
  return `<div class="card"><h2>${title}</h2><p class="small">${text}</p>
    ${s === "active" ? '<span class="badge ok">Switched on</span>'
      : s === "requested" ? '<span class="badge warn">Requested — waiting for approval</span>'
      : `${s === "declined" ? '<p class="small" style="color:var(--danger)">Your last request was declined.</p>' : ""}<button class="btn primary" data-req="${f}">Request access</button>`}</div>`;
}
function bindReq(el, after) {
  $$("[data-req]", el).forEach((b) => (b.onclick = async () => {
    const note = await promptBox("Request access", "Anything we should know? (optional)"); if (note === null) return;
    await q(sb.rpc("boh_request_feature", { p_feature: b.dataset.req, p_note: note || null }));
    toast("Request sent — we'll let you know"); after();
  }));
}

// ---------------------------------------------------------------- home
export async function vhome(el) {
  const { vendor } = await load();
  if (vendor.approval === "pending") { el.innerHTML = `<div class="page-head"><h1>Welcome, ${esc(state.me.full_name)}</h1></div>${pendingBox(vendor)}`; return; }
  if (vendor.approval === "rejected") { el.innerHTML = `<div class="page-head"><h1>Vendor portal</h1></div>${rejectedBox(vendor)}`; return; }
  const pos = ctx.st("vendor_orders") === "active" ? await q(sb.rpc("boh_vendor_po_list", { p_open_only: true })) : [];
  const n = (s) => pos.filter((p) => p.status === s).length;
  el.innerHTML = `<div class="page-head"><div><h1>${esc(vendor.name)}</h1><div class="muted">Back of House Co vendor portal</div></div></div>
    ${ctx.st("vendor_orders") === "active" ? `<div class="grid stats">
      <div class="card stat"><div class="l">New orders to accept</div><div class="v" style="color:${n("sent") ? "var(--warn)" : "inherit"}">${n("sent")}</div><a class="small" href="#/vorders">Open orders →</a></div>
      <div class="card stat"><div class="l">Accepted — to dispatch</div><div class="v">${n("accepted")}</div></div>
      <div class="card stat"><div class="l">On the way</div><div class="v">${n("dispatched")}</div></div></div>` : ""}
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;margin-top:1rem">
      ${featureCard("vendor_orders", "📦 Orders", "Receive our purchase orders here automatically, accept them, and mark dispatched / delivered — no phone calls needed.")}
      ${featureCard("vendor_products", "🏷️ Sell your products", "Offer new products or update your rates. Our team approves them for our restaurant clients and/or our online shop.")}
    </div>
    <div class="card" style="margin-top:1rem"><h2>Your details</h2><p class="small">${esc(vendor.contact_person || "")} · 📞 ${telLinks(vendor.phones)} ${vendor.email ? "· " + esc(vendor.email) : ""}</p>
      <p class="small muted">To change your details, phone numbers or bank details, contact your Back of House Co coordinator.</p></div>`;
  bindReq(el, () => vhome(el));
}

// ---------------------------------------------------------------- orders
export async function vorders(el) {
  const { vendor } = await load();
  if (vendor.approval !== "approved") return vhome(el);
  if (ctx.st("vendor_orders") !== "active") {
    el.innerHTML = `<div class="page-head"><h1>Orders</h1></div>${featureCard("vendor_orders", "📦 Orders in the portal", "Ask us to switch this on to receive our orders here.")}`;
    return bindReq(el, () => vorders(el));
  }
  el.innerHTML = `<div class="page-head"><div><h1>Orders from Back of House Co</h1><div class="muted">Accept new orders quickly. If you can't supply, reject with a reason so we can arrange another vendor.</div></div>
    <select id="m" style="max-width:200px"><option value="1">Open</option><option value="0">Last 90 days</option></select></div><div id="list"></div>`;
  const render = async () => {
    const pos = await q(sb.rpc("boh_vendor_po_list", { p_open_only: $("#m").value === "1" }));
    $("#list").innerHTML = pos.map((p) => {
      const tot = (p.items || []).reduce((a, i) => a + Number(i.total || 0), 0);
      return `<div class="card"><div class="row between"><div><h2 style="margin:0">Order ${esc(p.ref)} ${p.kind === "shop" ? '<span class="badge info">Online shop</span>' : ""}</h2>
          <div class="small muted">Received ${fmtDT(p.sent_at)}${p.delivery_date ? " · Needed by " + fmtD(p.delivery_date) : ""}</div></div>
          <span class="badge ${PO_ST[p.status][1]}">${PO_ST[p.status][0]}</span></div>
        <table style="margin-top:.5rem"><thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Your rate</th><th class="right">Amount</th></tr></thead><tbody>
          ${(p.items || []).map((i) => `<tr><td>${esc(i.name)}</td><td class="right">${num(i.qty, 3)} ${esc(i.unit || "")}</td><td class="right">${money(i.rate)}</td><td class="right">${money(i.total)}</td></tr>`).join("")}
          <tr><td colspan="3" class="right"><b>Total</b></td><td class="right"><b>${money(tot)}</b></td></tr></tbody></table>
        <div class="small" style="margin-top:.5rem">${p.deliver ? `🚚 <b>Deliver to:</b> ${esc(p.deliver.name)}, ${esc(p.deliver.address || "")} ${p.deliver.phone ? "· 📞 " + telLinks([p.deliver.phone]) : ""}` : "🛵 Our porter will pick up from you."}
          ${p.coordinator ? `<br>👤 Coordinator: ${esc(p.coordinator.name)} ${p.coordinator.phone ? "· 📞 " + telLinks([p.coordinator.phone]) : ""}` : ""}${p.note ? `<br>Note: ${esc(p.note)}` : ""}</div>
        <div class="row" style="justify-content:flex-end;margin-top:.5rem">
          ${p.status === "sent" ? `<button class="btn danger" data-po="${p.id}|rejected">Can't supply</button><button class="btn primary" data-po="${p.id}|accepted">Accept order</button>` : ""}
          ${p.status === "accepted" ? `<button class="btn" data-po="${p.id}|rejected">Can't supply</button><button class="btn" data-po="${p.id}|dispatched">Mark dispatched</button><button class="btn primary" data-po="${p.id}|delivered">Mark delivered</button>` : ""}
          ${p.status === "dispatched" ? `<button class="btn primary" data-po="${p.id}|delivered">Mark delivered</button>` : ""}</div></div>`;
    }).join("") || `<div class="card empty">${$("#m").value === "1" ? "No open orders right now." : "No orders in the last 90 days."}</div>`;
    $$("[data-po]", el).forEach((b) => (b.onclick = async () => {
      const [id, st] = b.dataset.po.split("|");
      let note = null;
      if (st === "rejected") { note = await promptBox("Can't supply", "Reason (e.g. out of stock, price changed)"); if (note === null) return; if (!note.trim()) return toast("Please give a reason", true); }
      else if (st === "dispatched") { note = await promptBox("Dispatched", "Vehicle / driver / expected time (optional)"); if (note === null) return; }
      else if (!(await confirmBox(st === "accepted" ? "Accept this order?" : "Mark this order delivered?"))) return;
      await q(sb.rpc("boh_vendor_po_update", { p_po: id, p_status: st, p_note: note || null }));
      toast("Updated — thank you"); render();
    }));
  };
  $("#m").onchange = render; render();
}

// ---------------------------------------------------------------- products & rates
export async function vproducts(el) {
  const { vendor } = await load();
  if (vendor.approval !== "approved") return vhome(el);
  const on = ctx.st("vendor_products") === "active";
  const [rates, offers, cats] = await Promise.all([
    q(sb.rpc("boh_vendor_my_rates")),
    q(sb.from("boh_vendor_offers").select("*").eq("vendor_id", vendor.id).order("created_at", { ascending: false }).limit(50)),
    on ? q(sb.from("boh_categories").select("id, name").order("name")) : [],
  ]);
  el.innerHTML = `<div class="page-head"><div><h1>My products & rates</h1><div class="muted">Your current rates with us. You never see other vendors' rates — “Lowest” means you are currently our cheapest supplier.</div></div>
    ${on ? '<button class="btn primary" id="new">+ Offer a new product</button>' : ""}</div>
    ${on ? "" : featureCard("vendor_products", "🏷️ Sell your products", "Ask us to switch this on to offer new products and update your rates here.")}
    <div class="table-wrap"><table><thead><tr><th>Product</th><th>Category</th><th class="right">Your rate</th><th></th><th></th></tr></thead><tbody>
      ${rates.map((r) => `<tr><td>${esc(r.product_name)} <span class="small muted">/${esc(r.unit)}</span></td><td>${esc(r.category)}</td><td class="right">${money(r.rate)}</td>
        <td>${!r.active ? '<span class="badge">Inactive</span>' : r.is_best ? '<span class="badge ok">Lowest — you get our orders</span>' : '<span class="badge">Not lowest</span>'}</td>
        <td class="right">${on ? `<button class="btn sm" data-rate="${r.product_id}">Update rate</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="5" class="empty">No products linked to you yet.</td></tr>'}
    </tbody></table></div>
    ${offers.length ? `<h2 style="margin-top:1.2rem">My offers</h2><div class="table-wrap"><table><thead><tr><th>When</th><th>Product</th><th class="right">Rate</th><th>Status</th></tr></thead><tbody>
      ${offers.map((o) => `<tr><td>${fmtD(o.created_at)}</td><td>${esc(o.name)} <span class="small muted">/${esc(o.unit)}</span>${o.product_id && o.status === "pending" ? ' <span class="badge info">rate update</span>' : ""}</td><td class="right">${money(o.rate)}</td>
        <td>${o.status === "pending" ? '<span class="badge warn">Waiting</span>' : o.status === "approved" ? '<span class="badge ok">Approved</span>' : '<span class="badge danger">Not approved</span>'}${o.admin_note ? `<div class="small muted">${esc(o.admin_note)}</div>` : ""}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
  bindReq(el, () => vproducts(el));
  if (!on) return;
  $("#new").onclick = () => offerForm(null, cats, () => vproducts(el));
  $$("[data-rate]", el).forEach((b) => (b.onclick = () => offerForm(rates.find((r) => r.product_id === b.dataset.rate), cats, () => vproducts(el))));
}

function offerForm(existing, cats, done) {
  let img = null;
  const m = modal({
    title: existing ? `Update rate — ${existing.product_name}` : "Offer a new product",
    body: `<div class="form-grid">
      ${existing ? `<p class="small" style="grid-column:1/-1">Current rate: <b>${money(existing.rate)}</b> / ${esc(existing.unit)}</p>` : `
      <div class="field"><label>Product name *</label><input id="nm" placeholder="e.g. Basmati rice 1121"></div>
      <div class="field"><label>Brand</label><input id="br"></div>
      <div class="field"><label>Unit *</label><input id="un" placeholder="kg / pc / box of 100"></div>
      <div class="field"><label>Category</label><select id="ca"><option value="">— choose —</option>${cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></div>
      <div class="field" style="grid-column:1/-1"><label>Description</label><textarea id="de" rows="3" placeholder="Size, pack, quality, shelf life…"></textarea></div>
      <div class="field"><label>Photo</label><input type="file" id="ph" accept="image/*"><div id="pv"></div></div>`}
      <div class="field"><label>Your rate (₹ per ${existing ? esc(existing.unit) : "unit"}) *</label><input id="rt" type="number" step="0.01" min="0"></div>
      <div class="field"><label>Minimum order quantity</label><input id="mq" type="number" step="any" min="0"></div>
      ${existing ? "" : `<div style="grid-column:1/-1"><label class="row" style="gap:.4rem;font-weight:400"><input type="checkbox" id="fc" checked> For Back of House Co restaurant clients</label>
        <label class="row" style="gap:.4rem;font-weight:400"><input type="checkbox" id="fs"> For the Back of House Co online shop</label></div>`}
    </div><p class="small muted">Our team reviews every offer before it goes live.</p>`,
    footer: `<button class="btn primary" id="go">Send for approval</button>`,
  });
  const E = (s) => $(s, m.el);
  E("#ph")?.addEventListener("change", async (e) => { const f = e.target.files[0]; if (!f) return; img = await uploadImage(f, "vendor-offers"); E("#pv").innerHTML = `<img src="${esc(img)}" style="width:80px;margin-top:.3rem;border-radius:6px">`; });
  E("#go").onclick = async () => {
    const rate = Number(E("#rt").value);
    if (!(rate > 0)) return toast("Enter your rate", true);
    const p = existing ? { product_id: existing.product_id, rate, min_qty: E("#mq").value || null }
      : { name: E("#nm").value.trim(), brand: E("#br").value.trim(), unit: E("#un").value.trim(), category_id: E("#ca").value || null, description: E("#de").value.trim(),
          image_url: img, rate, min_qty: E("#mq").value || null, for_clients: E("#fc").checked, for_shop: E("#fs").checked };
    if (!existing && (!p.name || !p.unit)) return toast("Enter product name and unit", true);
    if (!existing && !p.for_clients && !p.for_shop) return toast("Choose at least one: clients or online shop", true);
    await q(sb.rpc("boh_vendor_submit_offer", { p }));
    toast("Sent — our team will review it"); m.close(); done();
  };
}
