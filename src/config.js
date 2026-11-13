import path from "node:path";

export const config = {
  port: Number(process.env.PORT || 3000),
  dataDir: path.resolve(process.env.DATA_DIR || "./data"),
  appSecret: process.env.APP_SECRET || "",
  model: process.env.CLAUDE_MODEL || "claude-opus-5-5",
  pollSeconds: Math.max(30, Number(process.env.POLL_SECONDS || 60)),
  shopifyDomain: (process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
  shopifyToken: process.env.SHOPIFY_ADMIN_TOKEN || "",
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION || "2026-07",
};

export function aiConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
