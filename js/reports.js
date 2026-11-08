import { sb, state, $, $$, esc, money, num, pct, fmtDT, fmtD, q, tabs, todayIST, daysAgoIST, downloadCSV, orderSteps, DELIVERY_LABEL } from "./lib.js";

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
  const NAMES = ["Restaurant sales", "Product × restaurant", "Category sales", "Top products", "Vendor purchases", "Coordinator SLA", "Payments outstanding", "Complaints", "Product requests", "Margin by restaurant & category"];
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
    let items = [];
    const ids = orders.map((o) => o.id);
    for (let i = 0; i < ids.length; i += 150) items = items.concat(await q(sb.from("boh_order_items").select("*").in("order_id", ids.slice(i, i + 150))));
    const orderMap = Object.fromEntries(orders.map((o) => [o.id, o]));
    items.forEach((i) => (i.order = orderMap[i.order_id]));
    data = { orders, items, complaints, requests, rest: Object.fromEntries(rests.map((r) => [r.id, r.name])), user: Object.fromEntries(users.map((u) => [u.id, u.full_name])) };
    render(current);
  };

  const render = (i) => {
    current = i;
    const out = $("#out");
    const R = [restaurantSales, productRestaurant, categorySales, topProducts, vendorPurchases, coordinatorSLA, paymentsOutstanding, complaintsReport, requestsReport, marginMatrix][i];
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
      return { Restaurant: d.rest[rid] || "—", Orders: os.length, Sales: sales, Cost: cost, Margin: sales - cost, "Margin %": sales ? ((sales - cost) / sales) * 100 : 0, "Avg order": sales / os.length,
        Paid: sum(os.filter((o) => o.status === "paid"), (o) => o.total), Outstanding: sum(os.filter((o) => o.status !== "paid"), (o) => o.total) };
    }).sort((a, b) => b.Sales - a.Sales);
    const tot = { Restaurant: "TOTAL", Orders: sum(rows, (r) => r.Orders), Sales: sum(rows, (r) => r.Sales), Cost: sum(rows, (r) => r.Cost) };
    tot.Margin = tot.Sales - tot.Cost; tot["Margin %"] = tot.Sales ? (tot.Margin / tot.Sales) * 100 : 0; tot["Avg order"] = tot.Orders ? tot.Sales / tot.Orders : 0;
    tot.Paid = sum(rows, (r) => r.Paid); tot.Outstanding = sum(rows, (r) => r.Outstanding);
    const m = (k) => ({ key: k, label: k, num: true, fmt: money });
    bindInner = null;
    return {
      title: "Restaurant-wise sales",
      html: table([{ key: "Restaurant", label: "Restaurant", fmt: (v) => (v === "TOTAL" ? `<b>${v}</b>` : esc(v)) }, { key: "Orders", label: "Orders", num: true }, m("Sales"), m("Cost"), m("Margin"),
        { key: "Margin %", label: "Margin %", num: true, fmt: pct }, m("Avg order"), m("Paid"), m("Outstanding")], rows.length ? [...rows, tot] : [], { bar: "Sales" }),
      csv: [...rows, tot].map((r) => ({ ...r, "Margin %": r["Margin %"].toFixed(2) })),
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
    const keys = ["allocated", "acknowledged", "vendor_ordered", "followup1", "followup2", "paid"];
    const label = { allocated: "Allocation (admin)", acknowledged: "Ack", vendor_ordered: "Vendor order", followup1: "F-up 1", followup2: "F-up 2", paid: "Payment" };
    const rows = [...groupBy(d.orders, (o) => o.coordinator_id || "none")].map(([cid, os]) => {
      const r = { Coordinator: cid === "none" ? "Unassigned" : d.user[cid] || "—", Orders: os.length, Overdue: 0 };
      keys.forEach((k) => {
        let done = 0, onTime = 0;
        os.forEach((o) => { const st = orderSteps(o).find((s) => s.key === k); if (st.state === "done" || st.state === "late") { done++; if (st.state === "done") onTime++; } if (st.state === "overdue") r.Overdue++; });
        r[label[k]] = done ? (onTime / done) * 100 : null;
      });
      return r;
    });
    bindInner = null;
    return { title: "Coordinator SLA — % of steps done on time", html: table([{ key: "Coordinator", label: "Coordinator" }, { key: "Orders", label: "Orders", num: true },
      ...keys.map((k) => ({ key: label[k], label: label[k], num: true, fmt: (v) => (v == null ? "—" : `<span class="badge ${v >= 90 ? "ok" : v >= 70 ? "warn" : "danger"}">${pct(v)}</span>`) })),
      { key: "Overdue", label: "Currently overdue", num: true }], rows), csv: rows };
  }

  function paymentsOutstanding(d) {
    const rows = d.orders.filter((o) => o.status !== "paid").map((o) => {
      const due = new Date(new Date(o.created_at).getTime() + state.settings.sla_payment_hrs * 3600000);
      return { Order: o.order_no, Restaurant: d.rest[o.restaurant_id], Placed: fmtDT(o.created_at), Status: o.status, Amount: Number(o.total), "Payment due": fmtDT(due), "Hours overdue": Math.max(0, Math.round((Date.now() - due) / 3600000)) };
    }).sort((a, b) => b["Hours overdue"] - a["Hours overdue"]);
    bindInner = null;
    return { title: `Payments outstanding (due ${state.settings.sla_payment_hrs} hrs from order)`, html: table([{ key: "Order", label: "#" }, { key: "Restaurant", label: "Restaurant" }, { key: "Placed", label: "Placed" }, { key: "Status", label: "Status" },
      { key: "Amount", label: "Amount", num: true, fmt: money }, { key: "Payment due", label: "Due" }, { key: "Hours overdue", label: "Overdue (hrs)", num: true, fmt: (v) => (v ? `<span class="badge danger">${v}</span>` : "—") }], rows), csv: rows };
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
