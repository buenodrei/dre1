# Support Autopilot

Answers your Shopify customers' emails for you. You log in to the inbox your customers write to, and the app:

1. Checks the inbox every minute.
2. Keeps only emails from Shopify customers and shoppers. Newsletters, receipts, personal mail and Shopify's own notifications are ignored and never answered.
3. Looks up the sender's order in Shopify (status and tracking number).
4. Has Claude write a short, human reply that follows your rules.
5. Sends it, or holds it for your approval, depending on the switch at the top of the page.

Only email that arrives after you log in is handled. Nothing already in the inbox gets a reply.

## Run it

Needs Node 20 or newer.

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in `.env` (see below), then:

```bash
node --env-file=.env server.js
```

Open http://localhost:3000 and log in.

To keep answering email while your computer is off, run it on an always-on host with a persistent disk for the `data` folder. A `Dockerfile` is included; mount a volume at `/data`.

## What you need

| Thing | Why | Where |
|---|---|---|
| `ANTHROPIC_API_KEY` | Writes the replies | platform.claude.com |
| `APP_SECRET` | Encrypts your saved mailbox password | Any long random text you make up |
| `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_TOKEN` | Order and tracking answers | Shopify admin: Settings > Apps and sales channels > Develop apps. Scopes: `read_orders`, `read_customers` |
| An app password for your mailbox | The login screen | Gmail: myaccount.google.com/apppasswords. Yahoo, AOL, iCloud: account security page |

Gmail, Yahoo, iCloud and AOL work from the login screen. "Other" takes any provider with IMAP and SMTP. Outlook.com and Hotmail are not supported, because Microsoft no longer allows password logins for apps.

Without the Shopify token the app still works, but order and tracking questions wait for you instead of being answered.

## How it decides what is a Shopify email

- Messages from your store's contact form (sent by Shopify with the customer in Reply-To): always handled.
- Senders who have an order in your store: always handled.
- Anything else from a real person: Claude reads it and only keeps it if it is a shopper writing about your store.
- Automated mail, mailing lists, no-reply senders and Shopify notifications: ignored before any AI is involved.

Ignored emails are listed in the app so you can see what was skipped.

## Safety rules built in

- Starts in "Draft for my approval". Switch to "Reply automatically" when you trust it.
- Order details are only shared with the email address that placed the order.
- At most 4 automatic replies to one customer per day, to prevent reply loops.
- The assistant cannot change anything in Shopify. Refunds, discount codes and order edits show up as a "To do in Shopify" note for you.
- Legal threats, wholesale requests and anything your rules don't cover are held for you.

## Tests

```bash
npm test
```
