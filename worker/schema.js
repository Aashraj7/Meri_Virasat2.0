'use strict';

/* D1 schema for Meri Virasat. Applied lazily (idempotently) on the first
   request of every Worker isolate, so a fresh database bootstraps itself. */

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS heritage_categories (
    name        TEXT PRIMARY KEY,
    description TEXT,
    icon        TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS heritage (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    category     TEXT,
    region       TEXT,
    location     TEXT,
    lat          REAL,
    lng          REAL,
    description  TEXT,
    history      TEXT,
    story        TEXT,
    tradition    TEXT,
    people       TEXT,
    evidence     TEXT,
    risk_score   INTEGER NOT NULL DEFAULT 50,
    risk_label   TEXT,
    theme        TEXT NOT NULL DEFAULT 'default',
    image_url    TEXT,
    status       TEXT NOT NULL DEFAULT 'published',
    submitted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS app_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  'CREATE INDEX IF NOT EXISTS heritage_status_idx ON heritage(status, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS heritage_category_idx ON heritage(category)',
  'CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)'
];
