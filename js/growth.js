// Back of House Co — shop, website leads, vendor offers, vendor approvals and feature access (staff side)
import {
  sb, state, $, $$, esc, money, num, fmtDT, fmtD, toast, modal, confirmBox, promptBox, q, uploadImage, downloadCSV, tabs, telLinks, callUsersFn,
} from "./lib.js?v=21";

const isSuper = () => state.me.role === "super_admin";
const FEATURE_LABEL = { auto_order: "Stock & auto-order", vendor_orders: "Vendor portal — orders", vendor_products: "Vendor portal — sell products" };
const FA_BADGE = { active: ["On", "ok"], requested: ["Requested", "warn"], declined: ["Declined", "danger"], off: ["Off", ""] };
export const DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ====================================================================== FEATURE ACCESS (super admin decides)
export async function features(el) {
  el.innerHTML = `
    <div class="page-head"><div><h1>Feature access</h1>
      <div class="muted">New features are off until the super admin switches them on for a restaurant or vendor. Restaurants and vendors can request them from their app.</div></div></div>
    <div class="tabs" id="t"></div><div id="body"></div>`;
  const load = async (tab) => {
    const [fa, rests, vends] = await Promise.all([
      q(sb.from("boh_feature_access").select("*").order("requested_at", { ascending: false, nullsFirst: false })),
      q(sb.from("boh_restaurants").select("id, name, active").order("name")),
      q(sb.from("boh_vendors").select("id, name, active, approval").order("name")),
    ]);
    const get = (f, r, v) => fa.find((x) => x.feature === f && (r ? x.restaurant_id === r : x.vendor_id === v));
    const cell = (f, r, v) => {
      const x = get(f, r, v); const st = x?.status || "off"; const [lab, cls] = FA_BADGE[st];
      return `<td><span class="badge ${cls}">${lab}</span>${x?.request_note && st === "requested" ? `<div class="small muted">“${esc(x.request_note)}”</div>` : ""}
        ${isSuper() ? `<div class="row" style="gap:.3rem;margin-top:.3rem">${st !== "active" ? `<button class="btn sm primary" data-on="${f}|${r || ""}|${v || ""}">Switch on</button>` : ""}
          ${st === "active" || st === "requested" ? `<button class="btn sm" data-off="${f}|${r || ""}|${v || ""}">${st === "requested" ? "Decline" : "Switch off"}</button>` : ""}</div>` : ""}</td>`;
    };
    const pending = fa.filter((x) => x.status === "requested");
    if (tab === 0) {
      $("#body").innerHTML = `${pending.length ? `<div class="card" style="border-left:4px solid var(--warn)"><b>${pending.length} request(s) waiting</b> — ${pending.map((x) => esc(FEATURE_LABEL[x.feature]) + " for " + esc((rests.find((r) => r.id === x.restaurant_id) || vends.find((v) => v.id === x.vendor_id))?.name || "")).join(" · ")}</div>` : ""}
        <div class="table-wrap"><table><thead><tr><th>Restaurant</th><th>${FEATURE_LABEL.auto_order}</th></tr></thead><tbody>
        ${rests.filter((r) => r.active).map((r) => `<tr><td>${esc(r.name)}</td>${cell("auto_order", r.id, null)}</tr>`).join("") || '<tr><td colspan="2" class="empty">No restaurants.</td></tr>'}
        </tbody></table></div>`;
    } else {
      $("#body").innerHTML = `<div class="table-wrap"><table><thead><tr><th>Vendor</th><th>${FEATURE_LABEL.vendor_orders}</th><th>${FEATURE_LABEL.vendor_products}</th></tr></thead><tbody>
        ${vends.filter((v) => v.approval === "approved").map((v) => `<tr><td>${esc(v.name)}${v.active ? "" : ' <span class="badge">inactive</span>'}</td>${cell("vendor_orders", null, v.id)}${cell("vendor_products", null, v.id)}</tr>`).join("") || '<tr><td colspan="3" class="empty">No approved vendors.</td></tr>'}
        </tbody></table></div><p class="small muted">Vendors need a vendor login (Vendors → Edit → Portal login) or can register on the website.</p>`;
    }
    const act = async (s, on) => {
      const [f, r, v] = s.split("|");
      let note = null;
      if (!on) { note = await promptBox(on ? "" : "Switch off / decline", "Note to them (optional)"); if (note === null) return; }
      await q(sb.rpc("boh_set_feature", { p_feature: f, p_restaurant: r || null, p_vendor: v || null, p_on: on, p_note: note || null }));
      toast(on ? "Switched on — they've been notified" : "Done"); load(tab);
    };
    $$("[data-on]", el).forEach((b) => (b.onclick = () => act(b.dataset.on, true)));
    $$("[data-off]", el).forEach((b) => (b.onclick = () => act(b.dataset.off, false)));
  };
  tabs($("#t"), ["Restaurants", "Vendors"], load);
}

