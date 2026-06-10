-- ============================================================
-- Cinchify — Production PostgreSQL Schema
-- Run once on your database to set up all tables
-- ============================================================

-- Schools: one row per subscribing school
CREATE TABLE IF NOT EXISTS schools (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  email        TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Licences: one per school subscription
-- status: active | expired | cancelled
CREATE TABLE IF NOT EXISTS licences (
  id                      SERIAL PRIMARY KEY,
  school_id               INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  licence_key             TEXT NOT NULL UNIQUE,
  tier                    TEXT NOT NULL CHECK (tier IN ('primary','secondary')),
  valid_from              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until             TIMESTAMPTZ NOT NULL,
  stripe_subscription_id  TEXT,
  stripe_customer_id      TEXT,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','cancelled')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Recipes: per-school JSON blob (matches existing app data structure)
CREATE TABLE IF NOT EXISTS recipes (
  id          SERIAL PRIMARY KEY,
  school_id   INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE UNIQUE,
  data        JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Images: per-school (hero images, ingredient/tool photos)
CREATE TABLE IF NOT EXISTS images (
  id          SERIAL PRIMARY KEY,
  school_id   INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  data        TEXT NOT NULL,  -- base64 encoded image data
  ext         TEXT NOT NULL DEFAULT 'jpg',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (school_id, key)
);

-- Step images: shared across ALL schools (AI-generated illustrations)
-- Keyed by slug so the same illustration is never generated twice
CREATE TABLE IF NOT EXISTS step_images (
  id          SERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  data        TEXT NOT NULL,  -- base64 encoded image data
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── INDEXES ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_licences_key        ON licences (licence_key);
CREATE INDEX IF NOT EXISTS idx_licences_school     ON licences (school_id);
CREATE INDEX IF NOT EXISTS idx_licences_stripe_sub ON licences (stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_images_school_key   ON images   (school_id, key);
CREATE INDEX IF NOT EXISTS idx_step_images_slug    ON step_images (slug);
