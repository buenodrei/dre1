import test from "node:test";
import assert from "node:assert/strict";
import { preclassify, extractOrderNumbers, stripQuoted } from "../src/detect.js";

const OWN = "support@store.com";
const base = { from: { address: "jo@example.com", name: "Jo" }, replyTo: null, subject: "Hi", text: "Do you ship worldwide?", headers: {} };

test("a plain email from a person is a candidate", () => {
  const r = preclassify(base, OWN);
  assert.equal(r.verdict, "candidate");
  assert.equal(r.customer.email, "jo@example.com");
});

test("Shopify contact form is recognised and the customer comes from Reply-To", () => {
  const r = preclassify({
    from: { address: "mailer@shopify.com", name: "DogCalm (Shopify)" },
    replyTo: { address: "Sam@Example.com", name: "" },
    subject: "New customer message on November 13, 2026 at 9:02 am",
    text: "You received a new message from your online store's contact form.\n\nCountry Code: US\nName: Sam Lee\nEmail: sam@example.com\nBody: Where is my order?\nIt has been two weeks.",
    headers: {},
  }, OWN);
  assert.equal(r.verdict, "contact_form");
  assert.equal(r.customer.email, "sam@example.com");
  assert.equal(r.customer.name, "Sam Lee");
  assert.equal(r.text, "Where is my order?\nIt has been two weeks.");
});

test("other Shopify notifications are skipped", () => {
  const r = preclassify({ ...base, from: { address: "mailer@shopify.com" }, subject: "[DogCalm] Order #1001 placed by Sam", text: "Order summary" }, OWN);
  assert.equal(r.verdict, "skip");
});

test("newsletters, auto-replies, no-reply senders and own mail are skipped", () => {
  assert.equal(preclassify({ ...base, headers: { "list-unsubscribe": "<mailto:x@y.com>" } }, OWN).verdict, "skip");
  assert.equal(preclassify({ ...base, headers: { "auto-submitted": "auto-replied" } }, OWN).verdict, "skip");
  assert.equal(preclassify({ ...base, from: { address: "no-reply@bank.com" } }, OWN).verdict, "skip");
  assert.equal(preclassify({ ...base, from: { address: "Support@Store.com" } }, OWN).verdict, "skip");
  assert.equal(preclassify({ ...base, headers: { "auto-submitted": "no" } }, OWN).verdict, "candidate");
});

test("order numbers are pulled from common phrasings only", () => {
  assert.deepEqual(extractOrderNumbers("Where is order #1042? Also order number 20553."), ["1042", "20553"]);
  assert.deepEqual(extractOrderNumbers("I paid $1042 in 2026 and live at 4410 Main St"), []);
});

test("quoted earlier messages are removed from replies", () => {
  assert.equal(stripQuoted("No thanks, still disputing.\n\nOn Fri, Nov 13, 2026 at 9:00 AM Store <s@store.com> wrote:\n> We can offer 50% off"), "No thanks, still disputing.");
});