// ====================================================================== SHOP: listings
async function bestRates(pids) {
  if (!pids.length) return {};
  const rows = await q(sb.from("boh_product_best_rate").select("product_id, rate, vendor_name").in("product_id", pids));
  return Object.fromEntries(rows.map((r) => [r.product_id, r]));
}

export async function shop(el) {
  el.innerHTML = `
    <div class="page-head"><div><h1>Online shop</h1><div class="muted">Choose which products to sell on the website, at what price. Description and photo are compulsory; price can never be below our lowest vendor rate.</div></div>
      <button class="btn primary" id="add">+ Add product to shop</button></div>
    <div class="tabs" id="t"></div><div id="body"></div>`;
  $("#add").onclick = () => listingEditor(null, () => tabs($("#t"), TABS, show, 0));
  const TABS = ["Products on shop", "Orders", "Shop settings"];
  const show = (i) => (i === 0 ? listings($("#body")) : i === 1 ? shopOrders($("#body")) : shopSettings($("#body")));
  tabs($("#t"), TABS, show, location.hash.includes("orders") ? 1 : 0);
}

async function listings(box) {
  const rows = await q(sb.from("boh_shop_listings").select("*, product:boh_products(name, unit, active, category:boh_categories(name))").order("sort").order("title"));
  const best = await bestRates(rows.map((r) => r.product_id));
  box.innerHTML = `<div class="table-wrap"><table><thead><tr><th></th><th>Product</th><th class="right">Shop price</th><th class="right">Our cost</th><th class="right">Margin</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((l) => { const b = best[l.product_id]; const m = b ? ((l.price / b.rate - 1) * 100) : null;
      return `<tr><td>${l.images?.[0] ? `<img src="${esc(l.images[0])}" style="width:48px;height:48px;object-fit:cover;border-radius:6px">` : ""}</td>
      <td><b>${esc(l.title)}</b>${l.featured ? ' <span class="badge info">Featured</span>' : ""}<div class="small muted">${esc(l.product?.category?.name || "")} · ${esc(l.unit_label || l.product?.unit || "")}${l.min_qty > 1 ? " · min " + num(l.min_qty, 3) : ""}</div></td>
      <td class="right"><b>${money(l.price)}</b>${l.mrp ? `<div class="small muted"><s>${money(l.mrp)}</s></div>` : ""}</td>
      <td class="right">${b ? money(b.rate) + `<div class="small muted">${esc(b.vendor_name)}</div>` : '<span class="badge danger">No vendor rate</span>'}</td>
      <td class="right" style="color:${m == null ? "inherit" : m < 0 ? "var(--danger)" : m < 10 ? "var(--warn)" : "inherit"}">${m == null ? "—" : m.toFixed(1) + "%"}</td>
      <td>${l.active && b && l.product?.active ? '<span class="badge ok">Live</span>' : '<span class="badge">Hidden</span>'}</td>
      <td class="right"><button class="btn sm" data-ed="${l.id}">Edit</button></td></tr>`; }).join("") || '<tr><td colspan="7" class="empty">Nothing on the shop yet — click “Add product to shop”.</td></tr>'}
    </tbody></table></div>`;
  $$("[data-ed]", box).forEach((b) => (b.onclick = () => listingEditor(rows.find((r) => r.id === b.dataset.ed), () => listings(box))));
}

