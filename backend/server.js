'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const store = require('./db');
const auth = require('./auth');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, '..');
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ALLOWED_STATUS = new Set(['published', 'pending', 'rejected']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large (max 8 MB).'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function isSecure(req) {
  return req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
}

function requireUser(req) {
  const user = auth.userForToken(auth.sessionTokenFrom(req));
  if (!user) throw Object.assign(new Error('Please sign in to continue.'), { status: 401 });
  return user;
}

function cleanText(value, max = 4000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function toNumber(value, fallback = 50) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isValidHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

function normalizeImage(value) {
  const image = cleanText(value, 3_000_000);
  if (!image) return null;
  if (image.startsWith('data:image/')) {
    if (image.length > 2_600_000) {
      throw Object.assign(new Error('Image is too large — please choose one under 2 MB.'), { status: 413 });
    }
    return image;
  }
  if (isValidHttpUrl(image)) return image;
  throw Object.assign(new Error('Image must be an uploaded picture or a valid http(s) URL.'), { status: 400 });
}

function normalizeCoord(value, limit) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
  return Math.round(n * 1e6) / 1e6;
}

/* Place search via OpenStreetMap Nominatim (no API key). Cached in memory so
   repeat submissions of the same village do not hit the public service again. */
const geocodeCache = new Map();

