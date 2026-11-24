'use strict';

/* Meri Virasat API — Cloudflare Worker.
   Serves the REST API under /api/* and everything else from the static asset
   binding (env.ASSETS). Storage is Cloudflare D1 (env.DB). */

import {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  userForToken,
  publicUser,
  sessionTokenFrom,
  sessionCookie,
  clearCookie
} from './auth.js';
import {
  ensureSchema,
  listCategories,
  listHeritage,
  getHeritage,
  createHeritage,
  deleteHeritage,
  stats
} from './db.js';
import { geocodePlace } from './geo.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
/* D1 rejects rows over 1 MB, so inline photos are capped below that. */
const MAX_IMAGE_CHARS = 900_000;
const ALLOWED_STATUS = new Set(['published', 'pending', 'rejected']);

class HttpError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

function sendJson(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

function isSecure(request) {
  return new URL(request.url).protocol === 'https:';
}

function cleanText(value, max = 4000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function toNumber(value, fallback = 50) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/* Coordinates are optional: null means "not pinned". */
function normalizeCoord(value, limit) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
  return Math.round(n * 1e6) / 1e6;
}

function normalizeImage(value) {
  const image = cleanText(value, MAX_IMAGE_CHARS);
  if (!image) return null;
  if (image.startsWith('data:image/')) {
    if (image.length > MAX_IMAGE_CHARS) {
      throw new HttpError('That photo is too large — please choose one under 600 KB.', 413);
    }
    return image;
  }
  if (/^https?:\/\//i.test(image)) return image;
  throw new HttpError('Image must be an uploaded picture or a valid http(s) URL.', 400);
}

async function readJson(request) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError('Request body is too large (max 4 MB).', 413);
  const text = await request.text();
  if (!text) return {};
  if (text.length > MAX_BODY_BYTES) throw new HttpError('Request body is too large (max 4 MB).', 413);
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new HttpError('Invalid JSON body.', 400);
  }
}

async function requireUser(env, request) {
  const user = await userForToken(env, sessionTokenFrom(request));
  if (!user) throw new HttpError('Please sign in to continue.', 401);
  return user;
}

/* ---------------- handlers ---------------- */

async function handleSignup(env, request) {
  const body = await readJson(request);
  const email = cleanText(body.email, 200).toLowerCase();
  const password = String(body.password || '');
  const name = cleanText(body.name, 120) || email.split('@')[0];

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError('Please enter a valid email address.', 400);
  if (password.length < 6) throw new HttpError('Password must be at least 6 characters.', 400);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) throw new HttpError('An account with this email already exists. Try signing in.', 409);

  const total = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first();
  const adminEmail = (env.ADMIN_EMAIL || '').trim().toLowerCase();
  const isAdmin = !total || total.c === 0 || (adminEmail && email === adminEmail) ? 1 : 0;
  const id = crypto.randomUUID();

  await env.DB.prepare('INSERT INTO users (id, email, name, password_hash, is_admin) VALUES (?, ?, ?, ?, ?)')
    .bind(id, email, name, await hashPassword(password), isAdmin)
    .run();

  const token = await createSession(env, id);
  const user = await env.DB.prepare('SELECT id, email, name, is_admin, created_at FROM users WHERE id = ?')
    .bind(id)
    .first();

  return sendJson({ user: publicUser(user) }, 201, {
    'Set-Cookie': sessionCookie(token, { secure: isSecure(request) })
  });
}

async function handleSignin(env, request) {
  const body = await readJson(request);
  const email = cleanText(body.email, 200).toLowerCase();
  const password = String(body.password || '');

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw new HttpError('Email or password is incorrect.', 401);
  }

  const adminEmail = (env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (adminEmail && email === adminEmail && !user.is_admin) {
    await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(user.id).run();
    user.is_admin = 1;
  }

  const token = await createSession(env, user.id);
  return sendJson({ user: publicUser(user) }, 200, {
    'Set-Cookie': sessionCookie(token, { secure: isSecure(request) })
  });
}

async function handleSignout(env, request) {
  await destroySession(env, sessionTokenFrom(request));
  return sendJson({ ok: true }, 200, {
    'Set-Cookie': clearCookie({ secure: isSecure(request) })
  });
}

async function handleMe(env, request) {
  const user = await userForToken(env, sessionTokenFrom(request));
  return sendJson({ user: user || null });
}

