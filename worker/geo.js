'use strict';

/* Turns a free-text place ("Purulia, West Bengal") into coordinates using the
   OpenStreetMap Nominatim service. No API key is needed; the usage policy asks
   for an identifying User-Agent and modest request rates, so responses are
   cached at the edge for a day. */

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'MeriVirasat/2.0 (community heritage map; https://merivirasat.in)';

export async function geocodePlace(query) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return null;

  const url = `${ENDPOINT}?format=jsonv2&limit=1&addressdetails=0&q=${encodeURIComponent(q)}`;

  let response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'Accept-Language': 'en'
      },
      cf: { cacheTtl: 86400, cacheEverything: true }
    });
  } catch (_) {
    return null;
  }
  if (!response.ok) return null;

  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows) || !rows.length) return null;

  const lat = Number(rows[0].lat);
  const lng = Number(rows[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return { lat, lng, display_name: String(rows[0].display_name || q).slice(0, 300) };
}
