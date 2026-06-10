#!/usr/bin/env node
'use strict';
// ============================================================
// Cinchify — Production Server
// ============================================================

require('dotenv').config();

const express    = require('express');
const { Pool }   = require('pg');
const Stripe     = require('stripe');
const nodemailer = require('nodemailer');
const crypto     = require('crypto');
const https      = require('https');
const path       = require('path');

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');
const PORT   = parseInt(process.env.PORT || '3000', 10);

// ── DATABASE ─────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

pool.connect()
  .then(() => console.log('✅  PostgreSQL connected'))
  .catch(e => { console.error('❌  PostgreSQL connection failed:', e.message); process.exit(1); });

// ── EMAIL ─────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// ── RATE LIMITING (manual, no extra dependency) ───────────────
const rateLimitStore = new Map(); // ip -> { count, resetAt }

function rateLimit(maxPerWindow, windowMs) {
  return (req, res, next) => {
    const ip  = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = rateLimitStore.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimitStore.set(ip, entry);
    }
    entry.count++;
    if (entry.count > maxPerWindow) {
      return res.status(429).json({ ok: false, error: 'Too many requests — please wait and try again.' });
    }
    next();
  };
}

// Clean up rate limit store every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore.entries()) {
    if (now > entry.resetAt) rateLimitStore.delete(ip);
  }
}, 10 * 60 * 1000);

// ── HELPERS ───────────────────────────────────────────────────
function generateLicenceKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 to avoid confusion
  const seg   = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `ANNA-${seg()}-${seg()}-${seg()}`;
}

async function getSchoolFromKey(key) {
  if (!key) return null;
  const result = await pool.query(
    `SELECT s.id AS school_id, s.name AS school_name, s.email,
            l.id AS licence_id, l.tier, l.valid_until, l.status, l.licence_key
     FROM licences l
     JOIN schools s ON s.id = l.school_id
     WHERE l.licence_key = $1
     LIMIT 1`,
    [key]
  );
  return result.rows[0] || null;
}

// ── MIDDLEWARE ────────────────────────────────────────────────
// Stripe webhook needs raw body — must come before express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-school-key,x-api-key,x-openai-key,x-anthropic-endpoint');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// Enforce HTTPS in production
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, 'https://' + req.headers.host + req.url);
  }
  next();
});

// ── SCHOOL KEY GUARD ─────────────────────────────────────────
// All /api/ routes EXCEPT the public ones require a valid x-school-key
const PUBLIC_ROUTES = [
  '/api/licence/check',
  '/api/licence/activate',
  '/api/checkout',
  '/api/stripe/webhook',
  '/api/anthropic',
  '/api/anthropic/models',
  '/api/openai-image',
  '/api/fetch-image',
];

async function requireSchoolKey(req, res, next) {
  // Skip guard for public routes
  if (PUBLIC_ROUTES.some(r => req.path.startsWith(r))) return next();

  const key = req.headers['x-school-key'] || '';
  if (!key) {
    return res.status(401).json({ ok: false, error: 'Missing school licence key.' });
  }

  try {
    const school = await getSchoolFromKey(key);
    if (!school) {
      return res.status(401).json({ ok: false, error: 'Invalid licence key.' });
    }
    if (school.status === 'cancelled') {
      return res.status(403).json({ ok: false, error: 'Licence cancelled.' });
    }
    // Attach to request for downstream handlers
    req.school = school;
    next();
  } catch (e) {
    console.error('School key guard error:', e.message);
    res.status(500).json({ ok: false, error: 'Server error during licence check.' });
  }
}

app.use('/api/images',      requireSchoolKey);
app.use('/api/data',        requireSchoolKey);
app.use('/api/step-images', requireSchoolKey);

