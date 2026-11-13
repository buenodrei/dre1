import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Autopilot } from "../src/worker.js";
import { lookupCustomer, formatOrder } from "../src/shopify.js";
import { loadKey, encrypt, decrypt, signSession, readSession } from "../src/crypto.js";

function setup({ mode = "draft", draft, lookup } = {}) {
  const store = new Store(null);
  store.state.account = { email: "support@store.com" };
  store.state.settings.mode = mode;
  const sent = [];
  const pilot = new Autopilot({
    store,
    mail: { sendReply: async (_a, _p, m) => { sent.push(m); }, friendlyMailError: (e) => String(e.message) },
    shopify: { lookupCustomer: async () => lookup || { available: true, isCustomer: false, text: "No orders found for this email address." } },
    ai: { draftReply: async (input) => (typeof draft === "function" ? draft(input) : draft), friendlyAiError: (e) => "AI failed: " + e.message },
    getPassword: () => "pw",
    log: { error() {} },
  });
  return { store, pilot, sent };
}

let n = 0;
const email = (over = {}) => ({ messageId: `<m${++n}@x>`, references: [], from: { address: "jo@example.com", name: "Jo" }, replyTo: null, subject: "Question", text: "Do you ship worldwide?", date: new Date().toISOString(), headers: {}, ...over });
const yes = { is_customer_email: true, category: "Shipping", action: "send", reason: "Covered by policy.", owner_action: "", reply: "Yes, we ship worldwide." };

test("draft mode: a customer email waits for approval and nothing is sent", async () => {
  const { store, pilot, sent } = setup({ draft: yes });
  await pilot.processMessage(email());
  assert.equal(sent.length, 0);
  assert.equal(store.state.tickets[0].status, "waiting");
  assert.equal(store.state.tickets[0].reply, "Yes, we ship worldwide.");
});

test("auto mode: a safe reply is sent, threaded to the original email", async () => {
  const { store, pilot, sent } = setup({ mode: "auto", draft: yes });
  const msg = email();
  await pilot.processMessage(msg);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "jo@example.com");
  assert.equal(sent[0].inReplyTo, msg.messageId);
  assert.equal(store.state.tickets[0].status, "sent");
  assert.equal(store.state.tickets[0].auto, true);
});

test("auto mode: a reply the AI marks hold is not sent", async () => {
  const { store, pilot, sent } = setup({ mode: "auto", draft: { ...yes, action: "hold", category: "Wholesale" } });
  await pilot.processMessage(email());
  assert.equal(sent.length, 0);
  assert.equal(store.state.tickets[0].status, "waiting");
});

test("email that is not about the store is ignored, never answered", async () => {
  const { store, pilot, sent } = setup({ mode: "auto", draft: { ...yes, is_customer_email: false, reply: "" } });
  await pilot.processMessage(email({ subject: "Lunch on Friday?" }));
  await pilot.processMessage(email({ from: { address: "news@brand.com" }, headers: { "list-id": "x" } }));
  assert.equal(sent.length, 0);
  assert.equal(store.state.tickets.length, 0);
  assert.equal(store.state.ignored.length, 2);
});

test("a known Shopify customer is kept even if the AI is unsure", async () => {
  const { store, pilot } = setup({ draft: { ...yes, is_customer_email: false }, lookup: { available: true, isCustomer: true, text: "Order #1001" } });
  await pilot.processMessage(email());
  assert.equal(store.state.tickets.length, 1);
});

test("the same email is never processed twice", async () => {
  const { store, pilot, sent } = setup({ mode: "auto", draft: yes });
  const msg = email();
  await pilot.processMessage(msg);
  await pilot.processMessage(msg);
  assert.equal(sent.length, 1);
  assert.equal(store.state.tickets.length, 1);
});

test("auto-replies to one customer are capped per day", async () => {
  const { store, pilot, sent } = setup({ mode: "auto", draft: yes });
  for (let i = 0; i < 6; i++) await pilot.processMessage(email());
  assert.equal(sent.length, 4);
  assert.equal(store.state.tickets[0].status, "waiting");
});

test("the AI sees earlier messages and our sent replies for the same customer", async () => {
  let seen;
  const { pilot } = setup({ mode: "auto", draft: (input) => { seen = input.history; return yes; } });
  await pilot.processMessage(email({ text: "I want a refund or I'll do a chargeback" }));
  await pilot.processMessage(email({ text: "No thanks, going ahead with the chargeback" }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, "I want a refund or I'll do a chargeback");
  assert.equal(seen[0].sentReply, "Yes, we ship worldwide.");
});

test("AI failure keeps the email visible with an error; approve sends an edited reply", async () => {
  const { store, pilot, sent } = setup({ draft: () => { throw new Error("down"); } });
  await pilot.processMessage(email());
  const t = store.state.tickets[0];
  assert.equal(t.status, "error");
  await pilot.approve(t.id, "Hi Jo, yes we do!");
  assert.equal(sent[0].text, "Hi Jo, yes we do!");
  assert.equal(t.status, "sent");
  await assert.rejects(() => pilot.approve(t.id, "again"), /already sent/);
});

const order = (name, mail) => ({
  name, email: mail, createdAt: "2026-11-01T10:00:00Z", cancelledAt: null, displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED",
  totalPriceSet: { shopMoney: { amount: "29.99", currencyCode: "USD" } }, lineItems: { nodes: [{ title: "Dog Calming Collar", quantity: 1, variantTitle: "Large" }] },
  fulfillments: [{ status: "SUCCESS", createdAt: "2026-11-02T10:00:00Z", estimatedDeliveryAt: null, trackingInfo: [{ company: "USPS", number: "9400", url: "https://t.example/9400" }] }],
  shippingAddress: { city: "Austin", countryCodeV2: "US" },
});

test("order lookup shares only orders placed with the sender's own email", async () => {
  const run = async (_q, { q }) => ({ orders: { nodes: q.startsWith("email:") ? [order("#1001", "jo@example.com")] : [order("#2002", "someone.else@example.com")] } });
  const r = await lookupCustomer({ email: "Jo@example.com", orderNumbers: ["2002"] }, run);
  assert.equal(r.isCustomer, true);
  assert.match(r.text, /Order #1001/);
  assert.match(r.text, /USPS 9400/);
  assert.match(r.text, /#2002 exists but was placed with a different email/);
  assert.doesNotMatch(r.text, /Order #2002, placed/);
});

test("order text includes items and tracking", () => {
  assert.match(formatOrder(order("#1001", "a@b.c")), /Dog Calming Collar \(Large\) x 1/);
});

test("password encryption round-trips and sessions expire or reject tampering", () => {
  const key = loadKey({ appSecret: "test-secret", dataDir: "/nonexistent" });
  assert.equal(decrypt(key, encrypt(key, "abcd efgh")), "abcd efgh");
  const token = signSession(key, { email: "a@b.c", exp: Date.now() + 1000 });
  assert.equal(readSession(key, token).email, "a@b.c");
  assert.equal(readSession(key, token, Date.now() + 5000), null);
  assert.equal(readSession(key, token.slice(0, -2) + "xx"), null);
});
