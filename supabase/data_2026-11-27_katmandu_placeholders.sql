-- 27 Nov 2026: Katmandu items with no price in its lists → "Price on request" (vendor kept), generic Chicken off the list,
-- Katmandu gets its own fresh Jalapeno (Waffle Co's is the bottled one).
do $$ declare r uuid := '350f7f60-514b-4926-a4ff-9d3f62ab3e72'; v_old uuid; v_new uuid; begin
  update boh_vendor_rates vr set rate = 0, active = false from boh_products p
   where p.id = vr.product_id and vr.rate >= 10000
     and p.id in (select product_id from boh_restaurant_products where restaurant_id = r and active)
     and p.name in ('Breads', 'Syrup', 'Breast Bone', 'Nestea ice tea 1 kg');
  update boh_restaurant_products set active = false where restaurant_id = r and product_id in (select id from boh_products where name = 'Chicken');
  update boh_stock_settings set auto = false where restaurant_id = r and product_id in (select id from boh_products where name = 'Chicken');
  if not exists (select 1 from boh_products where name = 'Jalapeno (fresh)') then
    select p.id into v_old from boh_products p join boh_restaurant_products rp on rp.product_id = p.id and rp.restaurant_id = r and rp.active
     where p.name = 'Jalapeno' limit 1;
    insert into boh_products (category_id, name, unit, active)
      values ((select id from boh_categories where name = 'Vegetables & Fruits'), 'Jalapeno (fresh)', 'kg', true) returning id into v_new;
    insert into boh_vendor_rates (vendor_id, product_id, rate, active) values ((select id from boh_vendors where name = 'Jay Kishan Vegetables'), v_new, 0, false);
    insert into boh_restaurant_products (restaurant_id, product_id, active, display_name) values (r, v_new, true, 'Jalapeno');
    if v_old is not null then
      update boh_restaurant_products set active = false where restaurant_id = r and product_id = v_old;
      update boh_stock_settings set product_id = v_new where restaurant_id = r and product_id = v_old;
      update boh_vendor_rates set active = false where product_id = v_old and rate = 0
        and vendor_id = (select id from boh_vendors where name = 'Jay Kishan Vegetables');
    end if;
  end if;
end $$;
select (select coalesce(string_agg(p.name, ', '), 'none') from boh_restaurant_products rp join boh_products p on p.id = rp.product_id
         join boh_product_best_rate b on b.product_id = rp.product_id
         where rp.restaurant_id = '350f7f60-514b-4926-a4ff-9d3f62ab3e72' and rp.active and b.rate >= 10000) as placeholders_left,
       (select count(*) from boh_restaurant_products rp left join boh_product_best_rate b on b.product_id = rp.product_id
         where rp.restaurant_id = '350f7f60-514b-4926-a4ff-9d3f62ab3e72' and rp.active and b.rate is null) as price_on_request,
       (select count(*) from boh_restaurant_products where restaurant_id = '350f7f60-514b-4926-a4ff-9d3f62ab3e72' and active) as items;
