// The single shop this app manages, read from env. SHOP_DOMAIN is the
// canonical name; MESSENGER_SHOP and LALAMOVE_SHOP are the older names.
export function resolveShopDomain(): string | undefined {
  return (
    process.env.SHOP_DOMAIN?.trim() ||
    process.env.MESSENGER_SHOP?.trim() ||
    process.env.LALAMOVE_SHOP?.trim() ||
    undefined
  );
}
