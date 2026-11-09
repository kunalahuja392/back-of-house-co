import { sb, state, $, $$, esc, money, fmtDT, fmtD, q, statusBadge, payBadge, PAY_MODE, dueText, allocSteps, telLinks, DELIVERY_LABEL, NEXT_STEP, STEP_BUTTON, toast, promptBox } from "./lib.js?v=13";
import { orderModal, advanceAlloc, paymentButtons, bindPaymentButtons } from "./admin.js?v=13";

// each card = one category of one order allocated to me
export async function tasks(el) {
  const s = state.settings;
  el.innerHTML = `
    <div class="page-head"><div><h1>My assigned orders</h1>
      <div class="muted">Per category: acknowledge within ${s.sla_ack_hrs} working hr → order with vendor ${s.sla_vendor_order_hrs} → 1st follow-up ${s.sla_followup1_hrs} → 2nd follow-up ${s.sla_followup2_hrs} → delivered (enter porter / delivery / other charges) → payment within ${s.sla_payment_hrs} working hrs of delivery.</div></div>
      <select id="st" style="max-width:220px"><option value="open">Open</option><option value="pay">Payments to collect / verify</option><option value="done">Completed (last 30 days)</option></select></div>
    <div id="list"></div>`;
  const load = async () => {
    const mode = $("#st").value;
    let allocs = await q(sb.from("boh_order_allocations").select("*, ord:boh_orders(*, restaurant:boh_restaurants(name,phone,address))").eq("coordinator_id", state.me.id).order("allocated_at"));
    allocs = allocs.filter((a) => a.ord && (
      mode === "open" ? a.status !== "delivered" && a.ord.status !== "cancelled"
      : mode === "pay" ? a.ord.status !== "cancelled" && a.ord.payment_status !== "paid" && (a.ord.payment_status === "under_review" || a.ord.payment_mode === "prepaid" || a.ord.status === "delivered")
      : ["paid", "cancelled"].includes(a.ord.status) && Date.now() - new Date(a.ord.created_at) < 30 * 86400000));
    const orderIds = [...new Set(allocs.map((a) => a.order_id))];
    const items = orderIds.length ? await q(sb.from("boh_order_items").select("order_id, category_id, product_name, qty, unit, vendor_id, vendor_name, delivery_style, vendor:boh_vendors(phones)").in("order_id", orderIds)) : [];
    const due = (a) => allocSteps(a.ord, a).find((x) => !x.at)?.due?.getTime() ?? 9e15;
    allocs.sort((x, y) => due(x) - due(y));

    if (mode === "pay") {
      // one card per order awaiting payment
      const orders = [...new Map(allocs.map((a) => [a.order_id, a.ord])).values()];
      orders.sort((x, y) => (y.payment_status === "under_review") - (x.payment_status === "under_review"));
      $("#list").innerHTML = orders.map((o) => `<div class="card"><div class="row between"><div><h2 style="margin:0">#${o.order_no} · ${esc(o.restaurant?.name)} · ${money(o.total)}</h2>
          <div class="small muted">${PAY_MODE[o.payment_mode] || ""} · ${o.delivered_at ? "Delivered " + fmtDT(o.delivered_at) : "Not delivered yet"} · 📞 ${telLinks([o.restaurant?.phone])}</div>
          ${o.payment_status === "under_review" ? `<div class="small">Restaurant says paid${o.payment_claim_method ? " via " + esc(o.payment_claim_method) : ""} · ref <b>${esc(o.payment_claim_ref)}</b> · ${fmtDT(o.payment_claimed_at)}</div>` : ""}
          ${o.payment_status === "unpaid" && o.payment_rejected_note ? `<div class="small" style="color:var(--danger)">Last claim rejected: ${esc(o.payment_rejected_note)}</div>` : ""}</div>
          <div class="row">${payBadge(o)} <button class="btn sm" data-open="${o.id}">Open</button> ${paymentButtons(o)}</div></div></div>`).join("") || `<div class="card empty">No payments to collect or verify.</div>`;
      bindPaymentButtons($("#list"), orders, load);
    } else {
      $("#list").innerHTML = allocs.map((a) => {
        const o = a.ord;
        const mine = items.filter((i) => i.order_id === a.order_id && i.category_id === a.category_id);
        const vend = {};
        mine.forEach((i) => { (vend[i.vendor_id || "x"] ||= { name: i.vendor_name, style: i.delivery_style, phones: i.vendor?.phones, lines: [] }).lines.push(i); });
        const next = NEXT_STEP[a.status];
        const st = allocSteps(o, a).find((x) => !x.at);
        return `<div class="card">
          <div class="row between"><div><h2 style="margin:0">#${o.order_no} · ${esc(o.restaurant?.name)} · <span style="color:var(--brand-2)">${esc(a.category_name)}</span></h2>
            <div class="small muted">Placed ${fmtDT(o.created_at)} · Delivery ${fmtD(o.delivery_date)} · 📞 ${telLinks([o.restaurant?.phone])} · ${esc(o.restaurant?.address || "")}</div></div>
            <div class="row">${statusBadge(a.status)} ${st?.due && mode === "open" ? dueText(st.due) : ""}</div></div>
          <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:.5rem;margin:.75rem 0">
            ${Object.values(vend).map((v) => `<div style="background:#faf8f4;border-radius:8px;padding:.5rem .7rem">
              <b>${esc(v.name || "No vendor")}</b> <span class="badge info">${esc(DELIVERY_LABEL[v.style] || "")}</span>
              <div class="small phones">📞 ${telLinks(v.phones)}</div>
              <div class="small" style="margin-top:.3rem">${v.lines.map((l) => `${esc(l.product_name)} — <b>${Number(l.qty)} ${esc(l.unit || "")}</b>`).join("<br>")}</div></div>`).join("")}
          </div>
          <div class="row" style="justify-content:flex-end">
            <button class="btn" data-open="${o.id}">Open order</button>
            ${mode === "open" && ["vendor_ordered", "followup1"].includes(a.status) ? `<button class="btn" data-adv="${a.id}" data-step="delivered">Mark delivered</button>` : ""}
            ${mode === "open" && next ? `<button class="btn primary" data-adv="${a.id}" data-step="${next}">${STEP_BUTTON[next]}</button>` : ""}
          </div></div>`;
      }).join("") || `<div class="card empty">${mode === "open" ? "Nothing waiting on you 🎉" : "Nothing completed recently."}</div>`;
    }
    $$("[data-open]", el).forEach((b) => (b.onclick = () => orderModal(b.dataset.open, load)));
    $$("[data-adv]", el).forEach((b) => (b.onclick = () => advanceAlloc(allocs.find((a) => a.id === b.dataset.adv), b.dataset.step, load)));
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
