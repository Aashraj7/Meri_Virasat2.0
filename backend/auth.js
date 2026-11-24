'use strict';

const crypto = require('node:crypto');
const { db } = require('./db');

const SESSION_TTL_DAYS = 30;
const COOKIE_NAME = 'mv_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, salt, expected] = String(stored).split(':');
    if (scheme !== 'scrypt' || !salt || !expected) return false;
    const actual = crypto.scryptSync(password, salt, 64);
    const expectedBuf = Buffer.from(expected, 'hex');
    return actual.length === expectedBuf.length && crypto.timingSafeEqual(actual, expectedBuf);
  } catch (_) {
    return false;
  }
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return { token, expires };
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function userForToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.is_admin, u.created_at, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(token);
    return null;
  }
  return publicUser(row);
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    is_admin: !!row.is_admin,
    created_at: row.created_at
  };
}

function parseCookies(header = '') {
  return header.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    acc[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    return acc;
  }, {});
}

function sessionTokenFrom(req) {
  return parseCookies(req.headers.cookie || '')[COOKIE_NAME] || null;
}

function sessionCookie(token, { secure = false, maxAgeSeconds = SESSION_TTL_DAYS * 86400 } = {}) {
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

function clearCookie({ secure = false } = {}) {
  return sessionCookie('', { secure, maxAgeSeconds: 0 });
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  userForToken,
  publicUser,
  sessionTokenFrom,
  sessionCookie,
  clearCookie
};
