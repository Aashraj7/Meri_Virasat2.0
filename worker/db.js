'use strict';

import { SCHEMA } from './schema.js';
import { CATEGORIES } from './categories.js';

/* Thin data layer over the D1 binding (env.DB). Everything is async because D1
   is reached over the platform's SQLite service. */

export function riskLabel(score) {
  const n = Number(score) || 0;
  return n >= 70 ? 'High Preservation Risk' : n >= 45 ? 'Moderate Risk' : 'Low Risk';
}

let ready = null;

/* Create tables once per isolate. Category names are the only content seeded;
   heritage records come exclusively from contributors. */
export function ensureSchema(env) {
  if (!ready) {
    ready = init(env).catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

async function init(env) {
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));

  /* Databases created before pins existed need the coordinate columns added. */
  const cols = await env.DB.prepare('PRAGMA table_info(heritage)').all();
  const names = new Set((cols.results || []).map((c) => c.name));
  if (!names.has('lat')) await env.DB.prepare('ALTER TABLE heritage ADD COLUMN lat REAL').run();
  if (!names.has('lng')) await env.DB.prepare('ALTER TABLE heritage ADD COLUMN lng REAL').run();

  const categories = await env.DB.prepare('SELECT COUNT(*) AS c FROM heritage_categories').first();
  if (!categories || !categories.c) {
    await env.DB.batch(
      CATEGORIES.map(([name, description, icon], i) =>
        env.DB.prepare(
          'INSERT OR IGNORE INTO heritage_categories (name, description, icon, sort_order) VALUES (?, ?, ?, ?)'
        ).bind(name, description, icon, i)
      )
    );
  }

  /* One-time cleanup: earlier builds inserted eight sample records with fixed
     ids. They are demo content, so drop them exactly once per database. */
  const purged = await env.DB.prepare("SELECT value FROM app_meta WHERE key = 'demo-purge'").first();
  if (!purged) {
    await env.DB.prepare("DELETE FROM heritage WHERE id LIKE 'seed-%'").run();
    await env.DB.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('demo-purge', datetime('now'))").run();
  }
}

export async function listCategories(env) {
  const { results } = await env.DB.prepare(
    'SELECT name, description, icon FROM heritage_categories WHERE is_active = 1 ORDER BY sort_order ASC, name ASC'
  ).all();
  return results || [];
}

export async function listHeritage(env, { status = 'published', category, region, q } = {}) {
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
    ' ORDER BY created_at DESC, rowid DESC';
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return results || [];
}

export async function getHeritage(env, id) {
  return env.DB.prepare('SELECT * FROM heritage WHERE id = ?').bind(id).first();
}

export async function createHeritage(env, record) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO heritage
       (id, name, category, region, location, lat, lng, description, history, story, tradition,
        people, evidence, risk_score, risk_label, theme, image_url, status, submitted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
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
    )
    .run();
  return getHeritage(env, id);
}

export async function deleteHeritage(env, id) {
  const result = await env.DB.prepare('DELETE FROM heritage WHERE id = ?').bind(id).run();
  return (result.meta && result.meta.changes) > 0;
}

export async function stats(env) {
  const [records, contributors, categories, mapped] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS c FROM heritage WHERE status = 'published'"),
    env.DB.prepare('SELECT COUNT(*) AS c FROM users'),
    env.DB.prepare('SELECT COUNT(*) AS c FROM heritage_categories WHERE is_active = 1'),
    env.DB.prepare("SELECT COUNT(*) AS c FROM heritage WHERE status = 'published' AND lat IS NOT NULL AND lng IS NOT NULL")
  ]);
  const value = (row) => (row && row.results && row.results[0] && row.results[0].c) || 0;
  return {
    records: value(records),
    contributors: value(contributors),
    categories: value(categories),
    mapped: value(mapped)
  };
}
