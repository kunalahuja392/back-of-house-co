import { sb, state, $, $$, esc, money, fmtDT, fmtD, q, statusBadge, payBadge, PAY_MODE, dueText, allocSteps, telLinks, DELIVERY_LABEL, orderAlloc, flowGuide, flowHTML, openBill } from "./lib.js?v=22";
import { orderModal, advanceOrder, changeVendor, paymentButtons, bindPaymentButtons, paymentAction } from "./admin.js?v=22";

// one card per order allocated to me: where it is, what to do now, whom to call
export async function tasks(el) {
  const s = state.settings;
  el.innerHTML = `
    <div class="page-head"><div><h1>My orders</h1>
      <div class="muted">Each card shows where the order is and the one thing to do next. Order flow: acknowledge (${s.sla_ack_hrs} working hr) → order with vendors (${s.sla_vendor_order_hrs} hrs) → follow-ups → delivered → collect payment (within ${s.sla_payment_hrs} working hrs of delivery).</div></div>
      <div class="row"><select id="st" style="max-width:240px"><option value="open">To do (not yet paid)</option><option value="pay">Payments to collect / verify</option><option value="done">Completed (last 30 days)</option></select>
      <a class="btn" href="#/billing?new=1">+ New bill</a></div></div>
    <div id="list"></div>`;
  const load = async () => {
    const mode = $("#st").value;
    const mine = await q(sb.from("boh_order_allocations").select("order_id").eq("coordinator_id", state.me.id));
    const mine2 = await q(sb.from("boh_orders").select("id").eq("coordinator_id", state.me.id));
    const ids = [...new Set([...mine.map((x) => x.order_id), ...mine2.map((x) => x.id)])];
    let orders = ids.length ? await q(sb.from("boh_orders").select("*, allocs:boh_order_allocations(*), restaurant:boh_restaurants(name,phone,address)").in("id", ids)) : [];
    orders = orders.filter((o) =>
      mode === "open" ? o.status !== "cancelled" && !(o.payment_status === "paid" && ["delivered", "paid"].includes(o.status))
      : mode === "pay" ? o.status !== "cancelled" && o.payment_status !== "paid" && (o.payment_status === "under_review" || o.payment_mode === "prepaid" || o.status === "delivered")
      : (o.status === "cancelled" || (o.payment_status === "paid" && ["delivered", "paid"].includes(o.status))) && Date.now() - new Date(o.created_at) < 30 * 86400000);
    const oids = orders.map((o) => o.id);
    const items = oids.length ? await q(sb.from("boh_order_items").select("order_id, product_id, product_name, qty, unit, unit_price, unit_cost, vendor_id, vendor_name, delivery_style, vendor:boh_vendors(phones)").in("order_id", oids)) : [];
    const dueOf = (o) => { const A = orderAlloc(o); const st = A ? allocSteps(o, A).find((x) => !x.at) : null; return st?.due || null; };
    // most urgent first: payments to verify, then by SLA due time
    orders.sort((x, y) => (y.payment_status === "under_review") - (x.payment_status === "under_review") || (dueOf(x)?.getTime() ?? 9e15) - (dueOf(y)?.getTime() ?? 9e15));

    $("#list").innerHTML = orders.map((o) => {
      const A = orderAlloc(o);
      const g = flowGuide(o, A);
      const lines = items.filter((i) => i.order_id === o.id);
      const vend = {};
      lines.forEach((i) => { (vend[i.vendor_id || "x"] ||= { id: i.vendor_id, name: i.vendor_name, style: i.delivery_style, phones: i.vendor?.phones, lines: [] }).lines.push(i); });
      const due = dueOf(o);
      const working = !g.done && g.idx >= 1 && g.idx <= 4;
      const showVendors = mode !== "pay" && (working || mode === "done");
      return `<div class="card">
        <div class="row between"><div><h2 style="margin:0">#${o.order_no} · ${esc(o.restaurant?.name)} · ${money(o.total)}</h2>
          <div class="small muted">Placed ${fmtDT(o.created_at)}${o.source === "backend" ? " (bill)" : ""} · Delivery ${fmtD(o.delivery_date)} · 📞 ${telLinks([o.restaurant?.phone])} · ${esc(o.restaurant?.address || "")}</div></div>
          <div class="row">${payBadge(o)} ${due && working ? dueText(due) : ""}</div></div>
        ${flowHTML(o, A)}
        ${showVendors && lines.length ? `<div class="small"><b>${g.idx === 2 ? "Call these vendors now:" : "Vendors on this order:"}</b> <span class="muted">(each item is with the cheapest active vendor)</span></div>
        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:.5rem;margin:.4rem 0 .75rem">
          ${Object.values(vend).map((v) => `<div style="background:#faf8f4;border-radius:8px;padding:.5rem .7rem">
            <div class="row between"><b>🏪 ${esc(v.name || "No vendor")}</b> <span class="badge info">${esc(DELIVERY_LABEL[v.style] || "")}</span></div>
            <div class="small phones">📞 ${telLinks(v.phones)}</div>
            <div class="small" style="margin-top:.3rem">${v.lines.map((l) => `${esc(l.product_name)} — <b>${Number(l.qty)} ${esc(l.unit || "")}</b>`).join("<br>")}</div>
            ${working && v.id ? `<div style="margin-top:.4rem"><button class="btn sm" data-chv="${v.id}" data-oid="${o.id}">⇄ Not responding? Change vendor</button></div>` : ""}</div>`).join("")}
        </div>` : ""}
        ${o.payment_status === "under_review" ? `<div class="small">Restaurant says paid${o.payment_claim_method ? " via " + esc(o.payment_claim_method) : ""} · ref <b>${esc(o.payment_claim_ref)}</b> · ${fmtDT(o.payment_claimed_at)}</div>` : ""}
        ${o.payment_status === "unpaid" && o.payment_rejected_note ? `<div class="small" style="color:var(--danger)">Last payment claim rejected: ${esc(o.payment_rejected_note)}</div>` : ""}
        <div class="row" style="justify-content:flex-end;margin-top:.4rem">
          <button class="btn" data-bill="${o.id}">🧾 Bill</button>
          <button class="btn" data-open="${o.id}">Open order</button>
          ${g.done ? "" : g.action?.pay ? paymentButtons(o) : g.action?.step ? `${g.alt ? `<button class="btn" data-adv="${o.id}" data-step="${g.alt.step}">${g.alt.label}</button>` : ""}<button class="btn primary" data-adv="${o.id}" data-step="${g.action.step}">${g.action.label}</button>`
            : o.payment_status !== "paid" && o.payment_mode === "prepaid" ? paymentButtons(o) : ""}
        </div></div>`;
    }).join("") || `<div class="card empty">${mode === "open" ? "Nothing waiting on you 🎉" : mode === "pay" ? "No payments to collect or verify." : "Nothing completed recently."}</div>`;
    $$("[data-chv]", el).forEach((b) => (b.onclick = () => changeVendor(orders.find((o) => o.id === b.dataset.oid), b.dataset.chv,
      items.filter((i) => i.order_id === b.dataset.oid && i.vendor_id === b.dataset.chv), load)));
    $$("[data-open]", el).forEach((b) => (b.onclick = () => orderModal(b.dataset.open, load)));
    $$("[data-bill]", el).forEach((b) => (b.onclick = () => openBill(b.dataset.bill, { team: true })));
    $$("[data-adv]", el).forEach((b) => (b.onclick = () => advanceOrder(orders.find((o) => o.id === b.dataset.adv), b.dataset.step, load)));
    bindPaymentButtons($("#list"), orders, load);
  };
  $("#st").onchange = load;
  load();
}

export async function vendorContacts(el) {
  const rows = await q(sb.from("boh_vendors").select("*").eq("active", true).order("name"));
  el.innerHTML = `<div class="page-head"><h1>Vendor contacts</h1><input id="s" placeholder="Search…" style="max-width:280px"></div>
    <div class="table-wrap"><table><thead><tr><th>Vendor</th><th>Contact</th><th>Phone numbers</th><th>Delivery</th><th>Address</th></tr></thead><tbody>
    ${rows.map((v) => `<tr data-n="${esc(v.name.toLowerCase())}"><td><b>${esc(v.name)}</b></td><td>${esc(v.contact_person || "")}</td><td class="phones">${telLinks(v.phones)}</td>
      <td>${esc(DELIVERY_LABEL[v.delivery_style])}</td><td class="small">${esc(v.address || "")}</td></tr>`).join("")}</tbody></table></div>`;
  $("#s").oninput = (e) => $$("tr[data-n]", el).forEach((tr) => tr.classList.toggle("hidden", !tr.dataset.n.includes(e.target.value.toLowerCase())));
}
