import { sb, state, $, $$, esc, money, fmtDT, fmtD, q, statusBadge, dueBadge, currentDue, telLinks, DELIVERY_LABEL, NEXT_STEP, STEP_BUTTON, toast, promptBox } from "./lib.js?v=5";
import { orderModal } from "./admin.js?v=5";

export async function tasks(el) {
  el.innerHTML = `
    <div class="page-head"><div><h1>My assigned orders</h1>
      <div class="muted">Acknowledge within ${state.settings.sla_ack_hrs} working hr → order with vendor within ${state.settings.sla_vendor_order_hrs} → 1st follow-up ${state.settings.sla_followup1_hrs} → 2nd follow-up ${state.settings.sla_followup2_hrs} → delivered → payment within ${state.settings.sla_payment_hrs} working hrs of delivery.</div></div>
      <select id="st" style="max-width:200px"><option value="open">Open</option><option value="done">Completed (last 30 days)</option></select></div>
    <div id="list"></div>`;
  const load = async () => {
    let qq = sb.from("boh_orders").select("*, restaurant:boh_restaurants(name,phone,address)").eq("coordinator_id", state.me.id);
    qq = $("#st").value === "open" ? qq.not("status", "in", "(paid,cancelled)") : qq.in("status", ["paid", "cancelled"]).gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString());
    const orders = await q(qq.order("created_at"));
    const ids = orders.map((o) => o.id);
    const items = ids.length ? await q(sb.from("boh_order_items").select("order_id, product_name, qty, unit, vendor_id, vendor_name, delivery_style, vendor:boh_vendors(phones)").in("order_id", ids)) : [];
    orders.sort((a, b) => (currentDue(a)?.due?.getTime() ?? 9e15) - (currentDue(b)?.due?.getTime() ?? 9e15));
    $("#list").innerHTML = orders.map((o) => {
      const vend = {};
      items.filter((i) => i.order_id === o.id).forEach((i) => { (vend[i.vendor_id || "x"] ||= { name: i.vendor_name, style: i.delivery_style, phones: i.vendor?.phones, n: 0 }).n++; });
      const next = NEXT_STEP[o.status];
      return `<div class="card">
        <div class="row between"><div><h2 style="margin:0">#${o.order_no} · ${esc(o.restaurant?.name)}</h2>
          <div class="small muted">Placed ${fmtDT(o.created_at)} · Delivery ${fmtD(o.delivery_date)} · ${money(o.total)} · 📞 ${telLinks([o.restaurant?.phone])}</div></div>
          <div class="row">${statusBadge(o.status)} ${dueBadge(o)}</div></div>
        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:.5rem;margin:.75rem 0">
          ${Object.values(vend).map((v) => `<div style="background:#faf8f4;border-radius:8px;padding:.5rem .7rem">
            <b>${esc(v.name || "No vendor")}</b> <span class="small muted">${v.n} item${v.n > 1 ? "s" : ""}</span>
            <div class="small">${esc(DELIVERY_LABEL[v.style] || "")}</div><div class="small phones">📞 ${telLinks(v.phones)}</div></div>`).join("")}
        </div>
        <div class="row" style="justify-content:flex-end">
          <button class="btn" data-open="${o.id}">Open details</button>
          ${next ? `<button class="btn primary" data-step="${next}" data-id="${o.id}">${STEP_BUTTON[next]}</button>` : ""}
        </div></div>`;
    }).join("") || `<div class="card empty">No orders ${$("#st").value === "open" ? "waiting on you" : "completed recently"}.</div>`;
    $$("[data-open]", el).forEach((b) => (b.onclick = () => orderModal(b.dataset.open, load)));
    $$("[data-step]", el).forEach((b) => (b.onclick = async () => {
      const step = b.dataset.step;
      let note = null;
      if (["followup1", "followup2"].includes(step)) { note = await promptBox("Follow-up note", "What did the vendor say?"); if (note === null) return; }
      if (step === "paid") { note = await promptBox("Payment completed", "Payment reference (UPI / cheque / cash)"); if (note === null) return; }
      await q(sb.rpc("boh_advance_order", { p_order: b.dataset.id, p_step: step, p_note: note }));
      toast("Updated"); load();
    }));
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