export async function listingEditor(l, done, presetProduct = null) {
  const prods = await q(sb.from("boh_products").select("id, name, unit, brand, description, image_url, category:boh_categories(name)").eq("active", true).order("name"));
  const taken = new Set((await q(sb.from("boh_shop_listings").select("product_id"))).map((x) => x.product_id));
  const pid0 = l?.product_id || presetProduct || "";
  let images = [...(l?.images || [])];
  const m = modal({
    wide: true,
    title: l ? `Edit shop listing — ${l.title}` : "Add product to shop",
    body: `<div class="form-grid">
      <div class="field" style="grid-column:1/-1"><label>Product from our list *</label><select id="pid" ${l ? "disabled" : ""}><option value="">— choose —</option>
        ${prods.filter((p) => p.id === pid0 || !taken.has(p.id)).map((p) => `<option value="${p.id}" ${p.id === pid0 ? "selected" : ""}>${esc(p.name)}${p.brand ? " · " + esc(p.brand) : ""} (${esc(p.unit)}) — ${esc(p.category?.name || "")}</option>`).join("")}</select>
        <div class="small" id="cost"></div></div>
      <div class="field"><label>Title on website *</label><input id="ti" value="${esc(l?.title || "")}"></div>
      <div class="field"><label>Unit shown (optional)</label><input id="un" value="${esc(l?.unit_label || "")}" placeholder="e.g. pack of 100"></div>
      <div class="field"><label>Shop price (₹) *</label><input id="pr" type="number" step="0.01" min="0" value="${l?.price ?? ""}"><div class="small" id="mg"></div></div>
      <div class="field"><label>MRP (₹, optional — shown struck through)</label><input id="mrp" type="number" step="0.01" min="0" value="${l?.mrp ?? ""}"></div>
      <div class="field"><label>Minimum quantity</label><input id="mq" type="number" step="any" min="0" value="${l?.min_qty ?? 1}"></div>
      <div class="field"><label>Sort order</label><input id="so" type="number" value="${l?.sort ?? 0}"></div>
      <div class="field" style="grid-column:1/-1"><label>Description * <span class="small muted">(at least 20 characters — what it is, size, material, best use)</span></label><textarea id="de" rows="4">${esc(l?.description || "")}</textarea></div>
      <div class="field" style="grid-column:1/-1"><label>Photos * (first one is the main photo)</label><div class="row" id="imgs" style="flex-wrap:wrap;gap:.5rem"></div>
        <div class="row" style="margin-top:.4rem"><input type="file" id="up" accept="image/*" multiple style="max-width:280px"><button class="btn sm" type="button" id="useprod">Use product photo</button></div></div>
      <label class="row" style="gap:.4rem"><input type="checkbox" id="ac" ${l?.active !== false ? "checked" : ""}> Live on website</label>
      <label class="row" style="gap:.4rem"><input type="checkbox" id="fe" ${l?.featured ? "checked" : ""}> Featured (shown first)</label>
    </div>`,
    footer: `${l ? '<button class="btn danger" id="del">Remove from shop</button>' : ""}<button class="btn primary" id="save">Save</button>`,
  });
  const E = (s) => $(s, m.el);
  let best = null;
  const drawImgs = () => { E("#imgs").innerHTML = images.map((u, i) => `<div style="position:relative"><img src="${esc(u)}" style="width:80px;height:80px;object-fit:cover;border-radius:8px;${i === 0 ? "outline:2px solid var(--brand)" : ""}">
    <button class="btn sm" data-rm="${i}" style="position:absolute;top:2px;right:2px;padding:0 .35rem">×</button>${i ? `<button class="btn sm" data-main="${i}" style="position:absolute;bottom:2px;left:2px;padding:0 .35rem;font-size:.65rem">Main</button>` : ""}</div>`).join("") || '<span class="small muted">No photo yet</span>';
    $$("[data-rm]", m.el).forEach((b) => (b.onclick = () => { images.splice(+b.dataset.rm, 1); drawImgs(); }));
    $$("[data-main]", m.el).forEach((b) => (b.onclick = () => { const [x] = images.splice(+b.dataset.main, 1); images.unshift(x); drawImgs(); })); };
  const margin = () => {
    const p = Number(E("#pr").value);
    if (!best) { E("#mg").innerHTML = ""; return; }
    if (!p) { E("#mg").innerHTML = `<span class="muted">Lowest allowed: ${money(best.rate)}</span>`; return; }
    const mg = (p / best.rate - 1) * 100;
    E("#mg").innerHTML = p < best.rate ? `<span style="color:var(--danger)">Below our lowest vendor rate ${money(best.rate)} — not allowed</span>`
      : `<span style="color:${mg < 10 ? "var(--warn)" : "var(--ok)"}">Margin ${mg.toFixed(1)}% over lowest vendor rate ${money(best.rate)}</span>`;
  };
  const pick = async () => {
    const p = prods.find((x) => x.id === E("#pid").value);
    best = p ? (await bestRates([p.id]))[p.id] || null : null;
    E("#cost").innerHTML = !p ? "" : best ? `Our lowest cost: <b>${money(best.rate)}</b> / ${esc(p.unit)} (${esc(best.vendor_name)})` : '<span style="color:var(--danger)">No active vendor rate — add one in Products & rates first.</span>';
    if (p && !l) { if (!E("#ti").value) E("#ti").value = p.name; if (!E("#de").value && p.description) E("#de").value = p.description; if (!images.length && p.image_url) { images = [p.image_url]; drawImgs(); } }
    margin();
  };
  E("#pid").onchange = pick; E("#pr").oninput = margin;
  E("#useprod").onclick = () => { const p = prods.find((x) => x.id === E("#pid").value); if (p?.image_url) { images.unshift(p.image_url); drawImgs(); } else toast("This product has no photo", true); };
  E("#up").onchange = async (e) => { for (const f of e.target.files) images.push(await uploadImage(f, "shop")); drawImgs(); e.target.value = ""; };
  drawImgs(); if (pid0) pick();
  E("#save").onclick = async () => {
    const pid = E("#pid").value, price = Number(E("#pr").value), desc = E("#de").value.trim(), title = E("#ti").value.trim();
    if (!pid) return toast("Choose the product", true);
    if (title.length < 3) return toast("Enter a title", true);
    if (!(price > 0)) return toast("Enter the shop price", true);
    if (desc.length < 20) return toast("Description is compulsory — at least 20 characters", true);
    if (!images.length) return toast("Add at least one photo", true);
    if (!best) return toast("This product has no active vendor rate — add one first", true);
    if (price < best.rate) return toast(`Price is below our lowest vendor rate ${money(best.rate)}`, true);
    const mrp = E("#mrp").value ? Number(E("#mrp").value) : null;
    if (mrp != null && mrp < price) return toast("MRP cannot be lower than the selling price", true);
    if ((price / best.rate - 1) * 100 < 10 && !(await confirmBox(`Margin is only ${((price / best.rate - 1) * 100).toFixed(1)}% over our cost. Save anyway?`))) return;
    const row = { product_id: pid, title, description: desc, images, price, mrp, unit_label: E("#un").value.trim() || null, min_qty: Number(E("#mq").value) || 1,
      sort: Number(E("#so").value) || 0, active: E("#ac").checked, featured: E("#fe").checked, updated_by: state.me.id };
    if (l) await q(sb.from("boh_shop_listings").update(row).eq("id", l.id)); else await q(sb.from("boh_shop_listings").insert(row));
    toast("Saved"); m.close(); done?.();
  };
  E("#del")?.addEventListener("click", async () => {
    if (!(await confirmBox(`Remove ${l.title} from the website shop?`))) return;
    await q(sb.from("boh_shop_listings").delete().eq("id", l.id)); toast("Removed"); m.close(); done?.();
  });
}

