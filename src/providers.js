// Mail server settings for the providers the login screen offers.
export const PROVIDERS = {
  gmail: {
    label: "Gmail", domains: ["gmail.com", "googlemail.com"],
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    help: "Gmail needs an app password (turn on 2-Step Verification first).",
    helpUrl: "https://myaccount.google.com/apppasswords",
  },
  yahoo: {
    label: "Yahoo", domains: ["yahoo.com", "ymail.com", "rocketmail.com"],
    imap: { host: "imap.mail.yahoo.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.yahoo.com", port: 465, secure: true },
    help: "Yahoo needs an app password: Account security, then Generate app password.",
    helpUrl: "https://login.yahoo.com/account/security",
  },
  icloud: {
    label: "iCloud", domains: ["icloud.com", "me.com", "mac.com"],
    imap: { host: "imap.mail.me.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
    help: "iCloud needs an app-specific password from your Apple Account page.",
    helpUrl: "https://account.apple.com/account/manage",
  },
  aol: {
    label: "AOL", domains: ["aol.com"],
    imap: { host: "imap.aol.com", port: 993, secure: true },
    smtp: { host: "smtp.aol.com", port: 465, secure: true },
    help: "AOL needs an app password: Account security, then Generate app password.",
    helpUrl: "https://login.aol.com/account/security",
  },
  other: {
    label: "Other", domains: [],
    help: "Enter the IMAP and SMTP servers from your email provider's help page.",
    helpUrl: "",
  },
};

export function providerForEmail(email) {
  const domain = String(email).split("@")[1]?.toLowerCase() || "";
  return Object.keys(PROVIDERS).find((k) => PROVIDERS[k].domains.includes(domain)) || null;
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

// Turns the login form into the server settings stored for the account.
export function resolveServers(provider, custom = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error("Pick your email provider.");
  if (provider !== "other") return { imap: p.imap, smtp: p.smtp };
  const imapHost = String(custom.imapHost || "").trim();
  const smtpHost = String(custom.smtpHost || "").trim();
  if (!HOST_RE.test(imapHost) || !HOST_RE.test(smtpHost)) {
    throw new Error("Enter your provider's IMAP and SMTP server names, like imap.example.com.");
  }
  const smtpPort = Number(custom.smtpPort) === 587 ? 587 : 465;
  return {
    imap: { host: imapHost, port: 993, secure: true },
    smtp: { host: smtpHost, port: smtpPort, secure: smtpPort === 465 },
  };
}
