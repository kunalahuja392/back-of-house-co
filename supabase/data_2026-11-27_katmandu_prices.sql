-- 27 Nov 2026: rates from KJM_Raw_Material_Price_List.pdf for Katmandu items that had no price; LPG added.
do $$ declare r uuid := '350f7f60-514b-4926-a4ff-9d3f62ab3e72'; x record; v_pid uuid; v_vid uuid; v_cat uuid; n int := 0; begin
  -- gas: new category (2% for Katmandu), vendor and product
  insert into boh_categories (name, default_margin, active) select 'Gas & Fuel', 5, true where not exists (select 1 from boh_categories where name = 'Gas & Fuel');
  select id into v_cat from boh_categories where name = 'Gas & Fuel';
  insert into boh_restaurant_category_margins (restaurant_id, category_id, margin_pct, active) values (r, v_cat, 2, true)
    on conflict (restaurant_id, category_id) do update set active = true;
  insert into boh_vendors (name, phones, delivery_style, active, approval, notes)
    select 'Venkatesh Gas (Indian Oil)', '{}', 'vendor_delivers', true, 'approved', 'From Katmandu price list (27 Nov 2026).'
    where not exists (select 1 from boh_vendors where name = 'Venkatesh Gas (Indian Oil)');
  insert into boh_products (category_id, name, unit, active) select v_cat, 'LPG commercial cylinder 19 kg', 'cylinder', true
    where not exists (select 1 from boh_products where name = 'LPG commercial cylinder 19 kg');
  insert into boh_restaurant_products (restaurant_id, product_id, active) select r, id, true from boh_products where name = 'LPG commercial cylinder 19 kg'
    on conflict (restaurant_id, product_id) do update set active = true;
  insert into boh_stock_settings (restaurant_id, product_id, method, reorder_level, target_level, auto)
    select r, id, 'topup', 2, 4, true from boh_products where name = 'LPG commercial cylinder 19 kg'
    on conflict (restaurant_id, product_id) do update set reorder_level = 2, target_level = 4, method = 'topup';
  for x in select * from (values
('Liquid egg (bottled)',200,'Yellows & Whites','litre'),
('Noodles (hakka)',110,'Puran Thakur','kg'),
('Dry red chilli (whole)',330,'AMIT RAJ KIRANA',null),
('Dry red chilli – medium spice',290,'AMIT RAJ KIRANA','kg'),
('Mushroom cheese dimsum (frozen)',33.6,'My Momo Factory','pcs'),
('Wonton sheets',300,'Puran Thakur','kg'),
('Drinking water',40,'DSRO ICE AND CAN','can (20 L)'),
('Ice cubes',25,'DSRO ICE AND CAN','kg'),
('Popping boba – watermelon',380,'The Brewing Counter (Boba)','kg'),
('Popping boba – green apple',380,'The Brewing Counter (Boba)','kg'),
('Popping boba – pineapple',350,'The Brewing Counter (Boba)','kg'),
('Popping boba – pink guava',350,'The Brewing Counter (Boba)','kg'),
('Box envelope (printed)',160,'Dispoware','pack'),
('Container 650 ml rectangle, transparent (NX 650)',7.5,'Dispoware','pcs'),
('Container 750 ml round, transparent (Hira 750)',7,'Dispoware','pcs'),
('Container CHUK 3CP',4,'Dispoware','pcs'),
('Paper napkin soft 1-ply',24,'Dispoware','pack'),
('Chutney wati 35 ml',0.7,'Dispoware','pcs'),
('Wooden spoon 170 mm',80,'Dispoware','pack (50 pcs)'),
('Wooden fork 160 mm',50,'Dispoware','pack (50 pcs)'),
('Chopsticks wrapped',2,'Dispoware','pcs'),
('Blazewings wing / burger box (printed)',6.15,'Eskays (Bhavin)','pcs'),
('Sushi box (beige, 250 gsm)',9.25,'Eskays (Bhavin)','pcs'),
('LPG commercial cylinder 19 kg',3020,'Venkatesh Gas (Indian Oil)','cylinder')) t(name, rate, vendor, unit) loop
    select p.id into v_pid from boh_restaurant_products rp join boh_products p on p.id = rp.product_id
     where rp.restaurant_id = r and rp.active and p.name = x.name limit 1;
    select id into v_vid from boh_vendors where name = x.vendor and active;
    if v_pid is null or v_vid is null then raise exception 'not found: % / %', x.name, x.vendor; end if;
    if x.unit is not null then update boh_products set unit = x.unit where id = v_pid; end if;
    -- the priced vendor becomes the one we use: its rate goes live, any ₹10,000 placeholder for this item is switched off
    insert into boh_vendor_rates (vendor_id, product_id, rate, active, updated_at) values (v_vid, v_pid, x.rate, true, now())
      on conflict (vendor_id, product_id) do update set rate = excluded.rate, active = true, updated_at = now();
    update boh_vendor_rates set active = false where product_id = v_pid and vendor_id <> v_vid and rate >= 10000;
    -- auto-order can run now that it has a price (only where a fill-to level is set)
    update boh_stock_settings set auto = true where restaurant_id = r and product_id = v_pid and target_level is not null;
    n := n + 1;
  end loop;
  raise notice 'priced %', n;
end $$;
select (select count(*) from boh_restaurant_products rp left join boh_product_best_rate b on b.product_id = rp.product_id
         where rp.restaurant_id = '350f7f60-514b-4926-a4ff-9d3f62ab3e72' and rp.active and b.rate is null) price_on_request,
       (select string_agg(p.name, ', ') from boh_restaurant_products rp join boh_products p on p.id = rp.product_id join boh_product_best_rate b on b.product_id = rp.product_id
         where rp.restaurant_id = '350f7f60-514b-4926-a4ff-9d3f62ab3e72' and rp.active and b.rate >= 10000) placeholders,
       (select count(*) from boh_stock_settings where restaurant_id = '350f7f60-514b-4926-a4ff-9d3f62ab3e72' and auto) auto_on;