// ====================================================================== SHOP: orders
const SO_STATUS = { placed: ["New", "warn"], confirmed: ["Confirmed", "info"], dispatched: ["Dispatched", "info"], delivered: ["Delivered", "ok"], cancelled: ["Cancelled", "danger"] };
const SO_PAY = { unpaid: ["Unpaid", "danger"], under_review: ["Paid? — verify", "warn"], paid: ["Paid", "ok"] };
async function shopOrders(box) {
  box.innerHTML = `<div class="row" style="margin-bottom:.6rem"><select id="fs" style="max-width:200px"><option value="open">Open</option><option value="">All</option>${Object.entries(SO_STATUS).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join("")}</select>
    <button class="btn sm" id="csv">Export CSV</button></div><div id="ol"></div>`;
  let rows = [];
  const load = async () => {
    let qq = sb.from("boh_shop_orders").select("*, items:boh_shop_order_items(*)").order("created_at", { ascending: false }).limit(300);
    const f = $("#fs", box).value;
    if (f === "open") qq = qq.not("status", "in", "(delivered,cancelled)"); else if (f) qq = qq.eq("status", f);
    rows = await q(qq);
    $("#ol", box).innerHTML = `<div class="table-wrap"><table><thead><tr><th>Order</th><th>Buyer</th><th>Items</th><th class="right">Total</th><th>Payment</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((o) => `<tr><td><b>W${o.order_no}</b><div class="small muted">${fmtDT(o.created_at)}</div></td>
        <td>${esc(o.ship_name)}${o.business_name ? `<div class="small">${esc(o.business_name)}</div>` : ""}<div class="small phones">📞 ${telLinks([o.ship_phone])}</div><div class="small muted">${esc([o.ship_address, o.ship_city, o.ship_pincode].filter(Boolean).join(", "))}</div></td>
        <td class="small">${o.items.map((i) => `${esc(i.title)} × ${num(i.qty, 3)}`).join("<br>")}</td>
        <td class="right"><b>${money(o.total)}</b><div class="small muted">margin ${money(o.subtotal - o.cost_total)}</div></td>
        <td><span class="badge ${SO_PAY[o.payment_status][1]}">${SO_PAY[o.payment_status][0]}</span><div class="small muted">${o.payment_mode === "cod" ? "Cash on delivery" : "UPI / bank"}${o.payment_ref ? " · ref " + esc(o.payment_ref) : ""}</div></td>
        <td><span class="badge ${SO_STATUS[o.status][1]}">${SO_STATUS[o.status][0]}</span></td>
        <td class="right" style="white-space:nowrap">${actionButtons(o)}</td></tr>`).join("") || '<tr><td colspan="7" class="empty">No shop orders.</td></tr>'}
      </tbody></table></div>`;
    $$("[data-sa]", box).forEach((b) => (b.onclick = async () => {
      const [id, act] = b.dataset.sa.split("|");
      let note = null;
      if (["cancel", "reject_payment", "dispatch"].includes(act)) {
        note = await promptBox(act === "dispatch" ? "Dispatch note" : "Reason", act === "dispatch" ? "Tracking / porter details (optional)" : "Tell the buyer why");
        if (note === null) return;
        if (act !== "dispatch" && !note.trim()) return toast("Please give a reason", true);
      } else if (!(await confirmBox(b.textContent.trim() + "?"))) return;
      await q(sb.rpc("boh_shop_update", { p_order: id, p_action: act, p_note: note || null }));
      toast("Updated — buyer notified"); load();
    }));
  };
  $("#fs", box).onchange = load;
  $("#csv", box).onclick = () => downloadCSV("shop-orders.csv", rows.map((o) => ({ order: "W" + o.order_no, date: o.created_at, buyer: o.ship_name, phone: o.ship_phone, status: o.status, payment: o.payment_status, mode: o.payment_mode, subtotal: o.subtotal, delivery: o.delivery_fee, total: o.total, cost: o.cost_total })));
  load();
}
function actionButtons(o) {
  const b = (act, label, cls = "") => `<button class="btn sm ${cls}" data-sa="${o.id}|${act}">${label}</button>`;
  const out = [];
  if (o.status === "placed") out.push(b("confirm", "Confirm", "primary"));
  if (["placed", "confirmed"].includes(o.status)) out.push(b("dispatch", "Dispatch"));
  if (["confirmed", "dispatched"].includes(o.status)) out.push(b("deliver", "Delivered", "primary"));
  if (o.payment_status === "under_review") out.push(b("paid", "Approve payment", "primary"), b("reject_payment", "Reject payment"));
  else if (o.payment_status === "unpaid" && o.status !== "cancelled") out.push(b("paid", "Mark paid"));
  if (!["delivered", "cancelled"].includes(o.status)) out.push(b("cancel", "Cancel", "danger"));
  return out.join(" ");
}