// ── SERVE APP ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});
app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'signup.html'));
});
app.use(express.static(__dirname, {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// ════════════════════════════════════════════════════════════
// LICENCE ROUTES
// ════════════════════════════════════════════════════════════

// POST /api/licence/check
app.post('/api/licence/check',
  rateLimit(20, 60 * 1000), // 20 checks per minute per IP
  async (req, res) => {
    const { key } = req.body || {};
    if (!key) return res.json({ valid: false });

    try {
      const school = await getSchoolFromKey(key);
      if (!school) return res.json({ valid: false });

      const now     = new Date();
      const expires = new Date(school.valid_until);
      const valid   = school.status === 'active' && expires > now;

      res.json({
        valid,
        expires:     expires.toISOString(),
        tier:        school.tier,
        school_name: school.school_name,
        status:      school.status
      });
    } catch (e) {
      console.error('Licence check error:', e.message);
      res.status(500).json({ valid: false, error: 'Server error' });
    }
  }
);

// POST /api/licence/activate — internal use / webhook only
app.post('/api/licence/activate', async (req, res) => {
  // This is called internally from the Stripe webhook handler
  // Not exposed publicly — just returns 200 if called directly
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
// STRIPE ROUTES
// ════════════════════════════════════════════════════════════

// POST /api/checkout — create a Stripe Checkout session
app.post('/api/checkout',
  rateLimit(10, 60 * 1000),
  async (req, res) => {
    const { tier, email, school_name, contact_name } = req.body || {};

    if (!tier || !email || !school_name) {
      return res.status(400).json({ ok: false, error: 'Missing required fields: tier, email, school_name' });
    }
    if (!['primary', 'secondary'].includes(tier)) {
      return res.status(400).json({ ok: false, error: 'Invalid tier' });
    }

    const priceId = tier === 'primary'
      ? (process.env.STRIPE_PRICE_PRIMARY   || 'price_PRIMARY_PLACEHOLDER')
      : (process.env.STRIPE_PRICE_SECONDARY || 'price_SECONDARY_PLACEHOLDER');

    try {
      const session = await stripe.checkout.sessions.create({
        mode:                 'subscription',
        payment_method_types: ['card'],
        customer_email:       email,
        line_items: [{ price: priceId, quantity: 1 }],
        subscription_data: {
          trial_period_days: 30,
          metadata: { tier, school_name, contact_name: contact_name || '', email }
        },
        metadata: { tier, school_name, contact_name: contact_name || '', email },
        success_url: (process.env.APP_URL || 'https://yourapp.railway.app') + '/?session_id={CHECKOUT_SESSION_ID}',
        cancel_url:  (process.env.APP_URL || 'https://yourapp.railway.app') + '/signup?cancelled=1',
      });

      res.json({ ok: true, url: session.url });
    } catch (e) {
      console.error('Stripe checkout error:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// POST /api/stripe/webhook — handle Stripe events
async function handleStripeWebhook(req, res) {
  const sig     = req.headers['stripe-signature'];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET || '';

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (e) {
    console.error('Stripe webhook signature verification failed:', e.message);
    return res.status(400).send('Webhook signature verification failed');
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const meta    = session.metadata || {};

    const schoolName   = meta.school_name   || 'Unknown School';
    const contactName  = meta.contact_name  || '';
    const email        = meta.email         || session.customer_email || '';
    const tier         = meta.tier          || 'primary';
    const subId        = session.subscription;
    const customerId   = session.customer;

    try {
      // Get subscription to find actual end date
      let validUntil = new Date();
      validUntil.setFullYear(validUntil.getFullYear() + 1);

      if (subId) {
        try {
          const sub  = await stripe.subscriptions.retrieve(subId);
          validUntil = new Date(sub.current_period_end * 1000);
        } catch(e) {
          console.log('Could not retrieve subscription, using 1-year default');
        }
      }

      // Upsert school
      const schoolRes = await pool.query(
        `INSERT INTO schools (name, contact_name, email)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, contact_name = EXCLUDED.contact_name
         RETURNING id`,
        [schoolName, contactName, email]
      );
      const schoolId = schoolRes.rows[0].id;

      // Generate unique licence key
      let licenceKey;
      let attempts = 0;
      while (attempts < 10) {
        licenceKey = generateLicenceKey();
        const exists = await pool.query('SELECT id FROM licences WHERE licence_key = $1', [licenceKey]);
        if (!exists.rows.length) break;
        attempts++;
      }

      // Insert licence
      await pool.query(
        `INSERT INTO licences (school_id, licence_key, tier, valid_from, valid_until, stripe_subscription_id, stripe_customer_id, status)
         VALUES ($1, $2, $3, NOW(), $4, $5, $6, 'active')`,
        [schoolId, licenceKey, tier, validUntil, subId, customerId]
      );

      console.log(`✅  Licence created: ${licenceKey} for ${schoolName} (${email})`);

      // Send licence email
      await sendLicenceEmail({ email, schoolName, contactName, licenceKey, tier, validUntil });

    } catch (e) {
      console.error('Error processing webhook:', e.message);
      // Still return 200 to Stripe so it doesn't retry endlessly
    }
  }

  // Handle subscription cancellations
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    try {
      await pool.query(
        `UPDATE licences SET status = 'cancelled' WHERE stripe_subscription_id = $1`,
        [sub.id]
      );
      console.log(`Licence cancelled for subscription: ${sub.id}`);
    } catch (e) {
      console.error('Error cancelling licence:', e.message);
    }
  }

  // Handle subscription renewals
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    if (invoice.subscription) {
      try {
        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        const validUntil = new Date(sub.current_period_end * 1000);
        await pool.query(
          `UPDATE licences SET valid_until = $1, status = 'active' WHERE stripe_subscription_id = $2`,
          [validUntil, invoice.subscription]
        );
        console.log(`Licence renewed until ${validUntil.toISOString()} for subscription ${invoice.subscription}`);
      } catch (e) {
        console.error('Error renewing licence:', e.message);
      }
    }
  }

  res.json({ received: true });
}

async function sendLicenceEmail({ email, schoolName, contactName, licenceKey, tier, validUntil }) {
  const tierLabel   = tier === 'primary' ? 'Primary School' : 'Secondary School';
  const expiryStr   = new Date(validUntil).toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });
  const appUrl      = process.env.APP_URL || 'https://yourapp.railway.app';
  const greeting    = contactName ? `Hi ${contactName},` : `Hello,`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a1a;">
  <div style="background:#e8412a;padding:24px;border-radius:12px 12px 0 0;text-align:center;">
    <h1 style="color:white;margin:0;font-size:1.8rem;">🍳 Cinchify</h1>
    <p style="color:rgba(255,255,255,.85);margin:6px 0 0;">Your school licence is ready!</p>
  </div>
  <div style="background:#fff;border:2px solid #ede8ff;border-top:none;padding:32px;border-radius:0 0 12px 12px;">
    <p>${greeting}</p>
    <p>Thank you for subscribing to Cinchify for <strong>${schoolName}</strong>. Your <strong>${tierLabel}</strong> licence is now active.</p>

    <div style="background:#f8f5ff;border:2px solid #c4b5fd;border-radius:12px;padding:20px;margin:24px 0;text-align:center;">
      <p style="margin:0 0 8px;font-size:.9rem;color:#7c3aed;font-weight:bold;">YOUR LICENCE KEY</p>
      <p style="margin:0;font-size:1.6rem;font-weight:900;letter-spacing:2px;color:#1a1a1a;">${licenceKey}</p>
      <p style="margin:8px 0 0;font-size:.8rem;color:#666;">Valid until ${expiryStr}</p>
    </div>

    <h3 style="color:#2d8a4e;">Getting started — 3 simple steps:</h3>
    <ol style="padding-left:20px;line-height:2;">
      <li>Open the app: <a href="${appUrl}" style="color:#7c3aed;">${appUrl}</a></li>
      <li>Tap the ⚙️ settings button (bottom right)</li>
      <li>Paste your licence key into the <strong>School Licence Key</strong> field</li>
    </ol>

    <p>All your recipes and images are saved securely to your school's account. You can use the app on any tablet, iPad, or computer in your school.</p>

    <p style="margin-top:32px;font-size:.85rem;color:#666;">
      Questions? Reply to this email and we'll help.<br>
      To cancel your subscription, visit your Stripe billing portal or email us.<br><br>
      Cinchify · <a href="${appUrl}" style="color:#7c3aed;">cinchify.ie</a>
    </p>
  </div>
</body>
</html>`;

  try {
    await mailer.sendMail({
      from:    `"Cinchify" <${process.env.FROM_EMAIL || 'licences@cinchify.ie'}>`,
      to:      email,
      subject: `Your Cinchify licence key — ${schoolName}`,
      html
    });
    console.log(`📧  Licence email sent to ${email}`);
  } catch (e) {
    console.error('Failed to send licence email:', e.message);
    // Don't throw — licence is created, email failure shouldn't break the webhook
  }
}

// ════════════════════════════════════════════════════════════
// IMAGE API  (per-school, scoped by x-school-key)
// ════════════════════════════════════════════════════════════

// GET /api/images — list keys for this school
app.get('/api/images', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT key FROM images WHERE school_id = $1',
      [req.school.school_id]
    );
    res.json({ ok: true, keys: result.rows.map(r => r.key) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/images/:key
app.get('/api/images/:key', async (req, res) => {
  const key = (req.params.key || '').replace(/[^a-zA-Z0-9_\-]/g, '_');
  try {
    const result = await pool.query(
      'SELECT data, ext FROM images WHERE school_id = $1 AND key = $2',
      [req.school.school_id, key]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: 'not found' });
    const { data, ext } = result.rows[0];
    const mime = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp' }[ext] || 'image/jpeg';
    res.json({ ok: true, key, data: 'data:' + mime + ';base64,' + data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/images — save image
app.post('/api/images', async (req, res) => {
  const { key: rawKey, data: rawData, ext: rawExt } = req.body || {};
  const key  = (rawKey  || '').replace(/[^a-zA-Z0-9_\-]/g, '_');
  const b64  = (rawData || '').replace(/^data:[^;]+;base64,/, '');
  const ext  = (rawExt  || 'jpg').replace(/[^a-z]/g, '');

  if (!key || !b64) return res.status(400).json({ ok: false, error: 'missing key or data' });

  try {
    await pool.query(
      `INSERT INTO images (school_id, key, data, ext)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (school_id, key) DO UPDATE SET data = EXCLUDED.data, ext = EXCLUDED.ext`,
      [req.school.school_id, key, b64, ext]
    );
    res.json({ ok: true, key });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/images/:key
app.delete('/api/images/:key', async (req, res) => {
  const key = (req.params.key || '').replace(/[^a-zA-Z0-9_\-]/g, '_');
  try {
    await pool.query(
      'DELETE FROM images WHERE school_id = $1 AND key = $2',
      [req.school.school_id, key]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// STEP IMAGES API  (shared across all schools)
// ════════════════════════════════════════════════════════════

// GET /api/step-images — list all cached slugs
app.get('/api/step-images', async (req, res) => {
  try {
    const result = await pool.query('SELECT slug FROM step_images');
    res.json({ ok: true, keys: result.rows.map(r => r.slug) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/step-images/:slug
app.get('/api/step-images/:slug', async (req, res) => {
  const slug = decodeURIComponent(req.params.slug || '').replace(/[^a-zA-Z0-9_\- ]/g, '_');
  if (!slug) return res.status(400).json({ ok: false, error: 'missing slug' });

  try {
    const result = await pool.query(
      'SELECT data FROM step_images WHERE slug = $1',
      [slug]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, key: slug, data: 'data:image/png;base64,' + result.rows[0].data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/step-images — save a generated step illustration
app.post('/api/step-images', async (req, res) => {
  const { key: rawKey, data: rawData } = req.body || {};
  const slug = (rawKey || '').replace(/[^a-zA-Z0-9_\- ]/g, '_').slice(0, 120);
  const b64  = (rawData || '').replace(/^data:[^;]+;base64,/, '');

  if (!slug || !b64) return res.status(400).json({ ok: false, error: 'missing key or data' });

  try {
    await pool.query(
      `INSERT INTO step_images (slug, data)
       VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET data = EXCLUDED.data`,
      [slug, b64]
    );
    res.json({ ok: true, key: slug });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// RECIPE DATA API  (per-school)
// ════════════════════════════════════════════════════════════

// GET /api/data
app.get('/api/data', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT data FROM recipes WHERE school_id = $1',
      [req.school.school_id]
    );
    if (!result.rows.length) return res.json({ ok: true, data: null });
    const parsed = result.rows[0].data;
    const hasRecipes = parsed && parsed.recipes && Object.keys(parsed.recipes).length > 0;
    res.json({ ok: true, data: hasRecipes ? parsed : null });
  } catch (e) {
    res.status(500).json({ ok: true, data: null });
  }
});

// POST /api/data
app.post('/api/data', async (req, res) => {
  const data = req.body;
  if (!data) return res.status(400).json({ ok: false, error: 'no data' });

  try {
    await pool.query(
      `INSERT INTO recipes (school_id, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (school_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [req.school.school_id, JSON.stringify(data)]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// ANTHROPIC PROXY
// ════════════════════════════════════════════════════════════

app.post('/api/anthropic', (req, res) => {
  res.socket && res.socket.on('error', () => {});
  res.on('error', () => {});

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('error', () => {});
  req.on('end', () => {
    const body     = Buffer.concat(chunks);
    const apiKey   = req.headers['x-api-key'] || process.env.ANTHROPIC_API_KEY || '';
    const endpoint = req.headers['x-anthropic-endpoint'] || '/v1/messages';

    const doRequest = (attempt) => {
      const options = {
        hostname: 'api.anthropic.com',
        path:     endpoint,
        method:   'POST',
        headers: {
          'Content-Type':      'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key':         apiKey
        },
        timeout: 120000
      };

      const proxyReq = https.request(options, proxyRes => {
        const resChunks = [];
        proxyRes.on('data', c => resChunks.push(c));
        proxyRes.on('error', () => {});
        proxyRes.on('end', () => {
          if (res.writableEnded) return;
          try {
            res.writeHead(proxyRes.statusCode, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            res.end(Buffer.concat(resChunks));
          } catch (e) {}
        });
      });

      proxyReq.on('error', e => {
        if ((e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT') && attempt < 2) {
          console.log(`Anthropic proxy ${e.code}, retrying (attempt ${attempt + 1})...`);
          setTimeout(() => doRequest(attempt + 1), 1000);
          return;
        }
        if (res.writableEnded) return;
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message } }));
        } catch (e2) {}
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (res.writableEnded) return;
        try {
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Request timed out — try again' } }));
        } catch (e) {}
      });

      proxyReq.write(body);
      proxyReq.end();
    };

    doRequest(1);
  });
});

// GET /api/anthropic/models
app.get('/api/anthropic/models', (req, res) => {
  const apiKey  = req.headers['x-api-key'] || process.env.ANTHROPIC_API_KEY || '';
  const options = {
    hostname: 'api.anthropic.com',
    path:     '/v1/models',
    method:   'GET',
    headers:  { 'anthropic-version': '2023-06-01', 'x-api-key': apiKey }
  };
  const proxyReq = https.request(options, proxyRes => {
    const chunks = [];
    proxyRes.on('data', c => chunks.push(c));
    proxyRes.on('end', () => {
      res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(Buffer.concat(chunks));
    });
  });
  proxyReq.on('error', e => { res.status(500).json({ error: e.message }); });
  proxyReq.end();
});

// ════════════════════════════════════════════════════════════
// OPENAI IMAGE PROXY
// ════════════════════════════════════════════════════════════

app.post('/api/openai-image', (req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body   = Buffer.concat(chunks);
    const apiKey = req.headers['x-openai-key'] || process.env.OPENAI_API_KEY || '';

    try {
      const params = JSON.parse(body.toString());
      console.log(`🎨 OpenAI image — model: ${params.model}, size: ${params.size}`);
    } catch (e) {}

    const options = {
      hostname: 'api.openai.com',
      path:     '/v1/images/generations',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Authorization':  'Bearer ' + apiKey,
        'Content-Length': body.length
      }
    };

    const proxyReq = https.request(options, proxyRes => {
      const resChunks = [];
      proxyRes.on('data', c => resChunks.push(c));
      proxyRes.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(resChunks).toString());
          if (proxyRes.statusCode !== 200) {
            res.status(500).json({ ok: false, error: (data.error && data.error.message) || 'OpenAI error ' + proxyRes.statusCode });
            return;
          }
          const item = (data.data || [])[0];
          if (!item) { res.status(500).json({ ok: false, error: 'No image in response' }); return; }

          if (item.b64_json) {
            res.json({ ok: true, data: 'data:image/png;base64,' + item.b64_json });
          } else if (item.url) {
            https.get(item.url, { headers: { 'User-Agent': 'Cinchify/1.0' } }, imgRes => {
              const imgChunks = [];
              imgRes.on('data', c => imgChunks.push(c));
              imgRes.on('end', () => {
                res.json({ ok: true, data: 'data:image/png;base64,' + Buffer.concat(imgChunks).toString('base64') });
              });
            }).on('error', e => res.status(500).json({ ok: false, error: e.message }));
          } else {
            res.status(500).json({ ok: false, error: 'No b64_json or url in response' });
          }
        } catch (e) {
          res.status(500).json({ ok: false, error: e.message });
        }
      });
    });

    proxyReq.on('error', e => res.status(500).json({ ok: false, error: e.message }));
    proxyReq.write(body);
    proxyReq.end();
  });
});

