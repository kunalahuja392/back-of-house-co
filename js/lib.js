import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY, USERS_FUNCTION } from "./config.js?v=4";

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

// the coordinator workflow with due times; each step is due relative to the previous step's completion
export function orderSteps(o, s = state.settings) {
  const steps = [
    { key: "allocated", label: `Allocate to coordinator (admin, ${s.sla_allocate_hrs} working hrs)`, at: o.allocated_at, due: addWorkingHours(o.created_at, s.sla_allocate_hrs, s) },
    { key: "acknowledged", label: `Acknowledge (${s.sla_ack_hrs} working hr)`, at: o.acknowledged_at, due: addWorkingHours(o.allocated_at, s.sla_ack_hrs, s) },
    { key: "vendor_ordered", label: `Place order with vendor (${s.sla_vendor_order_hrs} working hrs)`, at: o.vendor_ordered_at, due: addWorkingHours(o.acknowledged_at, s.sla_vendor_order_hrs, s) },
    { key: "followup1", label: `1st follow-up (${s.sla_followup1_hrs} working hrs)`, at: o.followup1_at, due: addWorkingHours(o.vendor_ordered_at, s.sla_followup1_hrs, s) },
    { key: "followup2", label: `2nd follow-up (${s.sla_followup2_hrs} working hrs)`, at: o.followup2_at, due: addWorkingHours(o.followup1_at, s.sla_followup2_hrs, s) },
    { key: "delivered", label: "Mark delivered", at: o.delivered_at, due: o.delivery_date ? new Date(o.delivery_date + "T" + s.work_end + "+05:30") : null },
    { key: "paid", label: `Payment completed (${s.sla_payment_hrs} working hrs after delivery)`, at: o.paid_at, due: addWorkingHours(o.delivered_at, s.sla_payment_hrs, s) },
  ];
  const now = Date.now();
  for (const st of steps) {
    if (st.at) st.state = st.due && new Date(st.at) > st.due ? "late" : "done";
    else if (o.status === "cancelled") st.state = "na";
    else st.state = st.due && now > st.due ? "overdue" : st.due ? "pending" : "waiting";
  }
  return steps;
}

export const NEXT_STEP = {
  allocated: "acknowledged", acknowledged: "vendor_ordered", vendor_ordered: "followup1",
  followup1: "followup2", followup2: "delivered", delivered: "paid",
};
export const STEP_BUTTON = {
  acknowledged: "Acknowledge order", vendor_ordered: "Mark ordered with vendor", followup1: "Log 1st follow-up",
  followup2: "Log 2nd follow-up", delivered: "Mark delivered", paid: "Mark payment completed",
};

export function currentDue(o) {
  const st = orderSteps(o).find((x) => !x.at && x.state !== "na");
  return st || null;
}

export function dueBadge(o) {
  if (["paid", "cancelled"].includes(o.status)) return "";
  const st = currentDue(o);
  if (!st || !st.due) return "";
  const diff = st.due.getTime() - Date.now();
  const mins = Math.round(Math.abs(diff) / 60000);
  const txt = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  return diff < 0 ? `<span class="badge danger">Overdue ${txt}</span>` : `<span class="badge ${diff < 3600000 ? "warn" : "ok"}">Due in ${txt}</span>`;
}

export function stepsHTML(o) {
  return `<div class="steps">${orderSteps(o).map((s) => `
    <div class="step ${s.state === "done" ? "done" : ""} ${s.state === "late" ? "late" : ""} ${s.state === "overdue" ? "overdue" : ""}">
      <span class="dot"></span>
      <div><div>${esc(s.label)}</div>
        <div class="small muted">${s.at ? "Done " + fmtDT(s.at) : s.due ? "Due " + fmtDT(s.due) : "Waits for previous step"}</div></div>
      <div>${s.state === "late" ? '<span class="badge danger">Late</span>' : s.state === "done" ? '<span class="badge ok">On time</span>' : s.state === "overdue" ? '<span class="badge danger">Overdue</span>' : ""}</div>
    </div>`).join("")}</div>`;
}

export const telLinks = (phones) =>
  (phones || []).filter(Boolean).map((p) => `<a href="tel:${esc(p)}">${esc(p)}</a>`).join(" ") || '<span class="muted">—</span>';
