-- 014: vendors may upload product photos for their offers (folder vendor-offers/ in boh-images). Applied 20 Nov 2026 via the SQL editor.
create policy boh_img_vendor_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'boh-images' and public.boh_role() = 'vendor' and (storage.foldername(name))[1] = 'vendor-offers');
