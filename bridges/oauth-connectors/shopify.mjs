const VERSION = '2026-10';
const ORDERS = `query Orders($first: Int!, $after: String) {
  orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
    nodes { id name displayFinancialStatus displayFulfillmentStatus }
    pageInfo { hasNextPage endCursor }
  }
}`;
const ORDER = `query Order($id: ID!) {
  order(id: $id) { id name displayFinancialStatus displayFulfillmentStatus }
}`;
const STOCK = `query Stock($item: ID!, $location: ID!) {
  inventoryItem(id: $item) { id inventoryLevel(locationId: $location) { quantities(names: ["available"]) { name quantity } } }
}`;
const gid = (value, kind) => typeof value === 'string' && new RegExp('^gid://shopify/' + kind + '/[1-9][0-9]{0,24}$').test(value);
const text = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit;
const status = (value) => typeof value === 'string' && /^[A-Z_]{1,48}$/.test(value);
const invalid = [400, { error: 'invalid request' }];
const drift = [502, { error: 'unexpected Shopify response' }];

function project(order) {
  if (!gid(order?.id, 'Order') || !text(order.name, 100) ||
    !status(order.displayFinancialStatus) || !status(order.displayFulfillmentStatus)) return null;
  return { id: order.id, name: order.name, financialStatus: order.displayFinancialStatus,
    fulfillmentStatus: order.displayFulfillmentStatus };
}

export function shopifyProvider(config) {
  if (typeof config.shop !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.shop)) throw new Error('invalid Shopify shop');
  const base = 'https://' + config.shop + '.myshopify.com';
  return {
    name: 'shopify', mode: 'client_credentials', clientId: config.clientId, clientSecret: config.clientSecret,
    tokenUrl: base + '/admin/oauth/access_token',
    routes(token, fetchImpl) {
      async function query(document, variables) {
        const { accessToken } = await token();
        const r = await fetchImpl(base + '/admin/api/' + VERSION + '/graphql.json', { method: 'POST', redirect: 'manual',
          headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': accessToken },
          body: JSON.stringify({ query: document, variables }), signal: AbortSignal.timeout(4500) });
        if (!r.ok) throw new Error('Shopify request failed');
        const result = await r.json();
        if (result?.errors?.length || !result?.data) throw new Error('Shopify GraphQL rejected the query');
        return result.data;
      }
      return {
        '/shopify/orders': async ({ limit, after }) => {
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || typeof after !== 'string' || after.length > 1024)
            return invalid;
          const { orders: page } = await query(ORDERS, { first: limit, after: after || null });
          const { nodes, pageInfo } = page || {};
          if (!Array.isArray(nodes) || nodes.length > limit || typeof pageInfo?.hasNextPage !== 'boolean' ||
            (pageInfo.hasNextPage && !text(pageInfo.endCursor, 1024))) return drift;
          const rows = nodes.map(project);
          return rows.includes(null) ? drift : [200, { rows, next: pageInfo.hasNextPage ? pageInfo.endCursor : '' }];
        },
        '/shopify/order': async ({ id }) => {
          if (!gid(id, 'Order')) return invalid;
          const { order } = await query(ORDER, { id });
          const projected = project(order);
          return projected?.id === id ? [200, projected] : drift;
        },
        '/shopify/inventory': async ({ itemId, locationId }) => {
          if (!gid(itemId, 'InventoryItem') || !gid(locationId, 'Location')) return invalid;
          const { inventoryItem } = await query(STOCK, { item: itemId, location: locationId });
          if (inventoryItem?.id !== itemId || !Array.isArray(inventoryItem.inventoryLevel?.quantities)) return drift;
          const matches = inventoryItem.inventoryLevel.quantities.filter((q) => q?.name === 'available');
          return matches.length === 1 && Number.isSafeInteger(matches[0].quantity)
            ? [200, { itemId, locationId, available: matches[0].quantity }] : drift;
        },
      };
    },
  };
}
