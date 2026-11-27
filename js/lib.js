import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY, USERS_FUNCTION } from "./config.js?v=23";

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

export const state = { me: null, settings: null };

// ---------------------------------------------------------------- DOM helpers
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const money = (n) =>
  n == null || n === "" ? "—" : "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const num = (n, d = 2) => (n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: d }));
export const pct = (n) => (n == null ? "—" : Number(n).toFixed(2).replace(/\.00$/, "") + "%");

const IST = "Asia/Kolkata";
export const fmtDT = (d) =>
  d ? new Date(d).toLocaleString("en-IN", { timeZone: IST, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
export const fmtD = (d) =>
  d ? new Date(d.length === 10 ? d + "T00:00:00+05:30" : d).toLocaleDateString("en-IN", { timeZone: IST, day: "2-digit", month: "short", year: "numeric" }) : "—";
export const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
export const daysAgoIST = (n) => new Date(Date.now() + 330 * 60000 - n * 86400000).toISOString().slice(0, 10);

export function toast(msg, err = false) {
  let box = $("#toasts");
  if (!box) { box = document.createElement("div"); box.id = "toasts"; document.body.append(box); }
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.remove(), err ? 6000 : 3000);
}

export function modal({ title, body, footer = "", wide = false, onOpen }) {
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal ${wide ? "wide" : ""}">
    <div class="modal-h"><h2>${esc(title)}</h2><button class="x" aria-label="Close">×</button></div>
    <div class="modal-b">${body}</div>${footer ? `<div class="modal-f">${footer}</div>` : ""}</div>`;
  const close = () => bg.remove();
  bg.querySelector(".x").onclick = close;
  bg.addEventListener("mousedown", (e) => { if (e.target === bg) close(); });
  document.body.append(bg);
  onOpen?.(bg, close);
  return { el: bg, close };
}

export function confirmBox(text) {
  return new Promise((res) => {
    const m = modal({
      title: "Please confirm",
      body: `<p>${esc(text)}</p>`,
      footer: `<button class="btn" data-a="no">Cancel</button><button class="btn primary" data-a="yes">Confirm</button>`,
    });
    m.el.querySelector('[data-a="no"]').onclick = () => { m.close(); res(false); };
    m.el.querySelector('[data-a="yes"]').onclick = () => { m.close(); res(true); };
  });
}

export function promptBox(title, label, value = "") {
  return new Promise((res) => {
    const m = modal({
      title,
      body: `<div class="field"><label>${esc(label)}</label><input id="pb" value="${esc(value)}"></div>`,
      footer: `<button class="btn" data-a="no">Cancel</button><button class="btn primary" data-a="yes">OK</button>`,
    });
    const inp = m.el.querySelector("#pb");
    inp.focus();
    m.el.querySelector('[data-a="no"]').onclick = () => { m.close(); res(null); };
    m.el.querySelector('[data-a="yes"]').onclick = () => { m.close(); res(inp.value); };
  });
}

// read all named inputs inside a root into an object
export function formData(root) {
  const o = {};
  $$("[name]", root).forEach((el) => {
    if (el.type === "checkbox") o[el.name] = el.checked;
    else if (el.type === "number") o[el.name] = el.value === "" ? null : Number(el.value);
    else o[el.name] = el.value.trim() === "" ? null : el.value.trim();
  });
  return o;
}

// throw on supabase error, return data
export async function q(promise) {
  const { data, error } = await promise;
  if (error) { toast(error.message, true); throw error; }
  return data;
}

export async function callUsersFn(payload) {
  const { data, error } = await sb.functions.invoke(USERS_FUNCTION, { body: payload });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); msg = j.error || msg; } catch {}
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function uploadImage(file, folder = "products") {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `${folder}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from("boh-images").upload(path, file, { upsert: false, contentType: file.type });
  if (error) { toast(error.message, true); throw error; }
  return sb.storage.from("boh-images").getPublicUrl(path).data.publicUrl;
}

export function downloadCSV(filename, rows) {
  if (!rows.length) return toast("Nothing to export", true);
  const cols = Object.keys(rows[0]);
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.map(cell).join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = filename;
  a.click();
}

export function tabs(root, names, onPick, initial = 0) {
  root.innerHTML = names.map((n, i) => `<button data-i="${i}" class="${i === initial ? "active" : ""}">${esc(n)}</button>`).join("");
  root.onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $$("button", root).forEach((x) => x.classList.toggle("active", x === b));
    onPick(Number(b.dataset.i));
  };
  onPick(initial);
}

