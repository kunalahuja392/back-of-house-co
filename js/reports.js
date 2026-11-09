import { addWorkingHours, sb, state, $, $$, esc, money, num, pct, fmtDT, fmtD, q, tabs, todayIST, daysAgoIST, downloadCSV, orderSteps, allocSteps, DELIVERY_LABEL } from "./lib.js?v=13";

const sum = (a, f) => a.reduce((s, x) => s + Number(f(x) || 0), 0);
function groupBy(arr, keyFn) { const m = new Map(); arr.forEach((x) => { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }); return m; }

function table(cols, rows, { bar } = {}) {
  if (!rows.length) return `<div class="empty">No data for this period.</div>`;
  const max = bar ? Math.max(...rows.map((r) => Number(r[bar]) || 0), 1) : 0;
  return `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th class="${c.num ? "right" : ""}">${esc(c.label)}</th>`).join("")}${bar ? "<th style='width:18%'></th>" : ""}</tr></thead><tbody>
    ${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? "right" : ""}">${c.fmt ? c.fmt(r[c.key], r) : esc(r[c.key] ?? "")}</td>`).join("")}
      ${bar ? `<td><div class="chart-bar" style="width:${((Number(r[bar]) || 0) / max) * 100}%"></div></td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}

export async function reports(el) {
  el.innerHTML = `
    <div class="page-head"><div><h1>Reports</h1><div class="muted">All figures exclude cancelled orders. Export any report to CSV.</div></div>
      <div class="row"><div><label>From</label><input type="date" id="rf" value="${daysAgoIST(30)}"></div><div><label>To</label><input type="date" id="rt" value="${todayIST()}"></div>
      <div><label>&nbsp;</label><button class="btn primary" id="run">Run</button></div></div></div>
    <div class="tabs" id="tb"></div><div id="out"><div class="empty">Loading…</div></div>`;
  let data;
  const NAMES = ["Restaurant sales", "Overheads", "Product × restaurant", "Category sales", "Top products", "Vendor purchases", "Coordinator SLA", "Payments outstanding", "Complaints", "Product requests", "Margin by restaurant & category"];
  let current = 0;

  const load = async () => {
    const from = $("#rf").value + "T00:00:00+05:30", to = $("#rt").value + "T23:59:59+05:30";
    const [orders, rests, users, complaints, requests] = await Promise.all([
      q(sb.from("boh_orders").select("*").gte("created_at", from).lte("created_at", to).neq("status", "cancelled")),
      q(sb.from("boh_restaurants").select("id,name")),
      q(sb.from("boh_users").select("id,full_name,role")),
      q(sb.from("boh_complaints").select("*").gte("created_at", from).lte("created_at", to)),
      q(sb.from("boh_product_requests").select("*, product:boh_products(name)").gte("created_at", from).lte("created_at", to)),
    ]);
    let items = [], ohs = [], allocs = [];
    const ids = orders.map((o) => o.id);
    for (let i = 0; i < ids.length; i += 150) {
      const chunk = ids.slice(i, i + 150);
      const [a, b, c] = await Promise.all([
        q(sb.from("boh_order_items").select("*").in("order_id", chunk)),
        q(sb.from("boh_order_overheads").select("*").in("order_id", chunk)),
        q(sb.from("boh_order_allocations").select("*").in("order_id", chunk)),
      ]);
      items = items.concat(a); ohs = ohs.concat(b); allocs = allocs.concat(c);
    }
    const orderMap = Object.fromEntries(orders.map((o) => [o.id, o]));
    items.forEach((i) => (i.order = orderMap[i.order_id]));
    ohs.forEach((x) => (x.order = orderMap[x.order_id]));
    allocs.forEach((a) => (a.order = orderMap[a.order_id]));
    data = { orders, items, ohs, allocs, complaints, requests, rest: Object.fromEntries(rests.map((r) => [r.id, r.name])), user: Object.fromEntries(users.map((u) => [u.id, u.full_name])) };
    render(current);
  };

  const render = (i) => {
    current = i;
    const out = $("#out");
    const R = [restaurantSales, overheadsReport, productRestaurant, categorySales, topProducts, vendorPurchases, coordinatorSLA, paymentsOutstanding, complaintsReport, requestsReport, marginMatrix][i];
    const { html, csv, title } = R(data);
    out.innerHTML = `<div class="row between" style="margin-bottom:.6rem"><h2 style="margin:0">${esc(title)}</h2><button class="btn sm" id="csv">⬇ Export CSV</button></div>${html}`;
    $("#csv").onclick = () => downloadCSV(`${title.replace(/\W+/g, "_").toLowerCase()}_${$("#rf").value}_${$("#rt").value}.csv`, csv);
    bindInner?.();
  };
  let bindInner = null;

  // ---------------------------------------------------------------- report builders
  function restaurantSales(d) {
    const rows = [...groupBy(d.orders, (o) => o.restaurant_id)].map(([rid, os]) => {
      const sales = sum(os, (o) => o.total), cost = sum(os, (o) => o.cost_total);
      const oh = sum(d.ohs.filter((x) => x.order.restaurant_id === rid), (x) => x.amount);
      return { Restaurant: d.rest[rid] || "—", Orders: os.length, Sales: sales, Cost: cost, Margin: sales - cost, "Margin %": sales ? ((sales - cost) / sales) * 100 : 0,
        Overheads: oh, "Net margin": sales - cost - oh, "Avg order": sales / os.length,
        Paid: sum(os.filter((o) => o.payment_status === "paid"), (o) => o.total), Outstanding: sum(os.filter((o) => o.payment_status !== "paid"), (o) => o.total) };
    }).sort((a, b) => b.Sales - a.Sales);
    const tot = { Restaurant: "TOTAL", Orders: sum(rows, (r) => r.Orders), Sales: sum(rows, (r) => r.Sales), Cost: sum(rows, (r) => r.Cost) };
    tot.Margin = tot.Sales - tot.Cost; tot["Margin %"] = tot.Sales ? (tot.Margin / tot.Sales) * 100 : 0;
    tot.Overheads = sum(rows, (r) => r.Overheads); tot["Net margin"] = tot.Margin - tot.Overheads; tot["Avg order"] = tot.Orders ? tot.Sales / tot.Orders : 0;
    tot.Paid = sum(rows, (r) => r.Paid); tot.Outstanding = sum(rows, (r) => r.Outstanding);
    const m = (k) => ({ key: k, label: k, num: true, fmt: money });
    bindInner = null;
    return {
      title: "Restaurant-wise sales",
      html: table([{ key: "Restaurant", label: "Restaurant", fmt: (v) => (v === "TOTAL" ? `<b>${v}</b>` : esc(v)) }, { key: "Orders", label: "Orders", num: true }, m("Sales"), m("Cost"), m("Margin"),
        { key: "Margin %", label: "Margin %", num: true, fmt: pct }, m("Overheads"), m("Net margin"), m("Avg order"), m("Paid"), m("Outstanding")], rows.length ? [...rows, tot] : [], { bar: "Sales" }),
      csv: [...rows, tot].map((r) => ({ ...r, "Margin %": r["Margin %"].toFixed(2) })),
    };
  }

  function overheadsReport(d) {
    const total = sum(d.ohs, (x) => x.amount);
    const byKind = [...groupBy(d.ohs, (x) => x.kind)].map(([k, xs]) => ({ Type: k, Entries: xs.length, Amount: sum(xs, (x) => x.amount) })).sort((a, b) => b.Amount - a.Amount);
    const byRest = [...groupBy(d.ohs, (x) => x.order.restaurant_id)].map(([rid, xs]) => {
      const sales = sum(d.orders.filter((o) => o.restaurant_id === rid), (o) => o.total);
      return { Restaurant: d.rest[rid], Amount: sum(xs, (x) => x.amount), "% of sales": sales ? (sum(xs, (x) => x.amount) / sales) * 100 : 0 };
    }).sort((a, b) => b.Amount - a.Amount);
    const byCoord = [...groupBy(d.ohs, (x) => x.created_by)].map(([u, xs]) => ({ Coordinator: d.user[u] || "—", Entries: xs.length, Amount: sum(xs, (x) => x.amount) })).sort((a, b) => b.Amount - a.Amount);
    const sales = sum(d.orders, (o) => o.total);
    const card = (l, v, sub = "") => `<div class="card stat"><div class="l">${esc(l)}</div><div class="v">${v}</div>${sub ? `<div class="small muted">${sub}</div>` : ""}</div>`;
    bindInner = null;
    return {
      title: "Overheads (porter, delivery & other charges)",
      html: `<div class="grid k4" style="margin-bottom:1rem">
          ${card("Total overheads", money(total), sales ? pct((total / sales) * 100) + " of sales" : "")}
          ${byKind.map((k) => card("Total " + k.Type.toLowerCase(), money(k.Amount), k.Entries + " entries")).join("")}
        </div>
        <div class="grid c2">
          <div><h3>By type</h3>${table([{ key: "Type", label: "Type" }, { key: "Entries", label: "Entries", num: true }, { key: "Amount", label: "Amount", num: true, fmt: money }], byKind, { bar: "Amount" })}</div>
          <div><h3>By restaurant</h3>${table([{ key: "Restaurant", label: "Restaurant" }, { key: "Amount", label: "Amount", num: true, fmt: money }, { key: "% of sales", label: "% of sales", num: true, fmt: pct }], byRest, { bar: "Amount" })}</div>
          <div><h3>By coordinator</h3>${table([{ key: "Coordinator", label: "Coordinator" }, { key: "Entries", label: "Entries", num: true }, { key: "Amount", label: "Amount", num: true, fmt: money }], byCoord)}</div>
        </div>`,
      csv: d.ohs.map((x) => ({ Date: fmtDT(x.created_at), Order: x.order.order_no, Restaurant: d.rest[x.order.restaurant_id], Type: x.kind, Amount: x.amount, Note: x.note || "", "Entered by": d.user[x.created_by] || "" })),
    };
  }

  function productRestaurant(d) {
    const rows = [...groupBy(d.items, (i) => i.product_name + "||" + i.order.restaurant_id)].map(([k, is]) => ({
      Product: is[0].product_name, Category: is[0].category_name, Restaurant: d.rest[is[0].order.restaurant_id], Orders: new Set(is.map((i) => i.order_id)).size,
      Qty: sum(is, (i) => i.qty), Unit: is[0].unit, Amount: sum(is, (i) => i.line_total), "Avg price": sum(is, (i) => i.line_total) / sum(is, (i) => i.qty),
    })).sort((a, b) => a.Product.localeCompare(b.Product) || b.Amount - a.Amount);
    const products = [...new Set(rows.map((r) => r.Product))].sort();
    const restaurants = [...new Set(rows.map((r) => r.Restaurant))].sort();
    bindInner = () => {
      const f = () => {
        const p = $("#pf").value, r = $("#rf2").value;
        $$("#prt tbody tr").forEach((tr, idx) => { const row = rows[idx]; tr.classList.toggle("hidden", !((!p || row.Product === p) && (!r || row.Restaurant === r))); });
      };
      $("#pf").onchange = f; $("#rf2").onchange = f;
    };
    return {
      title: "Which product is purchased by which restaurant",
      html: `<div class="row" style="margin-bottom:.6rem"><select id="pf" style="max-width:280px"><option value="">All products</option>${products.map((p) => `<option>${esc(p)}</option>`).join("")}</select>
        <select id="rf2" style="max-width:280px"><option value="">All restaurants</option>${restaurants.map((p) => `<option>${esc(p)}</option>`).join("")}</select></div>
        <div id="prt">${table([{ key: "Product", label: "Product" }, { key: "Category", label: "Category" }, { key: "Restaurant", label: "Restaurant" }, { key: "Orders", label: "Orders", num: true },
          { key: "Qty", label: "Qty", num: true, fmt: (v, r) => num(v, 3) + " " + esc(r.Unit) }, { key: "Avg price", label: "Avg price", num: true, fmt: money }, { key: "Amount", label: "Amount", num: true, fmt: money }], rows)}</div>`,
      csv: rows,
    };
  }

  function categorySales(d) {
    const rows = [...groupBy(d.items, (i) => i.category_name || "—")].map(([c, is]) => {
      const sales = sum(is, (i) => i.line_total), cost = sum(is, (i) => i.unit_cost * i.qty);
      return { Category: c, Lines: is.length, Restaurants: new Set(is.map((i) => i.order.restaurant_id)).size, Sales: sales, Cost: cost, Margin: sales - cost, "Margin %": sales ? ((sales - cost) / sales) * 100 : 0 };
    }).sort((a, b) => b.Sales - a.Sales);
    bindInner = null;
    return { title: "Category-wise sales", html: table([{ key: "Category", label: "Category" }, { key: "Lines", label: "Order lines", num: true }, { key: "Restaurants", label: "Restaurants", num: true },
      { key: "Sales", label: "Sales", num: true, fmt: money }, { key: "Cost", label: "Cost", num: true, fmt: money }, { key: "Margin", label: "Margin", num: true, fmt: money }, { key: "Margin %", label: "Margin %", num: true, fmt: pct }], rows, { bar: "Sales" }), csv: rows };
  }

  function topProducts(d) {
    const rows = [...groupBy(d.items, (i) => i.product_name)].map(([p, is]) => ({
      Product: p, Category: is[0].category_name, Restaurants: new Set(is.map((i) => i.order.restaurant_id)).size, Qty: sum(is, (i) => i.qty), Unit: is[0].unit,
      Sales: sum(is, (i) => i.line_total), Margin: sum(is, (i) => i.line_total - i.unit_cost * i.qty),
    })).sort((a, b) => b.Sales - a.Sales);
    bindInner = null;
    return { title: "Top products", html: table([{ key: "Product", label: "Product" }, { key: "Category", label: "Category" }, { key: "Restaurants", label: "Bought by", num: true },
      { key: "Qty", label: "Qty", num: true, fmt: (v, r) => num(v, 3) + " " + esc(r.Unit) }, { key: "Sales", label: "Sales", num: true, fmt: money }, { key: "Margin", label: "Margin", num: true, fmt: money }], rows, { bar: "Sales" }), csv: rows };
  }

  function vendorPurchases(d) {
    const rows = [...groupBy(d.items, (i) => i.vendor_name || "—")].map(([v, is]) => ({
      Vendor: v, Delivery: DELIVERY_LABEL[is[0].delivery_style] || "", Orders: new Set(is.map((i) => i.order_id)).size, Products: new Set(is.map((i) => i.product_name)).size,
      "Purchase value": sum(is, (i) => i.unit_cost * i.qty), "Sold for": sum(is, (i) => i.line_total),
    })).sort((a, b) => b["Purchase value"] - a["Purchase value"]);
    bindInner = null;
    return { title: "Vendor purchases (at order-time best rate)", html: table([{ key: "Vendor", label: "Vendor" }, { key: "Delivery", label: "Delivery" }, { key: "Orders", label: "Orders", num: true }, { key: "Products", label: "Products", num: true },
      { key: "Purchase value", label: "Purchase value", num: true, fmt: money }, { key: "Sold for", label: "Sold for", num: true, fmt: money }], rows, { bar: "Purchase value" }), csv: rows };
  }

  function coordinatorSLA(d) {
    const keys = ["allocated", "acknowledged", "vendor_ordered", "followup1", "followup2", "delivered"];
    const label = { allocated: "Allocation (admin)", acknowledged: "Ack", vendor_ordered: "Vendor order", followup1: "F-up 1", followup2: "F-up 2", delivered: "Delivered by date" };
    const rows = [...groupBy(d.allocs, (a) => a.coordinator_id)].map(([cid, as]) => {
      const r = { Coordinator: d.user[cid] || "—", Categories: as.length, Orders: new Set(as.map((a) => a.order_id)).size, Overdue: 0,
        Overheads: sum(d.ohs.filter((x) => as.some((a) => a.id === x.allocation_id)), (x) => x.amount) };
      keys.forEach((k) => {
        let done = 0, onTime = 0;
        as.forEach((a) => { const st = allocSteps(a.order, a).find((s) => s.key === k); if (st.state === "done" || st.state === "late") { done++; if (st.state === "done") onTime++; } if (st.state === "overdue") r.Overdue++; });
        r[label[k]] = done ? (onTime / done) * 100 : null;
      });
      // payment is per order: count orders this coordinator was on
      let pd = 0, pon = 0;
      [...new Set(as.map((a) => a.order))].forEach((o) => { const st = orderSteps(o)[2]; if (st.at) { pd++; if (st.state === "done") pon++; } });
      r.Payment = pd ? (pon / pd) * 100 : null;
      return r;
    });
    const unalloc = d.orders.filter((o) => o.status === "placed").length;
    bindInner = null;
    const badge = (v) => (v == null ? "—" : `<span class="badge ${v >= 90 ? "ok" : v >= 70 ? "warn" : "danger"}">${pct(v)}</span>`);
    return { title: "Coordinator SLA — % of steps done on time (per category allocated)",
      html: (unalloc ? `<div class="notice">${unalloc} order(s) in this period still waiting for allocation.</div>` : "") +
        table([{ key: "Coordinator", label: "Coordinator" }, { key: "Orders", label: "Orders", num: true }, { key: "Categories", label: "Categories", num: true },
        ...[...keys.map((k) => label[k]), "Payment"].map((l) => ({ key: l, label: l, num: true, fmt: badge })),
        { key: "Overdue", label: "Overdue now", num: true }, { key: "Overheads", label: "Overheads", num: true, fmt: money }], rows), csv: rows };
  }

  function paymentsOutstanding(d) {
    const label = (o) => o.payment_status === "under_review" ? "Under approval" : o.payment_rejected_note ? "Rejected — not paid" : "Unpaid";
    const rows = d.orders.filter((o) => o.payment_status !== "paid").map((o) => {
      const due = o.payment_mode === "prepaid" ? new Date(o.created_at) : o.delivered_at ? addWorkingHours(o.delivered_at, state.settings.sla_payment_hrs) : null;
      return { Order: o.order_no, Restaurant: d.rest[o.restaurant_id], Mode: o.payment_mode === "prepaid" ? "Pre-pay" : "Pay on delivery", Payment: label(o),
        "Claim ref": o.payment_claim_ref || "", "Rejection note": o.payment_status === "unpaid" ? o.payment_rejected_note || "" : "",
        "Order status": o.status, Amount: Number(o.total), Delivered: fmtDT(o.delivered_at), "Payment due": due ? fmtDT(due) : "After delivery",
        "Hours overdue": due ? Math.max(0, Math.round((Date.now() - due) / 3600000)) : 0 };
    }).sort((a, b) => (b.Payment === "Under approval") - (a.Payment === "Under approval") || b["Hours overdue"] - a["Hours overdue"]);
    const tot = (f) => money(sum(rows.filter(f), (r) => r.Amount));
    bindInner = null;
    return { title: `Payments outstanding (pay on delivery due ${state.settings.sla_payment_hrs} working hrs after delivery)`,
      html: `<div class="grid k4" style="margin-bottom:1rem">
          <div class="card stat"><div class="l">Total outstanding</div><div class="v">${tot(() => true)}</div></div>
          <div class="card stat"><div class="l">Under approval</div><div class="v">${tot((r) => r.Payment === "Under approval")}</div></div>
          <div class="card stat"><div class="l">Rejected — not paid</div><div class="v">${tot((r) => r.Payment === "Rejected — not paid")}</div></div>
          <div class="card stat"><div class="l">Pre-pay not received</div><div class="v">${tot((r) => r.Mode === "Pre-pay")}</div></div></div>` +
        table([{ key: "Order", label: "#" }, { key: "Restaurant", label: "Restaurant" }, { key: "Mode", label: "Mode" },
        { key: "Payment", label: "Payment", fmt: (v) => `<span class="badge ${v === "Under approval" ? "warn" : "danger"}">${esc(v)}</span>` }, { key: "Claim ref", label: "Claim ref" },
        { key: "Order status", label: "Order" }, { key: "Amount", label: "Amount", num: true, fmt: money }, { key: "Delivered", label: "Delivered" }, { key: "Payment due", label: "Due" },
        { key: "Hours overdue", label: "Overdue (hrs)", num: true, fmt: (v) => (v ? `<span class="badge danger">${v}</span>` : "—") }], rows), csv: rows };
  }

  function complaintsReport(d) {
    const rows = [...groupBy(d.complaints, (c) => c.restaurant_id + "||" + c.category)].map(([, cs]) => {
      const res = cs.filter((c) => c.resolved_at);
      return { Restaurant: d.rest[cs[0].restaurant_id], Type: cs[0].category, Total: cs.length, Open: cs.filter((c) => c.status !== "resolved").length, Resolved: res.length,
        "Avg hrs to resolve": res.length ? sum(res, (c) => (new Date(c.resolved_at) - new Date(c.created_at)) / 3600000) / res.length : null };
    }).sort((a, b) => b.Total - a.Total);
    bindInner = null;
    return { title: "Complaints by restaurant & type", html: table([{ key: "Restaurant", label: "Restaurant" }, { key: "Type", label: "Type" }, { key: "Total", label: "Total", num: true }, { key: "Open", label: "Open", num: true },
      { key: "Resolved", label: "Resolved", num: true }, { key: "Avg hrs to resolve", label: "Avg hrs to resolve", num: true, fmt: (v) => (v == null ? "—" : num(v, 1)) }], rows, { bar: "Total" }), csv: rows };
  }

  function requestsReport(d) {
    const rows = d.requests.map((r) => ({ Date: fmtDT(r.created_at), Restaurant: d.rest[r.restaurant_id], Item: r.product?.name || r.item_name, Status: r.status, "Mark-up %": r.margin_pct, Note: r.note || "" }));
    bindInner = null;
    return { title: "Product requests", html: table([{ key: "Date", label: "Date" }, { key: "Restaurant", label: "Restaurant" }, { key: "Item", label: "Item" }, { key: "Status", label: "Status" },
      { key: "Mark-up %", label: "Mark-up %", num: true, fmt: pct }, { key: "Note", label: "Note" }], rows), csv: rows };
  }

  function marginMatrix(d) {
    const cats = [...new Set(d.items.map((i) => i.category_name))].sort();
    const rows = [...groupBy(d.items, (i) => i.order.restaurant_id)].map(([rid, is]) => {
      const r = { Restaurant: d.rest[rid] };
      cats.forEach((c) => { const ci = is.filter((i) => i.category_name === c); const s = sum(ci, (i) => i.line_total); r[c] = s ? ((s - sum(ci, (i) => i.unit_cost * i.qty)) / s) * 100 : null; });
      return r;
    });
    bindInner = null;
    return { title: "Realised margin % by restaurant × category", html: table([{ key: "Restaurant", label: "Restaurant" }, ...cats.map((c) => ({ key: c, label: c, num: true, fmt: (v) => (v == null ? "" : pct(v)) }))], rows), csv: rows };
  }

  tabs($("#tb"), NAMES, (i) => { if (data) render(i); else current = i; });
  $("#run").onclick = load;
  load();
}
