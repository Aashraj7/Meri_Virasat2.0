# Deploying Meri Virasat

The site is a static page (`index.html`) plus a JSON API for accounts and
heritage records. It ships with **two interchangeable backends** that use the
same `/api` contract, so the frontend does not care which one is running:

| | Runtime | Storage | Best for |
|---|---|---|---|
| **A. Cloudflare Workers + D1** (recommended, already deployed) | Worker | D1 (managed SQLite) | Free/cheap hosting, no server to maintain, scales to zero |
| **B. Node + SQLite** (`backend/`) | Node ≥ 22.5 | local SQLite file | VPS, Render/Railway/Fly, self-hosting |

Both are already in this repo. Nothing in `index.html` needs to change between
them — it always calls the API on its own origin.

The site ships with **no sample heritage records**. A fresh database contains
only the 20-category catalog; every record, count and map pin comes from people
who submit through the form.

---

## A. Cloudflare Workers + D1 (live now)

### URLs

- Preview: https://meri-virasat-ejvrx4-preview.freebuff.site
- Production: https://meri-virasat-ejvrx4.freebuff.site (created, not yet published)

### How it is put together

```
index.html            the site (API calls, Leaflet map, add-record form)
worker/index.js       router: /api/* -> handlers, everything else -> static assets
worker/auth.js        PBKDF2 password hashing + session cookies (Web Crypto)
worker/db.js          D1 queries + lazy schema bootstrap
worker/schema.js      CREATE TABLE statements
worker/categories.js  the 20 starter categories (no heritage records)
worker/geo.js         place -> coordinates via OpenStreetMap Nominatim
wrangler.jsonc        local dev + build config (D1 binding "DB", assets binding "ASSETS")
scripts/build-worker.mjs  builds dist/index.js (bundle) + build/public (assets)
deploy.json           manifest used by the hosting platform
```

- **Schema is applied by the Worker itself** on the first request to a fresh
  database (`CREATE TABLE IF NOT EXISTS`), so a new environment needs no
  migration step. Missing `lat`/`lng` columns are added on start-up for
  databases created by older builds.
- **Passwords** are PBKDF2-SHA256 (100k iterations, per-user salt). Sessions are
  30-day `HttpOnly`, `SameSite=Lax`, `Secure` cookies; only a SHA-256 digest of
  the token is stored in D1.
- **Photos** are stored inline with the record as data URLs. D1 caps a row at
  1 MB, so uploads are limited to **600 KB** (enforced in the browser and in the API).

### Live counts

`/api/stats` returns `{ records, contributors, categories, mapped }`, computed
with `COUNT(*)` on every request. The hero counters and the admin list re-read
it after each submission or deletion, so the numbers always match the database —
nothing is hard-coded.

### The map

The map is [Leaflet](https://leafletjs.com) with OpenStreetMap tiles (no API key,
no account). Each record is a marker coloured by its risk score; clicking one
opens the record. A record's pin comes from:

1. the pin dropped in the form's *Location* step (sent as `lat`/`lng`), or
2. if no pin was dropped, the server looks the location text up once through
   Nominatim and stores the coordinates with the record.