// ════════════════════════════════════════════════════════════
// FETCH IMAGE  (Pexels / Unsplash / Wikimedia)
// ════════════════════════════════════════════════════════════

app.get('/api/fetch-image', async (req, res) => {
  try {
    const q         = (req.query.q || 'cooking').trim();
    const pexelsKey = req.query.pexels || process.env.PEXELS_API_KEY || '';

    const get = (url, headers = {}) => new Promise((resolve, reject) => {
      const r = https.get(url, {
        headers: { 'User-Agent': 'Cinchify/1.0', ...headers },
        timeout: 12000
      }, (response) => {
        if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.resume();
          get(response.headers.location, headers).then(resolve).catch(reject);
          return;
        }
        const chunks = [];
        response.on('data', c => chunks.push(c));
        response.on('end',  () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
        response.on('error', reject);
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
    });

    const downloadImage = async (imgUrl, extraHeaders = {}) => {
      const imgRes = await get(imgUrl, extraHeaders);
      if (imgRes.status !== 200) throw new Error('HTTP ' + imgRes.status);
      const ct = (imgRes.headers['content-type'] || 'image/jpeg').split(';')[0];
      if (!ct.startsWith('image/')) throw new Error('Not an image: ' + ct);
      return 'data:' + ct + ';base64,' + imgRes.body.toString('base64');
    };

    let imageData = null;

    // Strategy 1: Pexels
    if (pexelsKey && !imageData) {
      try {
        const foodQuery  = q + ' food photography';
        const searchUrl  = `https://api.pexels.com/v1/search?query=${encodeURIComponent(foodQuery)}&per_page=10&orientation=landscape&size=medium`;
        const sRes       = await get(searchUrl, { 'Authorization': pexelsKey });
        if (sRes.status === 200) {
          const photos = JSON.parse(sRes.body.toString()).photos || [];
          if (photos.length) {
            const pick = photos[Math.floor(Math.random() * Math.min(photos.length, 5))];
            imageData = await downloadImage(pick.src.medium);
            console.log('✅ Pexels:', q);
          }
        }
      } catch (e) { console.log('Pexels failed:', e.message); }
    }

    // Strategy 2: Unsplash
    if (!imageData) {
      try {
        const unsplashUrl = `https://source.unsplash.com/480x360/?${encodeURIComponent(q + ',food,cooking,meal')}`;
        imageData = await downloadImage(unsplashUrl);
        console.log('✅ Unsplash:', q);
      } catch (e) { console.log('Unsplash failed:', e.message); }
    }

    // Strategy 3: Wikimedia
    if (!imageData) {
      try {
        const searchUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q + ' food')}&srnamespace=6&srlimit=6&format=json`;
        const sRes      = await get(searchUrl);
        if (sRes.status === 200) {
          const results = ((JSON.parse(sRes.body.toString()).query || {}).search || [])
            .filter(r => { const t = r.title.toLowerCase(); return (t.endsWith('.jpg') || t.endsWith('.jpeg')) && !t.includes('icon') && !t.includes('logo'); });
          for (const result of results.slice(0, 3)) {
            try {
              const iRes  = await get(`https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(result.title)}&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=800&format=json`);
              const pages = Object.values(((JSON.parse(iRes.body.toString()).query || {}).pages) || {});
              for (const page of pages) {
                const ii = page.imageinfo && page.imageinfo[0];
                if (ii && ii.thumburl && ii.mime === 'image/jpeg' && (ii.width || 0) >= 400) {
                  imageData = await downloadImage(ii.thumburl);
                  console.log('✅ Wikimedia:', result.title);
                  break;
                }
              }
              if (imageData) break;
            } catch (e2) {}
          }
        }
      } catch (e) { console.log('Wikimedia failed:', e.message); }
    }

    if (!imageData) throw new Error('Could not find a photo for: ' + q);
    res.json({ ok: true, data: imageData });

  } catch (e) {
    console.error('fetch-image FAILED:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  Cinchify production server running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Database:    ${process.env.DATABASE_URL ? 'connected' : '⚠️  DATABASE_URL not set'}`);
  console.log(`   Stripe:      ${process.env.STRIPE_SECRET_KEY ? 'configured' : '⚠️  STRIPE_SECRET_KEY not set'}\n`);
});
