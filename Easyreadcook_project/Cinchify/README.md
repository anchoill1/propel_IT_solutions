# 🍳 Cinchify — School Cooking App

A web-based cooking app for primary and secondary schools. Teachers build beautiful step-by-step recipe cards, generate AI illustrations for each step, import recipes from YouTube videos or photos, and export printable PDFs — all from any iPad, tablet, or school computer.

---

## Features

- 📋 Unlimited recipe library with categories, photos, and tips
- 🎨 AI-generated step illustrations (via OpenAI)
- 📄 PDF export for printing recipe cards
- 🎬 Import recipes from YouTube videos using AI
- 📷 Import from a photo or scanned PDF
- 🔊 Text-to-speech for each step
- 🏫 Per-school data isolation — each school only sees their own recipes and images
- 🔑 Licence key system with 30-day free trial
- 💳 Stripe-powered subscriptions (Primary £249/year, Secondary £399/year)

---

## Tech Stack

- **Frontend:** Vanilla JS, single HTML file (`app.html`) — no framework, works on iPads
- **Backend:** Node.js + Express
- **Database:** PostgreSQL
- **Payments:** Stripe Checkout + webhooks
- **Email:** Nodemailer via cPanel SMTP
- **Deployment:** Railway (or Render)

---

## Project Structure

```
cinchify/
├── app.html          # The entire frontend app (~7,300 lines)
├── server.js         # Production Express server
├── signup.html       # School signup / pricing page
├── schema.sql        # PostgreSQL schema — run once on your database
├── package.json
├── .env.example      # Copy to .env and fill in your values
└── DEPLOY.md         # Step-by-step deployment guide
```

---

## Getting Started (Local Development)

1. **Clone the repo**
   ```bash
   git clone https://github.com/yourusername/cinchify.git
   cd cinchify
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   # Edit .env with your database URL, API keys, and Stripe keys
   ```

4. **Set up the database**
   ```bash
   psql $DATABASE_URL -f schema.sql
   ```

5. **Start the server**
   ```bash
   npm start
   ```

6. Open `http://localhost:3000` in your browser.

---

## Deployment

See **[DEPLOY.md](./DEPLOY.md)** for the full step-by-step guide covering:
- Stripe product and webhook setup
- cPanel email configuration
- Railway deployment
- Running the database schema
- End-to-end testing

---

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `STRIPE_SECRET_KEY` | Stripe secret key (test or live) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `STRIPE_PRICE_PRIMARY` | Stripe price ID for primary tier |
| `STRIPE_PRICE_SECONDARY` | Stripe price ID for secondary tier |
| `ANTHROPIC_API_KEY` | Claude API key for AI features |
| `SMTP_HOST` | cPanel SMTP host |
| `SMTP_USER` | Sending email address |
| `FROM_EMAIL` | licences@cinchify.ie |
| `APP_URL` | Your deployed app URL |

---

## Licence

Private — all rights reserved. Not open source.

---

## Contact

licences@cinchify.ie