export const STATUS_LABEL = {
  placed: "Placed — awaiting allocation",
  allocated: "Allocated",
  acknowledged: "Acknowledged",
  vendor_ordered: "Ordered with vendor",
  followup1: "1st follow-up done",
  followup2: "2nd follow-up done",
  delivered: "Delivered",
  paid: "Payment completed",
  cancelled: "Cancelled",
};
export const statusBadge = (s) => {
  const cls = { placed: "warn", allocated: "info", acknowledged: "info", vendor_ordered: "info", followup1: "info", followup2: "info", delivered: "ok", paid: "ok", cancelled: "danger" }[s] || "";
  return `<span class="badge ${cls}">${esc(STATUS_LABEL[s] || s)}</span>`;
};
export const PAY_MODE = { prepaid: "Pre-pay", cod: "Pay on delivery" };
// payment state as the restaurant and team see it
export function payBadge(o) {
  if (o.status === "cancelled") return "";
  if (o.payment_status === "paid") return '<span class="badge ok">Paid</span>';
  if (o.payment_status === "under_review") return '<span class="badge warn">Payment under approval</span>';
  if (o.payment_rejected_note) return '<span class="badge danger">Not paid — payment rejected</span>';
  return '<span class="badge danger">Unpaid</span>';
}
export const DELIVERY_LABEL = { vendor_delivers: "Vendor delivers", porter: "Porter", self_pickup: "Self pickup" };

// ---------------------------------------------------------------- working-hours SLA engine (IST)
const OFF = 330 * 60000; // IST offset, no DST in India
const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + (m || 0); };

// add N working hours to a date using the working day/time window in settings
export function addWorkingHours(date, hours, s = state.settings) {
  if (!date) return null;
  const startM = toMin(s.work_start), endM = toMin(s.work_end), days = s.work_days || [1, 2, 3, 4, 5, 6];
  let t = new Date(new Date(date).getTime() + OFF); // shifted so UTC getters read IST
  let remaining = hours * 60;
  for (let guard = 0; guard < 400 && remaining > 0; guard++) {
    const dow = t.getUTCDay() === 0 ? 7 : t.getUTCDay();
    const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
    const dayStart = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
    if (!days.includes(dow) || mins >= endM) { t = new Date(dayStart + 86400000 + startM * 60000); continue; }
    if (mins < startM) { t = new Date(dayStart + startM * 60000); continue; }
    const avail = endM - mins;
    if (remaining <= avail) { t = new Date(t.getTime() + remaining * 60000); remaining = 0; }
    else { remaining -= avail; t = new Date(dayStart + 86400000 + startM * 60000); }
  }
  return new Date(t.getTime() - OFF);
}

// ---- workflow: each category of an order is allocated to a coordinator and moves through these steps
function judge(steps, cancelled) {
  const now = Date.now();
  for (const st of steps) {
    if (st.at) st.state = st.due && new Date(st.at) > st.due ? "late" : "done";
    else if (cancelled) st.state = "na";
    else st.state = st.due && now > st.due ? "overdue" : st.due ? "pending" : "waiting";
  }
  return steps;
}

