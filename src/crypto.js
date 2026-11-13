import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// One key protects the saved mailbox password and signs login cookies.
// It comes from APP_SECRET, or from a random key file created on first run.
export function loadKey({ appSecret, dataDir }) {
  if (appSecret) return crypto.createHash("sha256").update(appSecret).digest();
  const file = path.join(dataDir, "secret.key");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return crypto.createHash("sha256").update(fs.readFileSync(file, "utf8").trim()).digest();
}

export function encrypt(key, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(key, packed) {
  const [iv, tag, body] = String(packed).split(".").map((s) => Buffer.from(s, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export function signSession(key, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function readSession(key, token, now = Date.now()) {
  const [body, mac] = String(token || "").split(".");
  if (!body || !mac) return null;
  const expected = crypto.createHmac("sha256", key).update(body).digest("base64url");
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload.exp > now ? payload : null;
  } catch {
    return null;
  }
}
