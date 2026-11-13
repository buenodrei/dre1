const $ = (id) => document.getElementById(id);
let state = null;
let selected = null;
let provider = "gmail";
let settingsFilled = false;
const edits = new Map(); // reply text the owner is editing, kept across refreshes

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c != null) el.append(c);
  return el;
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") { state = { loggedIn: false, providers: state?.providers || [] }; render(); }
  if (!res.ok) throw new Error(json.error || "Something went wrong. Try again.");
  return json;
}

let toastTimer;
function toast(msg) {
  $("toast").textContent = msg; $("toast").hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $("toast").hidden = true; }, 3500);
}

// Runs a button's action with a busy state and shows any error as a toast.
async function act(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = label;
  try { state = await fn(); render(); } catch (err) { toast(err.message); } finally { btn.disabled = false; btn.textContent = old; }
}

function when(iso) {
  if (!iso) return "";
  const d = new Date(iso), today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/* ---------- login ---------- */
function renderLogin() {
  const box = $("providers");
  box.textContent = "";
  for (const p of state.providers) {
    box.append(h("button", { type: "button", "aria-pressed": String(p.id === provider), text: p.label, onclick: () => { provider = p.id; renderLogin(); } }));
  }
  const p = state.providers.find((x) => x.id === provider);
  const help = $("provHelp");
  help.textContent = (p?.help || "") + " ";
  if (p?.helpUrl) help.append(h("a", { href: p.helpUrl, target: "_blank", rel: "noopener", text: "Create one here" }));
  $("customHosts").hidden = provider !== "other";
}

$("lEmail").addEventListener("input", () => {
  const domain = $("lEmail").value.split("@")[1]?.toLowerCase();
  const match = state?.providers?.find((p) => p.domains.includes(domain));
  if (match && match.id !== provider) { provider = match.id; renderLogin(); }
});

$("loginForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = $("loginBtn"), err = $("loginError");
  err.hidden = true; btn.disabled = true; btn.textContent = "Checking with your email provider…";
  try {
    state = await api("/api/login", { provider, email: $("lEmail").value, password: $("lPass").value, imapHost: $("lImap").value, smtpHost: $("lSmtp").value });
    $("lPass").value = "";
    settingsFilled = false;
    render();
  } catch (e) {
    err.textContent = e.message; err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = "Log in";
  }
});

/* ---------- dashboard ---------- */
function pill(t) {
  if (t.status === "sent") return h("span", { class: "pill sent", text: t.auto ? "Sent automatically" : "Sent" });
  if (t.status === "skipped") return h("span", { class: "pill cat", text: "Skipped" });
  if (t.status === "error") return h("span", { class: "pill bad", text: "Not written" });
  return h("span", { class: "pill hold", text: t.action === "send" ? "Draft ready" : "Needs you" });
}

function renderList() {
  const ul = $("list");
  ul.textContent = "";
  $("listEmpty").hidden = state.tickets.length > 0;
  for (const t of state.tickets) {
    ul.append(h("li", null, h("button", { type: "button", class: "row", "aria-current": String(t.id === selected), onclick: () => { selected = t.id; renderList(); renderThread(true); } },
      h("span", { class: "who", text: t.customer.name || t.customer.email }),
      h("span", { class: "time", text: when(t.receivedAt) }),
      h("span", { class: "subj", text: t.subject }),
      h("span", { class: "tags" }, pill(t), h("span", { class: "pill cat", text: t.category }), t.ownerAction && !t.ownerActionDone ? h("span", { class: "pill hold", text: "To do in Shopify" }) : null))));
  }
}

