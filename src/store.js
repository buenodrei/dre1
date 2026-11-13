import fs from "node:fs";
import path from "node:path";

export const DEFAULT_POLICIES = `Shipping: yes, we ship worldwide.
Order status: when a customer asks where their order is, give them the status and tracking number from the order lookup.
Refunds and chargebacks: yes, we approve refunds. When a customer asks for a refund or mentions a chargeback or bank dispute: apologize for our mistake, ask what went wrong so we can fix it, and offer 50% off their next order if they choose not to go ahead with the chargeback. The 50% offer is only for customers who drop the chargeback. If they say they are going ahead with the chargeback anyway, or turn the offer down, do not offer or repeat the discount; confirm the refund is approved.`;

export function defaultState() {
  return {
    account: null,
    settings: {
      storeName: "DogCalm",
      storeUrl: "https://dogcalm.shop",
      tone: "warm, friendly and natural, like a real person on a small team",
      policies: DEFAULT_POLICIES,
      storeFacts: "",
      storeFactsAt: null,
      mode: "draft", // "draft" = you approve every reply, "auto" = safe replies send themselves
    },
    mailbox: { uidValidity: null, lastUid: null, lastCheck: null, lastError: null },
    tickets: [],
    ignored: [],
  };
}

// Small JSON-file store. One process, one inbox: a database would be overkill.
export class Store {
  constructor(dataDir) {
    this.file = dataDir ? path.join(dataDir, "state.json") : null;
    this.state = defaultState();
    if (this.file && fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.state = { ...this.state, ...saved, settings: { ...this.state.settings, ...saved.settings }, mailbox: { ...this.state.mailbox, ...saved.mailbox } };
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  addTicket(ticket) {
    this.state.tickets.unshift(ticket);
    this.state.tickets.length = Math.min(this.state.tickets.length, 500);
    this.save();
  }

  addIgnored(entry) {
    this.state.ignored.unshift(entry);
    this.state.ignored.length = Math.min(this.state.ignored.length, 100);
    this.save();
  }

  hasMessage(messageId) {
    if (!messageId) return false;
    return this.state.tickets.some((t) => t.messageId === messageId) || this.state.ignored.some((i) => i.messageId === messageId);
  }
}
