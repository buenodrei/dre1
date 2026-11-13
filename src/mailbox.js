import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";

const MAX_PER_CHECK = 25;

function imapClient(account, password) {
  return new ImapFlow({
    host: account.imap.host, port: account.imap.port, secure: account.imap.secure,
    auth: { user: account.email, pass: password },
    logger: false, socketTimeout: 60000,
  });
}

function smtpTransport(account, password) {
  return nodemailer.createTransport({
    host: account.smtp.host, port: account.smtp.port, secure: account.smtp.secure,
    auth: { user: account.email, pass: password },
    connectionTimeout: 20000, socketTimeout: 30000,
  });
}

// Turns provider errors into something the login screen can show.
export function friendlyMailError(err) {
  const msg = String(err?.responseText || err?.response || err?.message || err);
  if (err?.authenticationFailed || /auth|credential|password|535|AUTHENTICATIONFAILED/i.test(msg)) {
    return "Your email provider rejected that login. Check the address and use an app password, not your normal password.";
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout|EAI_AGAIN|ENETUNREACH/i.test(msg + (err?.code || ""))) {
    return "Couldn't reach your email provider. Check the server names, then try again.";
  }
  return "Couldn't log in to that mailbox: " + msg.slice(0, 160);
}

/** Proves the login works for both reading (IMAP) and sending (SMTP). */
export async function verifyLogin(account, password) {
  const client = imapClient(account, password);
  await client.connect();
  await client.logout();
  await smtpTransport(account, password).verify();
}

function normalize(parsed, uid) {
  const headers = {};
  for (const name of ["auto-submitted", "precedence", "list-unsubscribe", "list-id", "x-autoreply", "x-autorespond"]) {
    const v = parsed.headers.get(name);
    if (v) headers[name] = typeof v === "string" ? v : JSON.stringify(v);
  }
  const text = parsed.text || String(parsed.html || "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
  const refs = parsed.references ? [].concat(parsed.references) : [];
  return {
    uid,
    messageId: parsed.messageId || `uid-${uid}`,
    references: refs.slice(-10),
    from: parsed.from?.value?.[0] || null,
    replyTo: parsed.replyTo?.value?.[0] || null,
    subject: parsed.subject || "",
    text,
    date: (parsed.date || new Date()).toISOString(),
    headers,
  };
}

/**
 * Returns emails that arrived since the last check. The very first check only
 * records where the inbox ends, so nothing already in the inbox gets a reply.
 */
export async function fetchNew(account, password, cursor) {
  const client = imapClient(account, password);
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const validity = String(client.mailbox.uidValidity);
    const newest = Number(client.mailbox.uidNext) - 1;
    if (cursor.lastUid == null || cursor.uidValidity !== validity) {
      return { messages: [], cursor: { uidValidity: validity, lastUid: newest } };
    }
    if (newest <= cursor.lastUid) return { messages: [], cursor };
    const messages = [];
    let lastUid = cursor.lastUid;
    for await (const item of client.fetch(`${cursor.lastUid + 1}:*`, { uid: true, source: { start: 0, maxLength: 1024 * 1024 } }, { uid: true })) {
      if (item.uid <= cursor.lastUid) continue;
      if (messages.length >= MAX_PER_CHECK) break;
      messages.push(normalize(await simpleParser(item.source), item.uid));
      lastUid = Math.max(lastUid, item.uid);
    }
    return { messages, cursor: { uidValidity: validity, lastUid } };
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

export async function sendReply(account, password, { fromName, to, subject, text, inReplyTo, references }) {
  const info = await smtpTransport(account, password).sendMail({
    from: { name: fromName, address: account.email },
    to,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    text,
    inReplyTo: inReplyTo && !inReplyTo.startsWith("uid-") ? inReplyTo : undefined,
    references: references?.length ? references : undefined,
  });
  return info.messageId;
}