async function shopSettings(box) {
  const s = (await q(sb.from("boh_settings").select("*").eq("id", 1).single()));
  const ro = !isSuper();
  box.innerHTML = `<div class="card" style="max-width:760px"><form id="f" class="form-grid">
    <label class="row" style="gap:.4rem;grid-column:1/-1"><input type="checkbox" name="shop_enabled" ${s.shop_enabled ? "checked" : ""}> <b>Shop open</b> — products can be bought on the website</label>
    <div class="field"><label>Delivery charge (₹)</label><input name="shop_delivery_fee" type="number" step="0.01" min="0" value="${s.shop_delivery_fee ?? 0}"></div>
    <div class="field"><label>Free delivery above (₹, optional)</label><input name="shop_free_above" type="number" step="0.01" min="0" value="${s.shop_free_above ?? ""}"></div>
    <div class="field"><label>Minimum order value (₹)</label><input name="shop_min_order" type="number" step="0.01" min="0" value="${s.shop_min_order ?? 0}"></div>
    <div class="field"><label>Delivery area (shown on website)</label><input name="shop_area" value="${esc(s.shop_area || "")}" placeholder="e.g. Mumbai & Thane"></div>
    <div class="field"><label>Website phone</label><input name="site_phone" value="${esc(s.site_phone || "")}"></div>
    <div class="field"><label>Website WhatsApp number</label><input name="site_whatsapp" value="${esc(s.site_whatsapp || "")}" placeholder="919876543210"></div>
    <div class="field"><label>Website email</label><input name="site_email" value="${esc(s.site_email || "")}" placeholder="orders@backofhouseco.in"></div>
    <div class="field" style="grid-column:1/-1"><label>Address (website footer)</label><input name="site_address" value="${esc(s.site_address || "")}"></div>
    ${ro ? '<p class="small muted" style="grid-column:1/-1">Only the super admin can change these.</p>' : '<div style="grid-column:1/-1"><button class="btn primary">Save shop settings</button></div>'}
  </form><p class="small muted">Payment QR / UPI and bank details for shop orders come from Settings → Payment details.</p></div>`;
  if (ro) { $$("input", box).forEach((i) => (i.disabled = true)); return; }
  $("#f", box).onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const n = (k) => (f[k] === "" || f[k] == null ? null : Number(f[k]));
    await q(sb.from("boh_settings").update({ shop_enabled: !!f.shop_enabled, shop_delivery_fee: n("shop_delivery_fee") || 0, shop_free_above: n("shop_free_above"),
      shop_min_order: n("shop_min_order") || 0, shop_area: f.shop_area || null, site_phone: f.site_phone || null, site_whatsapp: f.site_whatsapp || null,
      site_email: f.site_email || null, site_address: f.site_address || null }).eq("id", 1));
    toast("Shop settings saved");
  };
}