// steps for one category allocation (a) of order (o)
export function allocSteps(o, a, s = state.settings) {
  return judge([
    { key: "allocated", label: `Allocated to coordinator (admin, ${s.sla_allocate_hrs} working hrs)`, at: a.allocated_at, due: addWorkingHours(o.created_at, s.sla_allocate_hrs, s) },
    { key: "acknowledged", label: `Acknowledge (${s.sla_ack_hrs} working hr)`, at: a.acknowledged_at, due: addWorkingHours(a.allocated_at, s.sla_ack_hrs, s) },
    { key: "vendor_ordered", label: `Place order with vendor (${s.sla_vendor_order_hrs} working hrs)`, at: a.vendor_ordered_at, due: addWorkingHours(a.acknowledged_at, s.sla_vendor_order_hrs, s) },
    { key: "followup1", label: `1st follow-up (${s.sla_followup1_hrs} working hrs)`, at: a.followup1_at, due: addWorkingHours(a.vendor_ordered_at, s.sla_followup1_hrs, s) },
    { key: "followup2", label: `2nd follow-up (${s.sla_followup2_hrs} working hrs)`, at: a.followup2_at, due: addWorkingHours(a.followup1_at, s.sla_followup2_hrs, s) },
    { key: "delivered", label: "Delivered (+ overheads)", at: a.delivered_at, due: o.delivery_date ? new Date(o.delivery_date + "T" + s.work_end + "+05:30") : null },
  ], o.status === "cancelled");
}

// order-level steps: allocation of all categories, and payment after full delivery
export function orderSteps(o, s = state.settings) {
  return judge([
    { key: "allocated", label: `Allocated to a coordinator (${s.sla_allocate_hrs} working hrs)`, at: o.status === "placed" ? null : o.allocated_at, due: addWorkingHours(o.created_at, s.sla_allocate_hrs, s) },
    { key: "delivered", label: "Whole order delivered", at: o.delivered_at, due: o.delivery_date ? new Date(o.delivery_date + "T" + s.work_end + "+05:30") : null },
    { key: "paid", label: `Payment completed (${s.sla_payment_hrs} working hrs after delivery)`, at: o.paid_at, due: addWorkingHours(o.delivered_at, s.sla_payment_hrs, s) },
  ], o.status === "cancelled");
}

export const NEXT_STEP = {
  allocated: "acknowledged", acknowledged: "vendor_ordered", vendor_ordered: "followup1",
  followup1: "followup2", followup2: "delivered",
};
export const STEP_BUTTON = {
  acknowledged: "Acknowledge", vendor_ordered: "Mark ordered with vendor", followup1: "Log 1st follow-up",
  followup2: "Log 2nd follow-up", delivered: "Mark delivered", paid: "Mark payment completed",
};

// one coordinator handles the whole order: fold its category allocations into one
const ALLOC_ORDER = ["allocated", "acknowledged", "vendor_ordered", "followup1", "followup2", "delivered"];
export function orderAlloc(o) {
  const al = o.allocs || [];
  if (!al.length) return null;
  const rank = Math.min(...al.map((a) => ALLOC_ORDER.indexOf(a.status)));
  const all = (k) => (al.every((a) => a[k]) ? al.map((a) => a[k]).sort().at(-1) : null);
  return {
    id: o.id, order_id: o.id, status: ALLOC_ORDER[rank], category_name: "Whole order",
    coordinator_id: o.coordinator_id || al[0].coordinator_id, coordinator: al[0].coordinator,
    allocated_at: all("allocated_at"), acknowledged_at: all("acknowledged_at"), vendor_ordered_at: all("vendor_ordered_at"),
    followup1_at: all("followup1_at"), followup2_at: all("followup2_at"), delivered_at: all("delivered_at"),
    followup1_note: al.map((a) => a.followup1_note).find(Boolean) || null,
    followup2_note: al.map((a) => a.followup2_note).find(Boolean) || null,
  };
}
// can the whole order be marked delivered now (vendor order placed)?
export const canDeliver = (status) => ["vendor_ordered", "followup1", "followup2"].includes(status);

// the next thing due on an order (o.allocs = its allocations, optional)
export function pendingSteps(o) {
  if (["paid", "cancelled"].includes(o.status)) return [];
  const out = [];
  if (o.status === "placed") out.push(orderSteps(o)[0]);
  const a = orderAlloc(o);
  if (a && o.status !== "placed") {
    const st = allocSteps(o, a).find((x) => !x.at);
    if (st) out.push(st);
  }
  if (o.status === "delivered") out.push(orderSteps(o)[2]);
  return out.filter((x) => x.due);
}
export function currentDue(o) {
  return pendingSteps(o).sort((a, b) => a.due - b.due)[0] || null;
}