async function geocodePlace(query) {
  const q = cleanText(query, 200);
  if (!q) return null;
  const key = q.toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=0&q=${encodeURIComponent(q)}`;
  let rows;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'MeriVirasat/2.0 (community heritage map; https://merivirasat.in)',
        Accept: 'application/json',
        'Accept-Language': 'en'
      }
    });
    if (!res.ok) return null;
    rows = await res.json();
  } catch (_) {
    return null;
  }

  if (!Array.isArray(rows) || !rows.length) return null;
  const lat = Number(rows[0].lat);
  const lng = Number(rows[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const hit = { lat, lng, display_name: String(rows[0].display_name || q).slice(0, 300) };
  if (geocodeCache.size > 500) geocodeCache.clear();
  geocodeCache.set(key, hit);
  return hit;
}

/* ---------------- API handlers ---------------- */

async function handleSignup(req, res) {
  const body = await readJson(req);
  const email = cleanText(body.email, 200).toLowerCase();
  const password = String(body.password || '');
  const name = cleanText(body.name, 120) || email.split('@')[0];

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('Please enter a valid email address.'), { status: 400 });
  if (password.length < 6) throw Object.assign(new Error('Password must be at least 6 characters.'), { status: 400 });

  const existing = store.db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) throw Object.assign(new Error('An account with this email already exists. Try signing in.'), { status: 409 });

  const totalUsers = store.db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const isAdmin = totalUsers === 0 || (ADMIN_EMAIL && email === ADMIN_EMAIL) ? 1 : 0;
  const id = crypto.randomUUID();

  store.db
    .prepare('INSERT INTO users (id, email, name, password_hash, is_admin) VALUES (?, ?, ?, ?, ?)')
    .run(id, email, name, auth.hashPassword(password), isAdmin);

  const { token } = auth.createSession(id);
  const user = store.db.prepare('SELECT id, email, name, is_admin, created_at FROM users WHERE id = ?').get(id);
  res.setHeader('Set-Cookie', auth.sessionCookie(token, { secure: isSecure(req) }));
  return sendJson(res, 201, { user: auth.publicUser(user) });
}

async function handleSignin(req, res) {
  const body = await readJson(req);
  const email = cleanText(body.email, 200).toLowerCase();
  const password = String(body.password || '');

  const user = store.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    throw Object.assign(new Error('Email or password is incorrect.'), { status: 401 });
  }

  if (ADMIN_EMAIL && email === ADMIN_EMAIL && !user.is_admin) {
    store.db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
    user.is_admin = 1;
  }

  const { token } = auth.createSession(user.id);
  res.setHeader('Set-Cookie', auth.sessionCookie(token, { secure: isSecure(req) }));
  return sendJson(res, 200, { user: auth.publicUser(user) });
}

function handleSignout(req, res) {
  auth.destroySession(auth.sessionTokenFrom(req));
  res.setHeader('Set-Cookie', auth.clearCookie({ secure: isSecure(req) }));
  return sendJson(res, 200, { ok: true });
}

function handleMe(req, res) {
  const user = auth.userForToken(auth.sessionTokenFrom(req));
  return sendJson(res, 200, { user: user || null });
}

function handleCategories(res) {
  return sendJson(res, 200, { categories: store.listCategories() });
}

function handleStats(res) {
  return sendJson(res, 200, store.stats());
}

function handleHealth(res) {
  return sendJson(res, 200, {
    ok: true,
    service: 'meri-virasat-api',
    records: store.stats().records
  });
}

function handleListHeritage(url, req, res) {
  const status = url.searchParams.get('status') || 'published';
  if (status === 'all') requireUser(req).is_admin || (() => { throw Object.assign(new Error('Admin access required.'), { status: 403 }); })();
  return sendJson(res, 200, {
    records: store.listHeritage({
      status,
      category: url.searchParams.get('category') || undefined,
      region: url.searchParams.get('region') || undefined,
      q: url.searchParams.get('q') || undefined
    })
  });
}

async function handleGeocode(url, res) {
  const q = cleanText(url.searchParams.get('q'), 200);
  if (!q) return sendJson(res, 400, { error: 'Add a place name to search.' });
  const hit = await geocodePlace(q);
  if (!hit) return sendJson(res, 200, { found: false });
  return sendJson(res, 200, { found: true, lat: hit.lat, lng: hit.lng, display_name: hit.display_name });
}

async function handleCreateHeritage(req, res) {
  const user = requireUser(req);
  const body = await readJson(req);

  const name = cleanText(body.name, 200);
  const location = cleanText(body.location, 200);
  if (!name) throw Object.assign(new Error('Heritage name is required.'), { status: 400 });
  if (!location) throw Object.assign(new Error('Location is required.'), { status: 400 });

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

  const record = store.createHeritage({
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

  return sendJson(res, 201, { record });
}

function handleDeleteHeritage(id, req, res) {
  const user = requireUser(req);
  const record = store.getHeritage(id);
  if (!record) throw Object.assign(new Error('Heritage record not found.'), { status: 404 });
  const isOwner = record.submitted_by && record.submitted_by === user.id;
  if (!user.is_admin && !isOwner) {
    throw Object.assign(new Error('Only the contributor or an admin can delete this record.'), { status: 403 });
  }
  store.deleteHeritage(id);
  return sendJson(res, 200, { ok: true, id });
}

/* ---------------- static files ---------------- */

function serveStatic(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.join(ROOT, relative);
  const resolved = path.resolve(filePath);

  if (!resolved.startsWith(ROOT + path.sep) || relative.startsWith('backend' + path.sep) || relative.startsWith('backend/')) {
    return sendJson(res, 404, { error: 'Not found.' });
  }

  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) {
      return sendJson(res, 404, { error: 'Not found.' });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': resolved.endsWith('.html') ? 'no-cache' : 'public, max-age=3600'
    });
    fs.createReadStream(resolved).pipe(res);
  });
}

/* ---------------- server ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const method = req.method || 'GET';

  try {
    if (pathname.startsWith('/api/')) {
      if (method === 'GET' && pathname === '/api/health') return handleHealth(res);
      if (method === 'GET' && pathname === '/api/stats') return handleStats(res);
      if (method === 'GET' && pathname === '/api/categories') return handleCategories(res);
      if (method === 'GET' && pathname === '/api/geocode') return await handleGeocode(url, res);
      if (method === 'GET' && pathname === '/api/heritage') return handleListHeritage(url, req, res);
      if (method === 'POST' && pathname === '/api/heritage') return await handleCreateHeritage(req, res);
      if (method === 'GET' && pathname === '/api/auth/me') return handleMe(req, res);
      if (method === 'POST' && pathname === '/api/auth/signup') return await handleSignup(req, res);
      if (method === 'POST' && pathname === '/api/auth/signin') return await handleSignin(req, res);
      if (method === 'POST' && pathname === '/api/auth/signout') return handleSignout(req, res);

      const deleteMatch = pathname.match(/^\/api\/heritage\/([^/]+)$/);
      if (method === 'DELETE' && deleteMatch) return handleDeleteHeritage(deleteMatch[1], req, res);

      return sendJson(res, 404, { error: 'Unknown API route.' });
    }

    if (method !== 'GET' && method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Method not allowed.' });
    }
    return serveStatic(pathname, res);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    return sendJson(res, status, { error: err.message || 'Something went wrong.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Meri Virasat running at http://localhost:${PORT}`);
  if (ADMIN_EMAIL) console.log(`Admin account: ${ADMIN_EMAIL}`);
});