// ====================================================================== WEBSITE LEADS
const LEAD_ST = { new: ["New", "warn"], contacted: ["Contacted", "info"], converted: ["Converted", "ok"], dropped: ["Dropped", ""] };
export async function leads(el) {
  el.innerHTML = `<div class="page-head"><div><h1>Website enquiries</h1><div class="muted">People who filled the contact / services form on backofhouseco.in.</div></div>
    <div class="row"><select id="st" style="max-width:180px"><option value="open">Open</option><option value="">All</option>${Object.entries(LEAD_ST).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join("")}</select><button class="btn sm" id="csv">CSV</button></div></div><div id="list"></div>`;
  let rows = [];
  const load = async () => {
    let qq = sb.from("boh_leads").select("*").order("created_at", { ascending: false }).limit(500);
    const st = $("#st").value; if (st === "open") qq = qq.in("status", ["new", "contacted"]); else if (st) qq = qq.eq("status", st);
    rows = await q(qq);
    $("#list").innerHTML = `<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Service</th><th>Message</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${fmtDT(r.created_at)}</td><td><b>${esc(r.name)}</b>${r.company ? `<div class="small">${esc(r.company)}</div>` : ""}<div class="small phones">📞 ${telLinks([r.phone])}${r.email ? ` · <a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : ""}</div>${r.city ? `<div class="small muted">${esc(r.city)}</div>` : ""}</td>
        <td>${esc(r.service || "—")}</td><td class="small" style="max-width:320px">${esc(r.message || "")}${r.admin_note ? `<div class="muted">Note: ${esc(r.admin_note)}</div>` : ""}</td>
        <td><span class="badge ${LEAD_ST[r.status][1]}">${LEAD_ST[r.status][0]}</span></td>
        <td><select data-ls="${r.id}" style="max-width:150px">${Object.entries(LEAD_ST).map(([k, v]) => `<option value="${k}" ${k === r.status ? "selected" : ""}>${v[0]}</option>`).join("")}</select>
          <button class="btn sm" data-ln="${r.id}">Note</button></td></tr>`).join("") || '<tr><td colspan="6" class="empty">No enquiries.</td></tr>'}</tbody></table></div>`;
    $$("[data-ls]", el).forEach((s) => (s.onchange = async () => { await q(sb.from("boh_leads").update({ status: s.value, updated_at: new Date().toISOString() }).eq("id", s.dataset.ls)); toast("Updated"); load(); }));
    $$("[data-ln]", el).forEach((b) => (b.onclick = async () => { const r = rows.find((x) => x.id === b.dataset.ln); const n = await promptBox("Note", "Internal note", r.admin_note || ""); if (n === null) return;
      await q(sb.from("boh_leads").update({ admin_note: n || null, updated_at: new Date().toISOString() }).eq("id", r.id)); load(); }));
  };
  $("#st").onchange = load;
  $("#csv").onclick = () => downloadCSV("website-enquiries.csv", rows.map(({ id, ...r }) => r));
  load();
}