export function dueText(due) {
  const diff = due.getTime() - Date.now();
  const mins = Math.round(Math.abs(diff) / 60000);
  const txt = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  return diff < 0 ? `<span class="badge danger">Overdue ${txt}</span>` : `<span class="badge ${diff < 3600000 ? "warn" : "ok"}">Due in ${txt}</span>`;
}
export function dueBadge(o) {
  const st = currentDue(o);
  return st ? dueText(st.due) : "";
}

export function stepsHTML(steps) {
  return `<div class="steps">${steps.map((s) => `
    <div class="step ${s.state === "done" ? "done" : ""} ${s.state === "late" ? "late" : ""} ${s.state === "overdue" ? "overdue" : ""}">
      <span class="dot"></span>
      <div><div>${esc(s.label)}</div>
        <div class="small muted">${s.at ? "Done " + fmtDT(s.at) : s.due ? "Due " + fmtDT(s.due) : "Waits for previous step"}</div></div>
      <div>${s.state === "late" ? '<span class="badge danger">Late</span>' : s.state === "done" ? '<span class="badge ok">On time</span>' : s.state === "overdue" ? '<span class="badge danger">Overdue</span>' : ""}</div>
    </div>`).join("")}</div>`;
}

export const OVERHEAD_KINDS = ["Porter", "Delivery charge", "Loading / unloading", "Paid to vendor (extra)", "Toll / parking", "Other"];

export const telLinks = (phones) =>
  (phones || []).filter(Boolean).map((p) => `<a href="tel:${esc(p)}">${esc(p)}</a>`).join(" ") || '<span class="muted">—</span>';

// ====================================================================== guided order flow
// the six stages every order goes through, in the words the team uses
export const FLOW = ["Allocated", "Acknowledged", "Ordered with vendors", "Follow-ups", "Delivered", "Paid"];
export const PAYMENT_METHODS = ["Cash", "UPI", "Bank transfer", "Cheque"];

// where an order is and what has to happen next. A = orderAlloc(o)
export function flowGuide(o, A = orderAlloc(o)) {
  if (o.status === "cancelled") return { idx: -1, title: "Cancelled", help: "This order was cancelled.", done: true };
  if (o.payment_status === "paid" && (o.status === "paid" || o.status === "delivered"))
    return { idx: 6, title: "Completed", help: `Delivered and paid${o.payment_method ? " (" + o.payment_method + ")" : ""}. Nothing left to do.`, done: true };
  if (o.status === "placed" || !A)
    return { idx: 0, title: "Waiting for a coordinator", help: "An admin allocates the order to one coordinator (new orders are allocated automatically when a default coordinator is set in Settings).", who: "admin", action: { alloc: true, label: "Allocate" } };
  const s = A.status;
  if (s === "allocated") return { idx: 1, title: "Acknowledge the order", help: "Open the order, check the items and vendors, then tap Acknowledge so the admin and restaurant know you have it.", action: { step: "acknowledged", label: "Acknowledge" } };
  if (s === "acknowledged") return { idx: 2, title: "Place the order with the vendors", help: "Call or WhatsApp each vendor listed below and order their items. Vendor not answering? Use ⇄ Change vendor. When every vendor has confirmed, tap Ordered with vendors.", action: { step: "vendor_ordered", label: "Mark ordered with vendors" } };
  if (s === "vendor_ordered") return { idx: 3, title: "Follow up with the vendors", help: "Check the goods are on the way and note what the vendors said. If the goods have already reached the restaurant, tap Mark delivered.", action: { step: "followup1", label: "Log 1st follow-up" }, alt: { step: "delivered", label: "Mark delivered" } };
  if (s === "followup1") return { idx: 3, title: "2nd follow-up", help: "Confirm the delivery time with the vendors and note it. Mark delivered as soon as the restaurant receives everything.", action: { step: "followup2", label: "Log 2nd follow-up" }, alt: { step: "delivered", label: "Mark delivered" } };
  if (s === "followup2") return { idx: 4, title: "Mark delivered", help: "Once the restaurant has received all items, mark the order delivered and enter any porter / delivery charges you paid.", action: { step: "delivered", label: "Mark delivered" } };
  // delivered, not paid
  if (o.price_pending) return { idx: 5, title: "Confirm the open prices", help: "Some items were ordered at 'price on request'. Open the order, tap Set price on each and enter the vendor's rate — the restaurant then gets the final bill, and you can collect payment.", action: { price: true, label: "Set prices" } };
  if (o.payment_status === "under_review") return { idx: 5, title: "Verify the payment", help: `The restaurant says it paid (ref ${o.payment_claim_ref || "—"}). Check your bank / UPI app, then approve or reject.`, action: { pay: "approve", label: "Approve payment" } };
  return { idx: 5, title: "Collect the payment", help: "Collect the amount from the restaurant (cash, UPI, bank transfer or cheque) and record it here. The restaurant gets a payment receipt by email automatically.", action: { pay: "collect", label: "Collect payment" } };
}

