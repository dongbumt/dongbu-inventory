-- Product codes are permanent identities. Keep the registered species immutable
-- so a 3xxxxx lamb product cannot later become a poultry or duck product.

create or replace function public.dbmt_guard_product_species_immutability()
returns trigger
language plpgsql
set search_path = public, extensions
as $dbmt$
begin
  if old.key='labelProducts' and new.key='labelProducts'
    and jsonb_typeof(old.payload)='array' and jsonb_typeof(new.payload)='array'
    and exists(
      select 1
      from jsonb_array_elements(old.payload) old_product
      join jsonb_array_elements(new.payload) new_product
        on new_product->>'id'=old_product->>'id'
      where btrim(coalesce(old_product->>'meattype','돼지고기'))
        <> btrim(coalesce(new_product->>'meattype','돼지고기'))
    )
  then
    raise exception '등록된 품목의 육종은 변경할 수 없습니다. 다른 육종은 새 품목으로 등록해주세요.';
  end if;
  return new;
end;
$dbmt$;

drop trigger if exists trg_dbmt_product_species_immutable on public.app_data;
create trigger trg_dbmt_product_species_immutable
before update of payload on public.app_data
for each row
when (old.key='labelProducts')
execute function public.dbmt_guard_product_species_immutability();

revoke all on function public.dbmt_guard_product_species_immutability() from public, anon, authenticated;
