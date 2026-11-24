'use strict';

/* Password hashing + sessions on the Web Crypto API (no Node built-ins, works
   in workerd). Password hashes are PBKDF2-SHA256; only a SHA-256 digest of the
   session token is stored, so a leaked database cannot be replayed. */

const SESSION_TTL_DAYS = 30;
export const COOKIE_NAME = 'mv_session';
const PBKDF2_ITERATIONS = 100_000;
const encoder = new TextEncoder();

function toHex(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  );
  return toHex(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2:${PBKDF2_ITERATIONS}:${toHex(salt)}:${hash}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, iterations, saltHex, expected] = String(stored || '').split(':');
    if (scheme !== 'pbkdf2' || !saltHex || !expected) return false;
    const actual = await pbkdf2(password, fromHex(saltHex), Number(iterations) || PBKDF2_ITERATIONS);
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i += 1) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  } catch (_) {
    return false;
  }
}

async function digest(token) {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(token)));
}

export async function createSession(env, userId) {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 864e5).toISOString();
  await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await digest(token), userId, expires)
    .run();
  return token;
}

export async function destroySession(env, token) {
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(await digest(token)).run();
}

export async function userForToken(env, token) {
  if (!token) return null;
  const hash = await digest(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.is_admin, u.created_at, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`
  )
    .bind(hash)
    .first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(hash).run();
    return null;
  }
  return publicUser(row);
}

export function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    is_admin: !!row.is_admin,
    created_at: row.created_at
  };
}

export function parseCookies(header = '') {
  return header.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) return acc;
    try {
      acc[key] = decodeURIComponent(value);
    } catch (_) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

export function sessionTokenFrom(request) {
  return parseCookies(request.headers.get('Cookie') || '')[COOKIE_NAME] || null;
}

export function sessionCookie(token, { secure = false, maxAgeSeconds = SESSION_TTL_DAYS * 86400 } = {}) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie({ secure = false } = {}) {
  return sessionCookie('', { secure, maxAgeSeconds: 0 });
}