// progress bar + "what to do now"
export function flowHTML(o, A = orderAlloc(o), { compact = false } = {}) {
  const g = flowGuide(o, A);
  const bar = `<div class="flow">${FLOW.map((f, i) => `<div class="flow-step ${i < g.idx ? "done" : i === g.idx ? "now" : ""}"><span>${i < g.idx ? "✓" : i + 1}</span><em>${esc(f)}</em></div>`).join("")}</div>`;
  if (compact) return bar;
  const pn = o.price_pending && !g.action?.price ? `<div class="flow-next" style="background:#fef3c7;border-color:#fcd34d"><b>⚠ Prices to confirm</b><div class="small">This order has price-on-request items. Before delivery, tap <b>Set price</b> on each of them (in the vendor list) with the vendor's rate.</div></div>` : "";
  return `${bar}${pn}<div class="flow-next ${g.done ? "done" : ""}"><b>${g.done ? "✓ " : "Next: "}${esc(g.title)}</b><div class="small">${esc(g.help)}</div></div>`;
}

// ====================================================================== bills / invoices
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const two = (x) => (x < 20 ? ONES[x] : TENS[Math.floor(x / 10)] + (x % 10 ? " " + ONES[x % 10] : ""));
const three = (x) => (x >= 100 ? ONES[Math.floor(x / 100)] + " Hundred" + (x % 100 ? " " + two(x % 100) : "") : two(x));
export function rupeesInWords(n) {
  n = Math.round(Number(n || 0) * 100) / 100;
  let r = Math.floor(n); const p = Math.round((n - r) * 100);
  if (!r && !p) return "Zero Rupees Only";
  const parts = [];
  const cr = Math.floor(r / 1e7); r %= 1e7;
  const lk = Math.floor(r / 1e5); r %= 1e5;
  const th = Math.floor(r / 1e3); r %= 1e3;
  if (cr) parts.push(three(cr) + " Crore");
  if (lk) parts.push(two(lk) + " Lakh");
  if (th) parts.push(two(th) + " Thousand");
  if (r) parts.push(three(r));
  return (parts.length ? "Rupees " + parts.join(" ") : "") + (p ? (parts.length ? " and " : "") + two(p) + " Paise" : "") + " Only";
}

export const billNo = (o) => o.invoice_no || `PI-${o.order_no}`;
export const billTitle = (o) => (o.invoice_no ? "Invoice" : "Proforma invoice");

