# Cinchify — Deployment Checklist

## 1. Set up Stripe (15 mins)

1. Go to stripe.com → sign up / log in
2. **Create two products:**
   - Products → Add product → "Primary School Licence" → £249 → Recurring → Yearly → Save
   - Copy the `price_xxx` ID shown → paste into `.env` as `STRIPE_PRICE_PRIMARY`
   - Repeat for "Secondary School Licence" at £399 → `STRIPE_PRICE_SECONDARY`
3. **Get your secret key:**
   - Developers → API keys → copy Secret key → paste as `STRIPE_SECRET_KEY`
4. **Set up webhook:**
   - Developers → Webhooks → Add endpoint
   - URL: `https://yourapp.railway.app/api/stripe/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.deleted`, `invoice.payment_succeeded`
   - Copy the webhook signing secret → paste as `STRIPE_WEBHOOK_SECRET`
5. Use **test mode keys** first (toggle top-left in Stripe dashboard)

---

## 2. Set up cPanel email (5 mins)

1. Log in to cPanel → Email Accounts
2. Create `licences@cinchify.ie` if it doesn't exist
3. Click "Connect Devices" on that account → copy the SMTP settings into `.env`:
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
   - Usually port 587, SMTP_SECURE=false

---

## 3. Deploy to Railway (10 mins)

1. Go to railway.app → New Project → Deploy from GitHub repo
2. Add a PostgreSQL database: New → Database → PostgreSQL
3. Copy `DATABASE_URL` from the PostgreSQL service → it's set automatically as an env var
4. Add all your other env vars in the Railway service settings (Variables tab)
5. Set `NODE_ENV=production`
6. Set `APP_URL=https://yourapp.railway.app` (update after you see your Railway URL)
7. Railway auto-detects `package.json` and runs `npm start`

---

## 4. Run the database schema (2 mins)

Once deployed, open the Railway PostgreSQL console (or use any Postgres client with your DATABASE_URL):

```sql
-- Paste the entire contents of schema.sql and run it
```

Or via CLI:
```bash
psql $DATABASE_URL -f schema.sql
```

---

## 5. Deploy files

Your repo should contain:
```
app.html
server.js
signup.html
package.json
.env.example
schema.sql
```

Do NOT commit `.env` — Railway env vars are set in the dashboard.

---

## 6. Test the flow

1. Visit `/signup` → fill in form → click "Start free trial"
2. Use Stripe test card: `4242 4242 4242 4242`, any future date, any CVC
3. Check that a licence email arrives at your address
4. Open the app → Settings → paste the licence key → confirm it goes green
5. Check that import buttons and AI features are enabled

---

## 7. Go live

- Switch Stripe from test mode to live mode
- Update `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRIMARY`, `STRIPE_PRICE_SECONDARY`, `STRIPE_WEBHOOK_SECRET` to live values
- Update the webhook endpoint URL in Stripe if your domain changed

---

## Security notes

- HTTPS is automatic on Railway — never serve over HTTP in production
- The `.env` file must never be committed to git — add it to `.gitignore`
- Rate limiting is active on `/api/licence/check` (20 requests/minute per IP)
- Stripe webhook signature is verified on every webhook call
- Every `/api/images` and `/api/data` call validates the school key before touching the database