function renderThread(force) {
  const box = $("thread");
  if (!force && box.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA") return; // don't interrupt typing
  box.textContent = "";
  const t = state.tickets.find((x) => x.id === selected);
  if (!t) { box.append(h("p", { class: "hint", text: "Pick an email on the left to see what the customer wrote and the reply." })); return; }

  box.append(h("div", null, h("h3", { text: t.subject }), h("div", { class: "meta", text: `${t.customer.name ? t.customer.name + " " : ""}<${t.customer.email}> · ${when(t.receivedAt)} · ${t.source}` })));
  box.append(h("div", { class: "step" }, h("span", { class: "label", text: "Customer wrote" }), h("div", { class: "msg customer", text: t.text || "(empty message)" })));
  if (t.lookupText) box.append(h("div", { class: "step" }, h("span", { class: "label", text: "Looked up in Shopify" }), h("pre", { class: "lookup", text: t.lookupText })));

  const step = h("div", { class: "step" }, h("span", { class: "label", text: "Assistant" }));
  step.append(h("div", { class: "decision" }, pill(t), h("span", { class: "why", text: t.error || t.reason || "" })));
  if (t.ownerAction) {
    const cb = h("input", { type: "checkbox", id: "todo-" + t.id, onchange: async (e) => { try { state = await api(`/api/tickets/${t.id}`, { ownerActionDone: e.target.checked }); renderList(); } catch (err) { toast(err.message); } } });
    cb.checked = t.ownerActionDone;
    step.append(h("div", { class: "todo" }, cb, h("label", { for: "todo-" + t.id, text: "To do in Shopify: " + t.ownerAction })));
  }

  if (t.status === "sent") {
    step.append(h("div", { class: "msg reply", text: t.reply }), h("p", { class: "hint", text: `Sent ${when(t.sentAt)}.` }));
  } else {
    const area = h("textarea", { class: "edit", id: "reply-" + t.id, "aria-label": "Reply", oninput: (e) => edits.set(t.id, e.target.value) });
    area.value = edits.get(t.id) ?? t.reply;
    const send = h("button", { type: "button", class: "btn primary", text: "Approve and send" });
    send.addEventListener("click", () => act(send, "Sending…", async () => { const s = await api(`/api/tickets/${t.id}/send`, { reply: area.value }); edits.delete(t.id); toast("Reply sent to " + t.customer.email); return s; }));
    const redo = h("button", { type: "button", class: "btn", text: "Rewrite" });
    redo.addEventListener("click", () => act(redo, "Writing…", async () => { const s = await api(`/api/tickets/${t.id}/redraft`, {}); edits.delete(t.id); return s; }));
    const skip = h("button", { type: "button", class: "btn", text: "Skip, no reply" });
    skip.addEventListener("click", () => act(skip, "Skipping…", () => api(`/api/tickets/${t.id}`, { skip: true })));
    step.append(area, h("div", { class: "actions" }, send, redo, t.status === "skipped" ? null : skip));
  }
  box.append(step);
}

function renderNotices() {
  const box = $("notices");
  box.textContent = "";
  if (state.lastError) box.append(h("div", { class: "notice bad", text: "The inbox couldn't be checked: " + state.lastError }));
  if (!state.aiReady) box.append(h("div", { class: "notice", text: "No AI key is set on the server (ANTHROPIC_API_KEY), so replies can't be written yet." }));
  if (!state.shopifyReady) box.append(h("div", { class: "notice", text: "Shopify order lookup isn't connected yet. Order and tracking questions will wait for you until it is." }));
}

function fillSettings() {
  const s = state.settings;
  $("sName").value = s.storeName; $("sTone").value = s.tone; $("sUrl").value = s.storeUrl;
  $("sPolicies").value = s.policies; $("sFacts").value = s.storeFacts;
  settingsFilled = true;
}

function renderApp() {
  const s = state.settings;
  $("storeTitle").textContent = s.storeName + " support inbox";
  $("acctEmail").textContent = state.email;
  $("checked").textContent = state.lastCheck ? "Inbox checked " + when(state.lastCheck) : "Checking the inbox…";
  $("modeAuto").setAttribute("aria-pressed", String(s.mode === "auto"));
  $("modeDraft").setAttribute("aria-pressed", String(s.mode === "draft"));
  $("sTotal").textContent = state.tickets.length;
  $("sSent").textContent = state.tickets.filter((t) => t.status === "sent").length;
  $("sWait").textContent = state.tickets.filter((t) => t.status === "waiting" || t.status === "error").length;
  $("sIgnored").textContent = state.ignored.length;
  $("factsHint").textContent = s.storeFactsAt ? "Website last read " + when(s.storeFactsAt) + "." : "Not read yet. Reading your store teaches the assistant your products and policies.";
  if (!selected || !state.tickets.some((t) => t.id === selected)) selected = state.tickets[0]?.id || null;
  if (!settingsFilled) fillSettings();
  renderNotices(); renderList(); renderThread(false);
  const ul = $("ignoredList");
  ul.textContent = "";
  if (!state.ignored.length) ul.append(h("li", { class: "why", text: "Nothing ignored yet." }));
  for (const i of state.ignored) ul.append(h("li", null, h("div", { text: `${i.from}: ${i.subject || "(no subject)"}` }), h("div", { class: "why", text: i.reason })));
}

function render() {
  $("loading").hidden = true;
  $("loginView").hidden = state.loggedIn;
  $("appView").hidden = !state.loggedIn;
  if (state.loggedIn) renderApp(); else renderLogin();
}

for (const [id, mode] of [["modeAuto", "auto"], ["modeDraft", "draft"]]) {
  $(id).addEventListener("click", async () => { try { state = await api("/api/settings", { mode }); render(); } catch (e) { toast(e.message); } });
}
$("checkNow").addEventListener("click", () => act($("checkNow"), "Checking…", () => api("/api/check", {})));
$("logout").addEventListener("click", async () => { await api("/api/logout", {}).catch(() => {}); await load(); });
$("readStore").addEventListener("click", () => act($("readStore"), "Reading…", async () => {
  await api("/api/settings", { storeUrl: $("sUrl").value });
  const s = await api("/api/store/read", {});
  settingsFilled = false; toast("Read your store's products and policies."); return s;
}));
$("settingsForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const err = $("settingsError"); err.hidden = true;
  try {
    state = await api("/api/settings", { storeName: $("sName").value, tone: $("sTone").value, storeUrl: $("sUrl").value, policies: $("sPolicies").value, storeFacts: $("sFacts").value });
    settingsFilled = false; render(); toast("Settings saved.");
  } catch (e) { err.textContent = e.message; err.hidden = false; }
});
let disconnectArmed = false;
$("disconnect").addEventListener("click", async () => {
  if (!disconnectArmed) { disconnectArmed = true; $("disconnect").textContent = "Click again to disconnect and forget the password"; setTimeout(() => { disconnectArmed = false; $("disconnect").textContent = "Disconnect this inbox"; }, 5000); return; }
  await api("/api/disconnect", {}).catch((e) => toast(e.message));
  await load();
});

async function load() {
  try { state = await api("/api/state"); render(); } catch { /* keep the last view; the next refresh retries */ }
}
load();
setInterval(() => { if (state?.loggedIn && !document.hidden) load(); }, 15000);