// A4 bill. d = result of boh_invoice(); names = optional {product_id: display name} for the restaurant's own names
export function invoiceHTML(d, names = {}) {
  const o = d.order, r = d.restaurant || {}, c = d.company || {}, lines = d.lines || [];
  const paid = o.payment_status === "paid";
  const sub = lines.reduce((a, l) => a + Number(l.line_total || 0), 0);
  const D = (x) => (x ? new Date(x).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "—");
  const m = (x) => "₹" + Number(x || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const q3 = (x) => Number(x).toLocaleString("en-IN", { maximumFractionDigits: 3 });
  const st = o.status === "cancelled" ? ["CANCELLED", "#b3261e"] : paid ? ["PAID", "#1b7f3b"] : o.invoice_no ? ["PAYMENT DUE", "#b26a00"] : null;
  const bank = c.account_no ? `${esc(c.bank_name || "")} · A/c ${esc(c.account_no)}${c.ifsc ? " · IFSC " + esc(c.ifsc) : ""}${c.account_name ? "<br>A/c name: " + esc(c.account_name) : ""}${c.branch ? " · " + esc(c.branch) : ""}` : "";
  return `<div class="inv" style="font-family:Inter,Segoe UI,Arial,sans-serif;color:#1f1d1a;background:#fff;width:760px;max-width:100%;margin:0 auto;padding:28px 30px;box-sizing:border-box;font-size:12.5px;line-height:1.45;position:relative">
    ${st ? `<div style="position:absolute;top:86px;left:42%;transform:rotate(-10deg);border:3px solid ${st[1]};color:${st[1]};font-weight:800;font-size:22px;letter-spacing:2px;padding:4px 14px;border-radius:8px;opacity:.75">${st[0]}</div>` : ""}
    <table style="width:100%;border-collapse:collapse"><tr>
      <td style="vertical-align:top">
        <div style="display:flex;align-items:center;gap:10px"><div style="width:38px;height:38px;border-radius:9px;background:#1f3a2e;color:#fff;font-weight:800;font-size:20px;display:flex;align-items:center;justify-content:center">B</div>
          <div><div style="font-size:19px;font-weight:800">${esc(c.name || "Back of House Co")}</div><div style="color:#6b665e;font-size:11px">Restaurant supplies · procurement</div></div></div>
        <div style="margin-top:8px;color:#4a463f;font-size:11.5px">${c.address ? esc(c.address).replace(/\n/g, "<br>") + "<br>" : ""}${[c.phone && "📞 " + esc(c.phone), c.email && "✉ " + esc(c.email)].filter(Boolean).join(" · ")}${c.gstin ? "<br>GSTIN: <b>" + esc(c.gstin) + "</b>" : ""}</div>
      </td>
      <td style="vertical-align:top;text-align:right">
        <div style="font-size:22px;font-weight:800;color:#1f3a2e;text-transform:uppercase;letter-spacing:.5px">${o.status === "cancelled" ? "Cancelled bill" : billTitle(o)}</div>
        <table style="margin-left:auto;margin-top:6px;font-size:12px;border-collapse:collapse">
          <tr><td style="color:#6b665e;padding:1px 8px">${o.invoice_no ? "Invoice no." : "Proforma no."}</td><td style="font-weight:700">${esc(billNo(o))}</td></tr>
          <tr><td style="color:#6b665e;padding:1px 8px">${o.invoice_no ? "Invoice date" : "Date"}</td><td>${D(o.invoice_date || o.created_at)}</td></tr>
          <tr><td style="color:#6b665e;padding:1px 8px">Order no.</td><td>#${o.order_no}</td></tr>
          <tr><td style="color:#6b665e;padding:1px 8px">Delivery</td><td>${o.delivered_at ? "Delivered " + D(o.delivered_at) : D(o.delivery_date)}</td></tr>
        </table>
      </td></tr></table>
    <div style="height:2px;background:#1f3a2e;margin:14px 0 12px"></div>
    <table style="width:100%;border-collapse:collapse"><tr>
      <td style="vertical-align:top;width:58%"><div style="color:#6b665e;font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;font-weight:700">Bill to</div>
        <div style="font-size:14px;font-weight:700;margin-top:2px">${esc(r.name || "")}</div>
        <div style="color:#4a463f;font-size:11.5px">${r.contact ? esc(r.contact) + "<br>" : ""}${r.address ? esc(r.address).replace(/\n/g, "<br>") + "<br>" : ""}${[r.phone && "📞 " + esc(r.phone), r.email && "✉ " + esc(r.email)].filter(Boolean).join(" · ")}${r.gstin ? "<br>GSTIN: <b>" + esc(r.gstin) + "</b>" : ""}</div></td>
      <td style="vertical-align:top"><div style="color:#6b665e;font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;font-weight:700">Payment</div>
        <div style="margin-top:2px">${o.payment_mode === "prepaid" ? "Pre-pay" : "Pay on delivery"}</div>
        <div>${paid ? `<b style="color:#1b7f3b">Paid ${D(o.paid_at)}</b>${o.payment_method ? " · " + esc(o.payment_method) : ""}${o.payment_ref && o.payment_ref !== o.payment_method ? "<br>Ref: " + esc(o.payment_ref) : ""}` : o.status === "cancelled" ? "—" : `<b style="color:#b26a00">Amount due ${m(o.total)}</b>`}</div>
        ${d.coordinator?.name ? `<div style="margin-top:4px;color:#4a463f;font-size:11.5px">Coordinator: ${esc(d.coordinator.name)}${d.coordinator.phone ? " · " + esc(d.coordinator.phone) : ""}</div>` : ""}</td>
    </tr></table>
    <table style="width:100%;border-collapse:collapse;margin-top:14px;font-size:12px">
      <thead><tr style="background:#1f3a2e;color:#fff">
        <th style="padding:7px 6px;text-align:left;width:26px">#</th><th style="padding:7px 6px;text-align:left">Item</th>
        <th style="padding:7px 6px;text-align:right">Qty</th><th style="padding:7px 6px;text-align:left">Unit</th>
        <th style="padding:7px 6px;text-align:right">Rate</th><th style="padding:7px 6px;text-align:right">Amount</th></tr></thead>
      <tbody>${lines.map((l, i) => `<tr style="background:${i % 2 ? "#faf8f4" : "#fff"};page-break-inside:avoid">
        <td style="padding:6px;border-bottom:1px solid #eee8de;color:#6b665e">${i + 1}</td>
        <td style="padding:6px;border-bottom:1px solid #eee8de"><b style="font-weight:600">${esc(names[l.product_id] || l.product_name)}</b>${l.category_name ? `<div style="color:#8a847a;font-size:10.5px">${esc(l.category_name)}</div>` : ""}</td>
        <td style="padding:6px;border-bottom:1px solid #eee8de;text-align:right">${q3(l.qty)}</td>
        <td style="padding:6px;border-bottom:1px solid #eee8de">${esc(l.unit || "")}</td>
        <td style="padding:6px;border-bottom:1px solid #eee8de;text-align:right">${l.unit_price == null ? '<span style="color:#b26a00">On request</span>' : m(l.unit_price)}</td>
        <td style="padding:6px;border-bottom:1px solid #eee8de;text-align:right;font-weight:600">${l.line_total == null ? '<span style="color:#b26a00;font-weight:400">To be confirmed</span>' : m(l.line_total)}</td></tr>`).join("")}</tbody></table>
    ${lines.some((l) => l.unit_price == null) ? `<div style="margin-top:8px;padding:8px 10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;font-size:11.5px">Items marked <b>To be confirmed</b> are price-on-request. Their price will be added before delivery; the total below covers priced items only.</div>` : ""}
    <table style="width:100%;border-collapse:collapse;margin-top:10px;page-break-inside:avoid"><tr>
      <td style="vertical-align:top;padding-right:16px;color:#4a463f;font-size:11.5px"><b>Amount in words</b><br>${rupeesInWords(o.total)}</td>
      <td style="vertical-align:top;width:250px"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
        <tr><td style="padding:3px 6px;color:#6b665e">Items</td><td style="padding:3px 6px;text-align:right">${lines.length}</td></tr>
        <tr><td style="padding:3px 6px;color:#6b665e">Subtotal</td><td style="padding:3px 6px;text-align:right">${m(sub)}</td></tr>
        <tr style="background:#1f3a2e;color:#fff;font-size:14px"><td style="padding:7px 6px;font-weight:700">Total${lines.some((l) => l.unit_price == null) ? " (priced items)" : ""}</td><td style="padding:7px 6px;text-align:right;font-weight:800">${m(o.total)}</td></tr>
        ${paid ? `<tr><td style="padding:4px 6px;color:#1b7f3b">Paid</td><td style="padding:4px 6px;text-align:right;color:#1b7f3b">− ${m(o.total)}</td></tr><tr><td style="padding:3px 6px;font-weight:700">Balance</td><td style="padding:3px 6px;text-align:right;font-weight:700">${m(0)}</td></tr>` : ""}
      </table></td></tr></table>
    ${!paid && o.status !== "cancelled" && (c.upi || bank || c.qr) ? `<div style="margin-top:14px;border:1px solid #e6e0d6;border-radius:8px;padding:10px 12px;display:flex;gap:14px;align-items:center;page-break-inside:avoid">
      ${c.qr ? `<img src="${esc(c.qr)}" crossorigin="anonymous" style="width:92px;height:92px;object-fit:contain">` : ""}
      <div style="font-size:11.5px"><b>How to pay</b><br>${c.upi ? "UPI: <b>" + esc(c.upi) + "</b><br>" : ""}${bank ? "Bank: " + bank : ""}<br><span style="color:#6b665e">Please mention order #${o.order_no} in the payment note.</span></div></div>` : ""}
    ${o.notes ? `<div style="margin-top:10px;font-size:11.5px;color:#4a463f"><b>Note:</b> ${esc(o.notes)}</div>` : ""}
    <div style="margin-top:18px;padding-top:8px;border-top:1px solid #e6e0d6;display:flex;justify-content:space-between;gap:20px;font-size:10.5px;color:#6b665e;page-break-inside:avoid">
      <div>${esc(c.terms || "")}</div><div style="text-align:right;white-space:nowrap">For <b>${esc(c.name || "")}</b><br><br>Authorised signatory</div></div>
  </div>`;
}

let h2pLoader = null;
function loadPdfLib() {
  if (window.html2pdf) return Promise.resolve(window.html2pdf);
  return (h2pLoader ||= new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.2/dist/html2pdf.bundle.min.js";
    s.onload = () => res(window.html2pdf);
    s.onerror = () => { h2pLoader = null; rej(new Error("Could not load the PDF tool — use Print → Save as PDF instead")); };
    document.head.appendChild(s);
  }));
}
export async function downloadBillPDF(node, filename) {
  const h2p = await loadPdfLib();
  await h2p().set({
    margin: [8, 6, 10, 6], filename,
    image: { type: "jpeg", quality: 0.97 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
    pagebreak: { mode: ["css", "legacy"], avoid: "tr" },
  }).from(node).save();
}
export function printBill(html, title) {
  const w = window.open("", "_blank");
  if (!w) return toast("Allow pop-ups to print", true);
  w.document.write(`<!doctype html><html><head><title>${esc(title)}</title><style>@page{size:A4;margin:10mm}body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}</style></head><body>${html}<script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body></html>`);
  w.document.close();
}

// open a bill in a modal with Download PDF / Print (and Email to restaurant for the team)
export async function openBill(orderId, { names = {}, team = false } = {}) {
  const d = await q(sb.rpc("boh_invoice", { p_order: orderId }));
  const o = d.order;
  const html = invoiceHTML(d, names);
  const file = `${billTitle(o).replace(/\s+/g, "-")}-${billNo(o).replace(/[^\w-]+/g, "-")}-${(d.restaurant?.name || "").replace(/[^\w]+/g, "-")}.pdf`;
  const m = modal({
    wide: true,
    title: `${billTitle(o)} ${billNo(o)} — ${d.restaurant?.name || ""}`,
    body: `<div style="background:#efece6;padding:12px;border-radius:10px;overflow:auto"><div id="billdoc" style="box-shadow:0 2px 12px rgba(0,0,0,.12);background:#fff;width:760px;max-width:none;margin:0 auto">${html}</div></div>
      ${o.invoice_no ? "" : '<p class="small muted" style="margin-top:.5rem">This is a proforma (estimate) — it becomes an invoice with its own number once the order is delivered or paid.</p>'}`,
    footer: `${team ? '<button class="btn" id="bmail">✉ Email to restaurant</button>' : ""}<span class="grow"></span>
      <button class="btn" id="bprint">🖨 Print</button><button class="btn primary" id="bpdf">⬇ Download PDF</button>`,
  });
  $("#bpdf", m.el).onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = "Preparing…";
    try { await downloadBillPDF($("#billdoc .inv", m.el), file); }
    catch (err) { toast(err.message || "PDF failed — use Print", true); }
    finally { e.target.disabled = false; e.target.textContent = "⬇ Download PDF"; }
  };
  $("#bprint", m.el).onclick = () => printBill(html, `${billTitle(o)} ${billNo(o)}`);
  $("#bmail", m.el)?.addEventListener("click", async () => {
    await q(sb.rpc("boh_resend_bill", { p_order: orderId }));
    toast("Bill sent to the restaurant's email / WhatsApp");
  });
  return m;
}