async function handleListHeritage(env, request, url) {
  const status = url.searchParams.get('status') || 'published';
  if (status === 'all') {
    const user = await requireUser(env, request);
    if (!user.is_admin) throw new HttpError('Admin access required.', 403);
  }
  const records = await listHeritage(env, {
    status,
    category: url.searchParams.get('category') || undefined,
    region: url.searchParams.get('region') || undefined,
    q: url.searchParams.get('q') || undefined
  });
  return sendJson({ records });
}

async function handleCreateHeritage(env, request) {
  const user = await requireUser(env, request);
  const body = await readJson(request);

  const name = cleanText(body.name, 200);
  const location = cleanText(body.location, 200);
  if (!name) throw new HttpError('Heritage name is required.', 400);
  if (!location) throw new HttpError('Location is required.', 400);

  const description = cleanText(body.description, 4000);
  const status = ALLOWED_STATUS.has(body.status) && user.is_admin ? body.status : 'published';

  /* Use the dropped pin; otherwise look the place up so it still lands on the map. */
  let lat = normalizeCoord(body.lat, 90);
  let lng = normalizeCoord(body.lng, 180);
  if (lat === null || lng === null) {
    const hit = await geocodePlace(location);
    if (hit) {
      lat = hit.lat;
      lng = hit.lng;
    }
  }

  const record = await createHeritage(env, {
    name,
    category: cleanText(body.category, 120) || 'Folk Art',
    region: cleanText(body.region, 60) || 'North',
    location,
    lat,
    lng,
    description,
    history: cleanText(body.history, 4000) || description,
    story: cleanText(body.story, 4000) || description,
    tradition: cleanText(body.tradition, 4000) || description,
    people: cleanText(body.people, 4000) || null,
    evidence: cleanText(body.evidence, 4000) || 'Community-submitted record.',
    risk_score: Math.max(0, Math.min(100, toNumber(body.risk_score, 50))),
    theme: cleanText(body.theme, 40) || 'default',
    image_url: normalizeImage(body.image_url),
    status,
    submitted_by: user.id
  });

  return sendJson({ record }, 201);
}

async function handleDeleteHeritage(env, request, id) {
  const user = await requireUser(env, request);
  const record = await getHeritage(env, id);
  if (!record) throw new HttpError('Heritage record not found.', 404);
  const isOwner = record.submitted_by && record.submitted_by === user.id;
  if (!user.is_admin && !isOwner) {
    throw new HttpError('Only the contributor or an admin can delete this record.', 403);
  }
  await deleteHeritage(env, id);
  return sendJson({ ok: true, id });
}

async function handleGeocode(url) {
  const q = cleanText(url.searchParams.get('q'), 200);
  if (!q) throw new HttpError('Add a place name to search.', 400);
  const hit = await geocodePlace(q);
  if (!hit) return sendJson({ found: false });
  return sendJson({ found: true, lat: hit.lat, lng: hit.lng, display_name: hit.display_name });
}

/* ---------------- routing ---------------- */

async function handleApi(env, request, url) {
  const path = url.pathname;
  const method = request.method;

  if (method === 'GET' && path === '/api/health') {
    const counts = await stats(env);
    return sendJson({ ok: true, service: 'meri-virasat-api', runtime: 'cloudflare-workers', records: counts.records });
  }
  if (method === 'GET' && path === '/api/stats') return sendJson(await stats(env));
  if (method === 'GET' && path === '/api/categories') return sendJson({ categories: await listCategories(env) });
  if (method === 'GET' && path === '/api/geocode') return handleGeocode(url);
  if (method === 'GET' && path === '/api/heritage') return handleListHeritage(env, request, url);
  if (method === 'POST' && path === '/api/heritage') return handleCreateHeritage(env, request);
  if (method === 'GET' && path === '/api/auth/me') return handleMe(env, request);
  if (method === 'POST' && path === '/api/auth/signup') return handleSignup(env, request);
  if (method === 'POST' && path === '/api/auth/signin') return handleSignin(env, request);
  if (method === 'POST' && path === '/api/auth/signout') return handleSignout(env, request);

  const match = path.match(/^\/api\/heritage\/([^/]+)$/);
  if (method === 'DELETE' && match) return handleDeleteHeritage(env, request, decodeURIComponent(match[1]));

  return sendJson({ error: 'Unknown API route.' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith('/api/')) {
        if (!env.DB) {
          return sendJson({ error: 'Database is not configured for this deployment yet.' }, 503);
        }
        await ensureSchema(env);
        return await handleApi(env, request, url);
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return sendJson({ error: 'Method not allowed.' }, 405);
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      if (status >= 500) console.error('API error:', err && err.stack ? err.stack : err);
      return sendJson({ error: (err && err.message) || 'Something went wrong.' }, status);
    }
  }
};
