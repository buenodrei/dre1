import { config } from "./config.js";

export function shopifyConfigured() {
  return Boolean(config.shopifyDomain && config.shopifyToken);
}

const ORDER_FIELDS = `
  name email createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus
  totalPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: 10) { nodes { title quantity variantTitle } }
  fulfillments { status createdAt estimatedDeliveryAt trackingInfo { company number url } }
  shippingAddress { city countryCodeV2 }`;

async function admin(query, variables) {
  const res = await fetch(`https://${config.shopifyDomain}/admin/api/${config.shopifyApiVersion}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": config.shopifyToken },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Shopify answered ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message || "Shopify query failed");
  return json.data;
}

function day(iso) {
  return iso ? new Date(iso).toISOString().slice(0, 10) : "";
}

export function formatOrder(o) {
  const items = o.lineItems.nodes.map((i) => `${i.title}${i.variantTitle ? ` (${i.variantTitle})` : ""} x ${i.quantity}`).join("; ");
  const lines = [
    `Order ${o.name}, placed ${day(o.createdAt)}`,
    `Items: ${items}`,
    `Total: ${o.totalPriceSet.shopMoney.amount} ${o.totalPriceSet.shopMoney.currencyCode}`,
    `Payment: ${o.displayFinancialStatus}. Fulfillment: ${o.displayFulfillmentStatus}.${o.cancelledAt ? ` Cancelled ${day(o.cancelledAt)}.` : ""}`,
  ];
  if (o.shippingAddress) lines.push(`Ships to: ${[o.shippingAddress.city, o.shippingAddress.countryCodeV2].filter(Boolean).join(", ")}`);
  const tracks = o.fulfillments.flatMap((f) => f.trackingInfo.map((t) => ({ ...t, shipped: f.createdAt, eta: f.estimatedDeliveryAt })));
  if (!tracks.length) lines.push("Tracking: none yet");
  for (const t of tracks) {
    lines.push(`Tracking: ${[t.company, t.number].filter(Boolean).join(" ")}${t.url ? ` (${t.url})` : ""}, shipped ${day(t.shipped)}${t.eta ? `, estimated delivery ${day(t.eta)}` : ""}`);
  }
  return lines.join("\n");
}

/**
 * Finds the sender's orders. An order is only shared when it was placed with
 * the same email address that is writing in, so nobody can pull up someone
 * else's order by guessing a number.
 */
export async function lookupCustomer({ email, orderNumbers = [] }, run = admin) {
  if (!shopifyConfigured() && run === admin) {
    return { available: false, isCustomer: false, text: "Order lookup is not connected, so no order information is available." };
  }
  const q = `query($q: String!) { orders(first: 3, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } } }`;
  const byEmail = (await run(q, { q: `email:${JSON.stringify(email)}` })).orders.nodes
    .filter((o) => (o.email || "").toLowerCase() === email.toLowerCase());
  const orders = [...byEmail];
  const notes = [];
  for (const num of orderNumbers) {
    if (orders.some((o) => o.name.replace(/\D/g, "") === num)) continue;
    const hit = (await run(q, { q: `name:${JSON.stringify("#" + num)}` })).orders.nodes.find((o) => o.name.replace(/\D/g, "") === num);
    if (!hit) notes.push(`No order #${num} was found.`);
    else if ((hit.email || "").toLowerCase() === email.toLowerCase()) orders.unshift(hit);
    else notes.push(`Order #${num} exists but was placed with a different email address, so its details must not be shared. Ask the customer to write from the email they used at checkout.`);
  }
  const text = [
    orders.length ? orders.slice(0, 3).map(formatOrder).join("\n\n") : "No orders found for this email address.",
    ...notes,
  ].join("\n");
  return { available: true, isCustomer: orders.length > 0, text };
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h\d|tr)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

export function storeOrigin(url) {
  const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  if (u.protocol !== "https:" || !/\.[a-z]{2,}$/i.test(u.hostname)) throw new Error("Enter your store's web address, like https://yourstore.com");
  return u.origin;
}

/**
 * Reads the public pages every Shopify store has (product list and policies)
 * so the assistant knows what the store sells. Nothing here needs a password.
 */
export async function readStoreFacts(url, fetcher = fetch) {
  const origin = storeOrigin(url);
  const get = async (path) => {
    const res = await fetcher(origin + path, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "Mozilla/5.0 (store-assistant)" } });
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return res;
  };
  const parts = [];
  const { products = [] } = await (await get("/products.json?limit=30")).json();
  for (const p of products) {
    const prices = [...new Set(p.variants.map((v) => v.price))];
    const variants = p.variants.map((v) => v.title).filter((t) => t && t !== "Default Title");
    const about = htmlToText(p.body_html);
    parts.push([
      `Product: ${p.title}`,
      `Link: ${origin}/products/${p.handle}`,
      `Price: ${prices.join(" / ")}`,
      variants.length ? `Options: ${variants.join(", ")}` : "",
      about ? `About: ${about.length > 1500 ? about.slice(0, 1500) + " [description shortened]" : about}` : "",
    ].filter(Boolean).join("\n"));
  }
  for (const [label, path] of [["Shipping policy", "/policies/shipping-policy"], ["Refund policy", "/policies/refund-policy"]]) {
    try {
      const html = await (await get(path)).text();
      const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] || html;
      const text = htmlToText(main);
      if (text) parts.push(`${label} on the website:\n${text.length > 4000 ? text.slice(0, 4000) + " [shortened]" : text}`);
    } catch {
      // A store without this policy page is fine.
    }
  }
  if (!parts.length) throw new Error("No products or policies were found at that address.");
  return parts.join("\n\n");
}
