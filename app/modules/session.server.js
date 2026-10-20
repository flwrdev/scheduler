// Returns the shop domain of an authenticated session, or throws a 401 response when the
// session has no shop.

export function getSessionShop(session) {
  if (typeof session?.shop === "string" && session.shop) return session.shop;
  throw new Response("Missing authenticated shop session.", { status: 401 });
}
