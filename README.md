# Back of House Co

Ordering platform for restaurants and cafes: raw material, disposables, cleaning supplies, machines — **order before 4 PM, delivered tomorrow.**

Static web app (plain HTML/JS, no build step) on top of a dedicated Supabase project `back-of-house-co` (Mumbai).

## Panels

| Role | What they do |
|---|---|
| **Super admin** | Everything, plus creates admins and edits working hours / SLAs / cut-off (Settings) |
| **Admin** | Restaurants (created together with their login and switched-on categories), ordering lists & mark-ups, products, vendors & rates, request approvals, showcase slideshow, category-wise allocation of orders to coordinators, complaints, reports. Admins can be assigned to restaurants (internal only). |
| **Coordinator** | Sees the order categories allocated to them with vendor phone numbers & delivery style, marks each step, and records overheads (porter, delivery charge, anything paid) when marking delivered |
| **Restaurant (customer)** | Orders from a photo or list view of their ordering list (switched-on categories only) with their prices, repeats last order, sees who is handling each category of their order, browses & requests other products, raises complaints |

Customers can't sign up — admins create every restaurant together with its login. The super admin can see the passwords set through the app (Team & logins / restaurant Logins).

## Pricing

`selling price = best active vendor rate × (1 + mark-up %)`

Mark-up resolution: **product override for that restaurant → restaurant's category mark-up → category default**.
The best rate is the lowest active rate from an active vendor; making a vendor inactive instantly switches to the next best vendor.
Restaurants never see cost, vendor or margin — prices come from the `boh_my_catalog()` function and order totals are calculated on the server.

## Order workflow & SLAs (working hours, configurable)

Each category of an order is allocated to a coordinator (one pick fills every category; any category can be changed). Every category runs these steps on its own; the order is delivered when all categories are.

1. Admin allocates the order to a coordinator — 2 working hrs from order
2. Coordinator acknowledges — 1 working hr
3. Order placed with vendor — 2 working hrs
4. 1st follow-up — 4 working hrs
5. 2nd follow-up — 2 working hrs
6. Delivered
7. Payment completed — 4 working hrs after delivery

Working hours default to Mon–Sat, 10:00–19:00 IST. Overdue steps are flagged on the dashboard, orders list and the coordinator's screen, and the Coordinator SLA report shows the on-time %.

## Reports

Restaurant-wise sales with overheads & net margin · Overheads (total porter, delivery, other — by type, restaurant, coordinator) · Product × restaurant (who buys what) · Category sales · Top products · Vendor purchases · Coordinator SLA · Payments outstanding · Complaints · Product requests · Realised margin by restaurant × category. Every report exports to CSV.

## First-time setup

1. The super admin is created privately: Supabase dashboard → Authentication → Users → Add user (auto-confirm), then promote it with
   `insert into boh_users (id, email, full_name, role) select id, email, 'Super Admin', 'super_admin' from auth.users where email = '<email>';`
   There is no public sign-up or setup page.
2. Settings → check working hours, cut-off and support phone.
3. Categories → set default mark-ups. Vendors → add vendors with all phone numbers and delivery style.
4. Products → add products (or **Import CSV** with columns `category,name,unit,brand,sku,description`) and their vendor rates.
5. Team → add coordinators. Restaurants → add restaurant → set category mark-up → **Add products** from their ordering list → **Logins** to create their sign-in.

## Project layout

```
index.html               app shell
css/styles.css
js/config.js             Supabase URL + publishable key
js/lib.js                client, helpers, working-hours SLA engine
js/app.js                auth + role-based routing
js/admin.js              admin screens
js/coordinator.js        coordinator screens
js/customer.js           restaurant screens
js/reports.js            reports
supabase/migrations/     database schema, RLS, functions
supabase/functions/boh-admin-users/   edge function that creates logins (service role stays server-side)
```

## Deploy

Any static host works. For GitHub Pages: Settings → Pages → Deploy from branch → `main` / root.
