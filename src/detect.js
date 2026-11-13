// Decides, before any AI is involved, whether an incoming email could be a
// Shopify customer writing in. Pure functions so they are easy to test.

const AUTOMATED_SENDER = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|newsletter|news|marketing|updates?|alerts?|billing|receipts?)([+._-]|$)/i;
const SHOPIFY_DOMAINS = /(^|\.)(shopify\.com|shopifyemail\.com|myshopify\.com)$/i;
const MAX_TEXT = 8000;

function lower(v) {
  return String(v || "").trim().toLowerCase();
}

// Removes the quoted earlier messages from a reply so the AI reads only what is new.
export function stripQuoted(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (const line of lines) {
    if (/^On .{5,200} wrote:\s*$/.test(line) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^_{10,}$/.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function clip(text) {
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "\n[email cut off here because it was very long]" : text;
}

// Shopify's store contact form arrives from Shopify's mailer with the customer in Reply-To.
function parseContactForm(text) {
  const t = String(text || "").replace(/\r\n/g, "\n");
  const field = (name) => t.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, "im"))?.[1]?.trim() || "";
  const bodyMatch = t.match(/^\s*(?:Body|Message|Comment):\s*([\s\S]*)$/im);
  return { name: field("Name"), email: lower(field("Email")), body: (bodyMatch ? bodyMatch[1] : t).trim() };
}

export function extractOrderNumbers(text) {
  const found = new Set();
  const re = /(?:#\s?|\border\s*(?:number|num|no\.?|id)?\s*[:#]?\s*)(\d{3,8})\b/gi;
  let m;
  while ((m = re.exec(String(text || "")))) found.add(m[1]);
  return [...found].slice(0, 3);
}

/**
 * msg: { from:{address,name}, replyTo:{address,name}|null, subject, text, headers:{} }
 * Returns { verdict: "skip" | "contact_form" | "candidate", reason, customer, subject, text }
 */
export function preclassify(msg, ownEmail) {
  const from = lower(msg.from?.address);
  const own = lower(ownEmail);
  const subject = String(msg.subject || "").trim();
  const headers = msg.headers || {};
  const skip = (reason) => ({ verdict: "skip", reason, customer: { email: from, name: msg.from?.name || "" }, subject, text: "" });

  if (!from) return skip("No sender address");
  if (from === own) return skip("Sent from your own address");

  const fromDomain = from.split("@")[1] || "";
  if (SHOPIFY_DOMAINS.test(fromDomain)) {
    const replyTo = lower(msg.replyTo?.address);
    const looksLikeForm = /new customer message|contact form/i.test(subject + "\n" + String(msg.text || "").slice(0, 600));
    if (looksLikeForm && replyTo && replyTo !== own && !SHOPIFY_DOMAINS.test(replyTo.split("@")[1] || "")) {
      const form = parseContactForm(msg.text);
      return {
        verdict: "contact_form",
        reason: "Sent through your Shopify store's contact form",
        customer: { email: replyTo, name: form.name || msg.replyTo?.name || "" },
        subject: subject || "Message from your store",
        text: clip(form.body),
      };
    }
    return skip("Shopify notification, not a customer message");
  }

  const auto = lower(headers["auto-submitted"]);
  if (auto && auto !== "no") return skip("Automatic email");
  if (/bulk|list|junk/.test(lower(headers["precedence"]))) return skip("Bulk email");
  if (headers["list-unsubscribe"] || headers["list-id"]) return skip("Newsletter or mailing list");
  if (headers["x-autoreply"] || headers["x-autorespond"]) return skip("Auto-reply");
  if (AUTOMATED_SENDER.test(from.split("@")[0])) return skip("Automated sender");

  const text = clip(stripQuoted(msg.text));
  if (!text && !subject) return skip("Empty email");
  return { verdict: "candidate", reason: "", customer: { email: from, name: msg.from?.name || "" }, subject, text };
}
