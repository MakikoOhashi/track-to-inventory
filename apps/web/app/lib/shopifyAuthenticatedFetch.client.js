/**
 * Call a Worker API with an App Bridge session token.
 * Does not fall back to query/body shop when the token is missing.
 *
 * @param {{ idToken: () => Promise<string>, ready?: Promise<void> }} shopify
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 */
export async function shopifyAuthenticatedFetch(shopify, input, init = {}) {
  if (shopify.ready) {
    await shopify.ready;
  }

  const token = await shopify.idToken();
  if (!token) {
    throw new Error("SESSION_TOKEN_UNAVAILABLE");
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);

  return fetch(input, {
    ...init,
    headers,
  });
}