`GET /api/geocode?q=<place>` is the same lookup exposed to the form's
“Find from location text” button. Nominatim is a free public service: keep its
[usage policy](https://operations.osmfoundation.org/policies/nominatim/) in mind
(one request per second, no bulk scraping). Worker responses are cached at the
edge for a day and the Node backend caches in memory. Map tiles and geocoding
are attributed to OpenStreetMap as the licence requires.

### First admin

The **first account that signs up becomes the admin** (admin can see non-published
records and delete anyone's). Sign up at the site before sharing the URL. To pin
admin to a specific address instead, set an `ADMIN_EMAIL` variable in the hosting
dashboard's environment/secrets, then sign in with that address once.

### Publishing the production environment

The production database (`DB`) is already provisioned, so going live is one step:

1. Open **Sites → Meri Virasat** in Freebuff.
2. Click **Publish** for the *production* environment (or ask me to deploy and
   publish it).

Publishing starts from that environment's saved deployment; the production
database starts empty, so its first signup becomes the production admin.

Then add a custom domain in the same panel (**Domains**) and point its DNS
records at the host it shows you.

### Redeploying after edits

```bash
npm run build            # rebuild dist/index.js + build/public
```

Then press **Publish** / **Deploy** in the Sites panel again with `deploy.json`.
Build output (`build/`, `dist/`, `.wrangler/`) is git-ignored and rebuilt by that
command.

### Removing old demo records

Builds before the community-only version inserted eight sample records with ids
`seed-1` … `seed-8`. On the first request after upgrading, each database purges
them once and records a `demo-purge` marker in `app_meta`, so contributors'
records are never touched.

---

## B. Node + SQLite (`backend/`)

Use this when you want to own the machine (VPS, Docker, Render/Railway/Fly). The
only hard requirement is **a persistent disk for the database** — an
ephemeral filesystem loses every account and submission on restart.

```bash
npm start                  # http://localhost:3000
```

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port (hosts usually inject this) |
| `HOST` | `0.0.0.0` | bind address |
| `MV_DATA_DIR` | `backend/data` | directory holding `meri-virasat.db` |
| `ADMIN_EMAIL` | _(unset)_ | address that is always admin |

`node:sqlite` is built into Node 22.5+, so there is **no dependency install** for
the API itself. Geocoding uses the global `fetch` of Node 22. On a host:

1. Create a **Web Service** from this repo, start command `npm start`, Node 22+.
2. Attach a **persistent volume/disk** (1 GB is plenty) and set
   `MV_DATA_DIR` to a folder on it, e.g. `/var/data`.
3. Set `NODE_ENV=production`; the server serves the site and the API from the
   same origin, so no CORS setup is needed.
4. Back up `meri-virasat.db` (plus `-wal`/`-shm`) on a schedule — that file *is*
   your data.

GitHub Pages can no longer host this: it serves static files only and cannot run
the API.

---

## Local development

```bash
npm install          # only needed for Wrangler (the API itself has no deps)

# Cloudflare flavour, exactly like production
npm run build && npx wrangler dev     # http://localhost:8787

# Node flavour
npm start                             # http://localhost:3000
```

`npx wrangler dev` keeps its local D1 file under `.wrangler/state`; delete that
folder for a clean database.

---

## API reference (identical for both backends)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{ ok, service, runtime?, records }` |
| GET | `/api/stats` | `{ records, contributors, categories, mapped }` |
| GET | `/api/categories` | `{ categories }` |
| GET | `/api/geocode?q=` | `{ found, lat?, lng?, display_name? }` |
| GET | `/api/heritage?status=published` | `{ records }`; `status=all` needs admin |
| POST | `/api/heritage` | signed in; `{ name, location, lat?, lng?, … }` → `{ record }` |
| DELETE | `/api/heritage/:id` | owner or admin |
| GET | `/api/auth/me` | `{ user \| null }` |
| POST | `/api/auth/signup` | `{ email, password, name }` |
| POST | `/api/auth/signin` | `{ email, password }` |
| POST | `/api/auth/signout` | clears the cookie |

`lat`/`lng` are optional on `POST /api/heritage`: omit them (or send `null`) and
the server geocodes `location` instead.

If the API is unreachable the page still renders, but lists are empty and
sign-in/submission show an error — the marketing page never breaks.

## Known limitations

- Photos are inline data URLs (600 KB cap). Moving to R2 object storage would
  allow larger images and smaller rows.
- No password reset or email verification yet; an admin has to re-create an
  account if someone loses their password.
- Geocoding depends on the public Nominatim service. If it is rate-limited or
  down, a record is still saved — it just has no pin until someone sets one.
- `/api/health` reports `runtime: "cloudflare-workers"` only on the Worker.
