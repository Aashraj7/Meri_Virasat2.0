'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { CATEGORIES } = require('./seed');

const DATA_DIR = process.env.MV_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'meri-virasat.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS heritage_categories (
    name        TEXT PRIMARY KEY,
    description TEXT,
    icon        TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS heritage (
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
  );

  CREATE TABLE IF NOT EXISTS app_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS heritage_status_idx ON heritage(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS heritage_category_idx ON heritage(category);
  CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
`);

/* Databases created before pins existed need the coordinate columns. */
const heritageColumns = new Set(db.prepare('PRAGMA table_info(heritage)').all().map((c) => c.name));
if (!heritageColumns.has('lat')) db.exec('ALTER TABLE heritage ADD COLUMN lat REAL');
if (!heritageColumns.has('lng')) db.exec('ALTER TABLE heritage ADD COLUMN lng REAL');

function seed() {
  const categoryCount = db.prepare('SELECT COUNT(*) AS c FROM heritage_categories').get().c;
  if (!categoryCount) {
    const insert = db.prepare(
      'INSERT INTO heritage_categories (name, description, icon, sort_order) VALUES (?, ?, ?, ?)'
    );
    CATEGORIES.forEach(([name, description, icon], i) => insert.run(name, description, icon, i));
  }

  /* One-time cleanup of the demo records that earlier builds inserted. */
  const purged = db.prepare("SELECT value FROM app_meta WHERE key = 'demo-purge'").get();
  if (!purged) {
    db.prepare("DELETE FROM heritage WHERE id LIKE 'seed-%'").run();
    db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('demo-purge', datetime('now'))").run();
  }
}

function riskLabel(score) {
  const n = Number(score) || 0;
  return n >= 70 ? 'High Preservation Risk' : n >= 45 ? 'Moderate Risk' : 'Low Risk';
}

seed();

const queries = {
  listCategories() {
    return db
      .prepare(
        'SELECT name, description, icon FROM heritage_categories WHERE is_active = 1 ORDER BY sort_order ASC, name ASC'
      )
      .all();
  },

  listHeritage({ status = 'published', category, region, q } = {}) {
    const where = [];
    const args = [];
    if (status && status !== 'all') {
      where.push('status = ?');
      args.push(status);
    }
    if (category) {
      where.push('category = ?');
      args.push(category);
    }
    if (region) {
      where.push('region = ?');
      args.push(region);
    }
    if (q) {
      where.push('(name LIKE ? OR location LIKE ? OR description LIKE ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const sql =
      'SELECT * FROM heritage' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at DESC';
    return db.prepare(sql).all(...args);
  },

  getHeritage(id) {
    return db.prepare('SELECT * FROM heritage WHERE id = ?').get(id);
  },

  createHeritage(record) {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO heritage
        (id, name, category, region, location, lat, lng, description, history, story, tradition,
         people, evidence, risk_score, risk_label, theme, image_url, status, submitted_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      record.name,
      record.category,
      record.region,
      record.location,
      record.lat,
      record.lng,
      record.description,
      record.history,
      record.story,
      record.tradition,
      record.people,
      record.evidence,
      record.risk_score,
      riskLabel(record.risk_score),
      record.theme,
      record.image_url,
      record.status,
      record.submitted_by
    );
    return queries.getHeritage(id);
  },

  deleteHeritage(id) {
    return db.prepare('DELETE FROM heritage WHERE id = ?').run(id).changes > 0;
  },

  stats() {
    return {
      records: db.prepare("SELECT COUNT(*) AS c FROM heritage WHERE status = 'published'").get().c,
      contributors: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
      categories: db.prepare('SELECT COUNT(*) AS c FROM heritage_categories WHERE is_active = 1').get().c,
      mapped: db
        .prepare("SELECT COUNT(*) AS c FROM heritage WHERE status = 'published' AND lat IS NOT NULL AND lng IS NOT NULL")
        .get().c
    };
  }
};

module.exports = { db, ...queries, riskLabel };
