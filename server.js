import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, aiConfigured } from "./src/config.js";
import { loadKey, encrypt, decrypt, signSession, readSession } from "./src/crypto.js";
import { Store } from "./src/store.js";
import { PROVIDERS, resolveServers } from "./src/providers.js";
import * as mail from "./src/mailbox.js";
import { lookupCustomer, shopifyConfigured, readStoreFacts, storeOrigin } from "./src/shopify.js";
import { draftReply, friendlyAiError } from "./src/assistant.js";
import { Autopilot } from "./src/worker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const store = new Store(config.dataDir);
const key = loadKey(config);
const pilot = new Autopilot({
  store, mail, shopify: { lookupCustomer }, ai: { draftReply, friendlyAiError },
  getPassword: () => decrypt(key, store.state.account.passEnc),
  pollSeconds: config.pollSeconds,
});

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(here, "public"), { extensions: ["html"] }));

const COOKIE = "autopilot_session";
const WEEK = 7 * 24 * 60 * 60 * 1000;

function session(req) {
  const raw = (req.headers.cookie || "").split(";").map((c) => c.trim()).find((c) => c.startsWith(COOKIE + "="));
  const payload = raw && readSession(key, decodeURIComponent(raw.slice(COOKIE.length + 1)));
  // A session only counts while the inbox it was created for is still the connected one.
  return payload && store.state.account?.email === payload.email ? payload : null;
}

function setCookie(req, res, value, maxAgeMs) {
  const secure = req.secure ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`);
}

function requireLogin(req, res, next) {
  if (!session(req)) return res.status(401).json({ error: "Log in first." });
  next();
}

const providerList = Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, domains: p.domains, help: p.help, helpUrl: p.helpUrl }));

function publicState() {
  const { account, settings, mailbox, tickets, ignored } = store.state;
  return {
    loggedIn: true,
    email: account.email,
    settings,
    lastCheck: mailbox.lastCheck,
    lastError: mailbox.lastError,
    aiReady: aiConfigured(),
    shopifyReady: shopifyConfigured(),
    tickets: tickets.slice(0, 150).map(({ messageId, references, ...t }) => t),
    ignored: ignored.slice(0, 40).map(({ messageId, ...i }) => i),
  };
}

app.get("/api/state", (req, res) => {
  if (!session(req)) return res.json({ loggedIn: false, providers: providerList, inUse: Boolean(store.state.account) });
  res.json(publicState());
});

// Slow down password guessing: a handful of attempts per address every ten minutes.
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  recent.push(now);
  attempts.set(ip, recent);
  return recent.length > 8;
}

app.post("/api/login", async (req, res) => {
  if (tooManyAttempts(req.ip)) return res.status(429).json({ error: "Too many login attempts. Wait ten minutes, then try again." });
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "").replace(/\s+/g, ""); // app passwords are often shown with spaces
  const provider = String(req.body?.provider || "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !password) return res.status(400).json({ error: "Enter your email address and app password." });
  const current = store.state.account;
  if (current && current.email !== email) {
    return res.status(403).json({ error: "This app is already connected to a different inbox. Log in with that address, then disconnect it to switch." });
  }
  let servers;
  try {
    servers = current ? { imap: current.imap, smtp: current.smtp } : resolveServers(provider, req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const account = { email, provider: current?.provider || provider, ...servers };
  try {
    await mail.verifyLogin(account, password);
  } catch (err) {
    return res.status(401).json({ error: mail.friendlyMailError(err) });
  }
  store.state.account = { ...account, passEnc: encrypt(key, password), connectedAt: current?.connectedAt || new Date().toISOString() };
  store.save();
  setCookie(req, res, signSession(key, { email, exp: Date.now() + WEEK }), WEEK);
  pilot.start();
  if (!store.state.settings.storeFacts) refreshStoreFacts().catch(() => {});
  res.json(publicState());
});

app.post("/api/logout", (req, res) => {
  setCookie(req, res, "", 0);
  res.json({ ok: true });
});

app.post("/api/disconnect", requireLogin, (req, res) => {
  pilot.stop();
  store.state.account = null;
  store.state.mailbox = { uidValidity: null, lastUid: null, lastCheck: null, lastError: null };
  store.save();
  setCookie(req, res, "", 0);
  res.json({ ok: true });
});

async function refreshStoreFacts() {
  const s = store.state.settings;
  s.storeFacts = await readStoreFacts(s.storeUrl);
  s.storeFactsAt = new Date().toISOString();
  store.save();
}

app.post("/api/settings", requireLogin, (req, res) => {
  const b = req.body || {};
  const s = store.state.settings;
  const text = (v, max) => String(v).slice(0, max);
  if (typeof b.storeName === "string") s.storeName = text(b.storeName.trim(), 80) || s.storeName;
  if (typeof b.tone === "string") s.tone = text(b.tone.trim(), 200) || s.tone;
  if (typeof b.policies === "string") s.policies = text(b.policies, 12000);
  if (typeof b.storeFacts === "string") s.storeFacts = text(b.storeFacts, 60000);
  if (b.mode === "auto" || b.mode === "draft") s.mode = b.mode;
  if (typeof b.storeUrl === "string" && b.storeUrl.trim()) {
    try {
      s.storeUrl = storeOrigin(b.storeUrl.trim());
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  store.save();
  res.json(publicState());
});

app.post("/api/store/read", requireLogin, async (req, res) => {
  try {
    await refreshStoreFacts();
    res.json(publicState());
  } catch (err) {
    res.status(502).json({ error: "Couldn't read your store's website: " + String(err.message).slice(0, 160) });
  }
});

app.post("/api/check", requireLogin, async (req, res) => {
  await pilot.tick();
  res.json(publicState());
});

const ticketRoute = (fn) => async (req, res) => {
  try {
    await fn(req);
    res.json(publicState());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : "Something went wrong. Try again." });
    if (!err.status) console.error(err);
  }
};
app.post("/api/tickets/:id/send", requireLogin, ticketRoute((req) => pilot.approve(req.params.id, req.body?.reply)));
app.post("/api/tickets/:id/redraft", requireLogin, ticketRoute((req) => pilot.redraft(req.params.id)));
app.post("/api/tickets/:id", requireLogin, ticketRoute((req) => pilot.update(req.params.id, req.body || {})));

app.listen(config.port, () => {
  console.log(`Support Autopilot is running on http://localhost:${config.port}`);
  if (!aiConfigured()) console.log("Note: ANTHROPIC_API_KEY is not set, so replies can't be written yet.");
  if (!shopifyConfigured()) console.log("Note: Shopify order lookup is not connected (SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN).");
  pilot.start();
});
