import crypto from "node:crypto";
import { preclassify, extractOrderNumbers } from "./detect.js";

const MAX_AUTO_PER_CUSTOMER_PER_DAY = 4;
const DAY = 24 * 60 * 60 * 1000;

/**
 * The loop that does the job: check the inbox, keep only Shopify customer
 * emails, look up the order, have the AI write a reply, then send it or hold
 * it for approval. Mail, Shopify and AI are passed in so tests can fake them.
 */
export class Autopilot {
  constructor({ store, mail, shopify, ai, getPassword, pollSeconds = 60, log = console }) {
    Object.assign(this, { store, mail, shopify, ai, getPassword, pollSeconds, log });
    this.timer = null;
    this.busy = false;
  }

  start() {
    this.stop();
    if (!this.store.state.account) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), this.pollSeconds * 1000);
    this.tick().catch(() => {});
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    const { state } = this.store;
    if (this.busy || !state.account) return;
    this.busy = true;
    try {
      const { messages, cursor } = await this.mail.fetchNew(state.account, this.getPassword(), state.mailbox);
      // Save the position first: if a later step crashes we skip an email rather than answer it twice.
      state.mailbox = { ...state.mailbox, ...cursor, lastCheck: new Date().toISOString(), lastError: null };
      this.store.save();
      for (const msg of messages) {
        try {
          await this.processMessage(msg);
        } catch (err) {
          this.log.error("Failed on one email:", err?.message || err);
        }
      }
    } catch (err) {
      state.mailbox.lastCheck = new Date().toISOString();
      state.mailbox.lastError = this.mail.friendlyMailError(err);
      this.store.save();
    } finally {
      this.busy = false;
    }
  }

  history(email, beforeId) {
    return this.store.state.tickets
      .filter((t) => t.customer.email === email && t.id !== beforeId)
      .slice(0, 5)
      .reverse()
      .map((t) => ({ receivedAt: t.receivedAt, text: t.text, sentReply: t.status === "sent" ? t.reply : "" }));
  }

  autoSentRecently(email) {
    const since = Date.now() - DAY;
    return this.store.state.tickets.filter((t) => t.customer.email === email && t.auto && t.status === "sent" && Date.parse(t.sentAt) > since).length;
  }

  async think(ticket, knownCustomer) {
    const { state } = this.store;
    let lookup;
    try {
      lookup = await this.shopify.lookupCustomer({ email: ticket.customer.email, orderNumbers: extractOrderNumbers(`${ticket.subject}\n${ticket.text}`) });
    } catch (err) {
      lookup = { available: false, isCustomer: false, text: `Order lookup failed (${String(err?.message || err).slice(0, 120)}), so no order information is available.` };
    }
    const known = knownCustomer || lookup.isCustomer;
    const draft = await this.ai.draftReply({ settings: state.settings, ticket, history: this.history(ticket.customer.email, ticket.id), lookupText: lookup.text, knownCustomer: known });
    return { lookup, known, draft };
  }

  async processMessage(msg) {
    const { state } = this.store;
    if (this.store.hasMessage(msg.messageId)) return;
    const pre = preclassify(msg, state.account.email);
    const ignore = (reason) => this.store.addIgnored({ messageId: msg.messageId, from: pre.customer.email, subject: pre.subject, reason, at: msg.date });
    if (pre.verdict === "skip") return ignore(pre.reason);

    const ticket = {
      id: crypto.randomUUID(), messageId: msg.messageId, references: [...(msg.references || []), msg.messageId].filter((r) => !r.startsWith("uid-")),
      customer: pre.customer, subject: pre.subject || "(no subject)", text: pre.text, receivedAt: msg.date,
      source: pre.verdict === "contact_form" ? "Shopify contact form" : "Email",
      lookupText: "", category: "Other", action: "hold", reason: "", ownerAction: "", ownerActionDone: false,
      reply: "", status: "waiting", auto: false, sentAt: null, error: null,
    };

    let result;
    try {
      result = await this.think(ticket, pre.verdict === "contact_form");
    } catch (err) {
      // Without the AI we cannot tell whether a plain email is about the store, so keep it visible.
      ticket.status = "error";
      ticket.error = this.ai.friendlyAiError(err);
      return this.store.addTicket(ticket);
    }
    if (!result.known && !result.draft.is_customer_email) return ignore("Not about your Shopify store");
    this.applyDraft(ticket, result);

    const mayAuto = state.settings.mode === "auto" && ticket.action === "send" && ticket.reply;
    if (mayAuto && this.autoSentRecently(ticket.customer.email) >= MAX_AUTO_PER_CUSTOMER_PER_DAY) {
      ticket.action = "hold";
      ticket.reason = `Already auto-replied to this customer ${MAX_AUTO_PER_CUSTOMER_PER_DAY} times today, so this one waits for you.`;
    } else if (mayAuto) {
      try {
        await this.deliver(ticket);
        ticket.auto = true;
      } catch (err) {
        ticket.error = this.mail.friendlyMailError(err);
      }
    }
    this.store.addTicket(ticket);
  }

  applyDraft(ticket, { lookup, draft }) {
    Object.assign(ticket, {
      lookupText: lookup.text, category: draft.category === "Not a customer email" ? "Other" : draft.category,
      action: draft.reply ? draft.action : "hold", reason: draft.reason, ownerAction: draft.owner_action, ownerActionDone: false,
      reply: draft.reply, error: null,
    });
  }

  async deliver(ticket) {
    const { state } = this.store;
    await this.mail.sendReply(state.account, this.getPassword(), {
      fromName: state.settings.storeName, to: ticket.customer.email, subject: ticket.subject,
      text: ticket.reply, inReplyTo: ticket.messageId, references: ticket.references,
    });
    ticket.status = "sent";
    ticket.sentAt = new Date().toISOString();
    ticket.error = null;
  }

  find(id) {
    const ticket = this.store.state.tickets.find((t) => t.id === id);
    if (!ticket) throw Object.assign(new Error("That email is no longer in the list."), { status: 404 });
    return ticket;
  }

  /** Owner approved a reply (possibly edited). */
  async approve(id, text) {
    const ticket = this.find(id);
    if (ticket.status === "sent") throw Object.assign(new Error("This reply was already sent."), { status: 409 });
    const reply = String(text ?? ticket.reply).trim();
    if (!reply) throw Object.assign(new Error("Write a reply before sending."), { status: 400 });
    ticket.reply = reply.slice(0, 10000);
    try {
      await this.deliver(ticket);
    } catch (err) {
      throw Object.assign(new Error(this.mail.friendlyMailError(err)), { status: 502 });
    } finally {
      this.store.save();
    }
    return ticket;
  }

  async redraft(id) {
    const ticket = this.find(id);
    if (ticket.status === "sent") throw Object.assign(new Error("This reply was already sent."), { status: 409 });
    try {
      this.applyDraft(ticket, await this.think(ticket, true));
      ticket.status = "waiting";
    } catch (err) {
      ticket.status = "error";
      ticket.error = this.ai.friendlyAiError(err);
    }
    this.store.save();
    return ticket;
  }

  update(id, patch) {
    const ticket = this.find(id);
    if (patch.skip && ticket.status !== "sent") ticket.status = "skipped";
    if (typeof patch.ownerActionDone === "boolean") ticket.ownerActionDone = patch.ownerActionDone;
    this.store.save();
    return ticket;
  }
}