// ====================================================================== VENDOR OFFERS (products / rates offered by vendors)
export async function vendorOffers(el) {
  el.innerHTML = `<div class="page-head"><div><h1>Vendor offers</h1><div class="muted">New products and rate changes sent by vendors from the vendor portal. Approving adds the vendor's rate (and creates the product if new).</div></div>
    <select id="st" style="max-width:180px"><option value="pending">Waiting</option><option value="">All</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></div><div id="list"></div>`;
  const cats = await q(sb.from("boh_categories").select("id, name").order("name"));
  const load = async () => {
    let qq = sb.from("boh_vendor_offers").select("*, vendor:boh_vendors(name, phones), category:boh_categories(name)").order("created_at", { ascending: false });
    if ($("#st").value) qq = qq.eq("status", $("#st").value);
    const rows = await q(qq);
    const best = await bestRates(rows.map((r) => r.product_id).filter(Boolean));
    $("#list").innerHTML = `<div class="table-wrap"><table><thead><tr><th>When</th><th>Vendor</th><th>Product</th><th class="right">Their rate</th><th class="right">Our best now</th><th>For</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${fmtD(r.created_at)}</td><td>${esc(r.vendor?.name)}<div class="small phones">📞 ${telLinks(r.vendor?.phones)}</div></td>
        <td>${r.image_url ? `<img src="${esc(r.image_url)}" style="width:40px;height:40px;object-fit:cover;border-radius:6px;float:left;margin-right:.4rem">` : ""}<b>${esc(r.name)}</b> ${r.product_id ? '<span class="badge info">rate update</span>' : '<span class="badge warn">new product</span>'}
          <div class="small muted">${esc(r.category?.name || "no category")} · ${esc(r.unit)}${r.brand ? " · " + esc(r.brand) : ""}${r.min_qty ? " · min " + num(r.min_qty, 3) : ""}</div>${r.description ? `<div class="small">${esc(r.description)}</div>` : ""}</td>
        <td class="right"><b>${money(r.rate)}</b></td><td class="right">${r.product_id && best[r.product_id] ? money(best[r.product_id].rate) + `<div class="small muted">${esc(best[r.product_id].vendor_name)}</div>` : "—"}</td>
        <td class="small">${[r.for_clients ? "Our clients" : "", r.for_shop ? "Online shop" : ""].filter(Boolean).join(" + ")}</td>
        <td>${r.status === "pending" ? '<span class="badge warn">Waiting</span>' : r.status === "approved" ? '<span class="badge ok">Approved</span>' : '<span class="badge danger">Rejected</span>'}${r.admin_note ? `<div class="small muted">${esc(r.admin_note)}</div>` : ""}</td>
        <td class="right" style="white-space:nowrap">${r.status === "pending" ? `<button class="btn sm primary" data-ap="${r.id}">Review</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="8" class="empty">Nothing here.</td></tr>'}</tbody></table></div>`;
    $$("[data-ap]", el).forEach((b) => (b.onclick = () => reviewOffer(rows.find((r) => r.id === b.dataset.ap), cats, load)));
  };
  $("#st").onchange = load; load();
}
async function reviewOffer(o, cats, reload) {
  const m = modal({
    title: `Review offer — ${o.name}`,
    body: `<p class="small">${esc(o.vendor?.name)} offers <b>${esc(o.name)}</b> at <b>${money(o.rate)}</b> / ${esc(o.unit)}.</p>
      ${o.product_id ? "" : `<div class="form-grid"><div class="field"><label>Product name</label><input id="nm" value="${esc(o.name)}"></div>
        <div class="field"><label>Unit</label><input id="un" value="${esc(o.unit)}"></div>
        <div class="field"><label>Category *</label><select id="ca"><option value="">— choose —</option>${cats.map((c) => `<option value="${c.id}" ${c.id === o.category_id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
        <label class="row" style="gap:.4rem"><input type="checkbox" id="fc" ${o.for_clients ? "checked" : ""}> Show to our restaurant clients (catalogue)</label></div>`}
      <div class="field"><label>Rate we accept (₹)</label><input id="rt" type="number" step="0.01" value="${o.rate}"></div>
      <div class="field"><label>Note to vendor (optional)</label><input id="nt"></div>
      ${o.for_shop ? '<p class="small">The vendor would also like this on the <b>online shop</b> — after approving you can add a shop listing.</p>' : ""}`,
    footer: `<button class="btn danger" id="rej">Reject</button><button class="btn primary" id="ok">Approve</button>`,
  });
  const E = (s) => $(s, m.el);
  E("#rej").onclick = async () => { await q(sb.rpc("boh_review_offer", { p_offer: o.id, p_approve: false, p_note: E("#nt").value.trim() || null })); toast("Rejected — vendor notified"); m.close(); reload(); };
  E("#ok").onclick = async () => {
    if (!o.product_id && !E("#ca").value) return toast("Pick a category", true);
    const pid = await q(sb.rpc("boh_review_offer", { p_offer: o.id, p_approve: true, p_category: E("#ca")?.value || null, p_name: E("#nm")?.value || null,
      p_unit: E("#un")?.value || null, p_rate: Number(E("#rt").value) || null, p_for_clients: E("#fc") ? E("#fc").checked : null, p_note: E("#nt").value.trim() || null }));
    toast("Approved — vendor notified"); m.close(); reload();
    if (o.for_shop && pid && (await confirmBox("Add this product to the online shop now?"))) listingEditor(null, null, pid);
  };
}

// ====================================================================== VENDOR approval + portal login (used from Vendors page)
export async function reviewVendor(v, reload) {
  const m = modal({
    title: `Vendor registration — ${v.name}`,
    body: `<p><b>${esc(v.name)}</b>${v.contact_person ? " · " + esc(v.contact_person) : ""}</p><p class="small phones">📞 ${telLinks(v.phones)} ${v.email ? "· " + esc(v.email) : ""}</p>
      ${v.address ? `<p class="small">${esc(v.address)}</p>` : ""}${v.gstin ? `<p class="small">GSTIN ${esc(v.gstin)}</p>` : ""}${v.signup_note ? `<p class="small">Supplies: ${esc(v.signup_note)}</p>` : ""}
      <div class="field"><label>Note to vendor (optional)</label><input id="nt"></div>`,
    footer: `<button class="btn danger" id="rej">Reject</button><button class="btn primary" id="ok">Approve</button>`,
  });
  const go = async (ok) => { await q(sb.rpc("boh_review_vendor", { p_vendor: v.id, p_approve: ok, p_note: $("#nt", m.el).value.trim() || null })); toast(ok ? "Approved — add their rates, and switch on portal features in Feature access" : "Rejected"); m.close(); reload(); };
  $("#ok", m.el).onclick = () => go(true); $("#rej", m.el).onclick = () => go(false);
}

export async function vendorLogins(v) {
  const users = await q(sb.from("boh_users").select("id, full_name, email, phone, active").eq("vendor_id", v.id));
  const m = modal({
    title: `Portal logins — ${v.name}`,
    body: `${users.length ? `<table><tbody>${users.map((u) => `<tr><td>${esc(u.full_name)}<div class="small muted">${esc(u.email)}</div></td><td>${u.active ? '<span class="badge ok">Active</span>' : '<span class="badge">Off</span>'}</td>
        <td><button class="btn sm" data-tg="${u.id}" data-on="${u.active}">${u.active ? "Deactivate" : "Activate"}</button></td></tr>`).join("")}</tbody></table>` : '<p class="muted">No portal login yet.</p>'}
      <h3 style="margin-top:1rem">Create a login</h3><div class="form-grid">
      <div class="field"><label>Name</label><input id="nm" value="${esc(v.contact_person || "")}"></div>
      <div class="field"><label>Email (login)</label><input id="em" type="email" value="${esc(v.email || "")}"></div>
      <div class="field"><label>Phone (WhatsApp)</label><input id="ph" value="${esc(v.phones?.[0] || "")}"></div>
      <div class="field"><label>Password</label><input id="pw" type="text" value="Boh@${Math.random().toString(36).slice(2, 8)}"></div></div>`,
    footer: `<button class="btn primary" id="cr">Create login</button>`,
  });
  const E = (s) => $(s, m.el);
  $$("[data-tg]", m.el).forEach((b) => (b.onclick = async () => { await q(sb.from("boh_users").update({ active: b.dataset.on !== "true" }).eq("id", b.dataset.tg)); toast("Updated"); m.close(); vendorLogins(v); }));
  E("#cr").onclick = async () => {
    const em = E("#em").value.trim(), pw = E("#pw").value.trim();
    if (!em || pw.length < 8) return toast("Enter email and a password of at least 8 characters", true);
    await callUsersFn({ action: "create_user", role: "vendor", vendor_id: v.id, full_name: E("#nm").value.trim() || v.name, email: em, phone: E("#ph").value.trim() || null, password: pw });
    toast("Vendor login created — share the email and password with them"); m.close(); vendorLogins(v);
  };
}
