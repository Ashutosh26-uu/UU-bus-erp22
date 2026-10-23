# UU Bus ERP

A secure, proxy-proof **QR boarding system** for a fleet of **19 college buses**.

Every bus has **its own portal** (`/bus/1` … `/bus/19`), **its own rotating QR code** and
**its own incharge login**. The incharge opens the bus portal; it shows a QR that changes every
20 seconds. Each student scans it with their **own phone**, types their name and student ID,
sees their record (course, year, specialization, stop) and taps **Done**. The bus portal and
the admin dashboard update **instantly** with the student's name and the running count.

This is deliberately **not** an attendance register: it only records who boarded which trip.

---

## Quick start (local / same Wi-Fi)

Requirements: **Node.js 22.13 or newer** (uses the built-in SQLite, no native modules).

```bash
npm install
npm run seed:buses    # the 19 buses, their stops and 19 incharge accounts (real setup)
npm run seed:demo     # same, plus ~6 demo students per bus (for trying it out)
npm start
```

Then open <http://localhost:3000>.

* First run creates the **admin** account and prints its one-time password in the console
  (also saved to `data/initial-admin.txt`; delete that file after signing in). You are forced
  to set a new password at first sign-in.
* The seed creates **19 incharge accounts** `incharge1` … `incharge19`, one per bus, with
  temporary passwords printed to the console and saved to `data/incharge-accounts.txt`.
  Hand each incharge their line; they must change the password at first sign-in and then land
  on their own bus portal. Delete the file once distributed.
* The console also prints the **Network** address, e.g. `http://192.168.1.10:3000`. That is
  what the QR codes encode, so student phones must be able to reach it (same Wi-Fi).
  Change it any time from **Admin → Settings**, or set `BASE_URL` in `.env`.

Useful scripts:

| Command | What it does |
| --- | --- |
| `npm start` | run the server |
| `npm run dev` | run with auto-restart on file changes |
| `npm run seed:buses` | create the 19-bus fleet: buses, stops, one incharge account per bus |
| `npm run seed:demo` | the fleet plus demo students (about 6 per bus) |
| `npm run reset-admin` | reset the admin password if it is lost |
| `npm run backup` | consistent copy of the database into `data/backups/` |
| `npm run test:security` | end-to-end test of every security and portal rule against a running server |
| `npm run serve:function` | run the Vercel serverless function locally on port 3001 |

---

## The 19 bus portals

| What | Where | Who can open it |
| --- | --- | --- |
| Bus N portal (QR screen, live count, manual check-in, end trip) | `/bus/N` | the incharge assigned to bus N, or an admin |
| Portal picker (all 19 buses with live status) | `/incharge` | admins and incharges with no assigned bus |
| Bus N student link (what the QR encodes) | `/checkin/N?t=<rotating token>` | any phone that scanned bus N's live QR |
| Admin console | `/admin` | admins |

* An incharge signs in and is taken straight to their own portal. Opening another bus's
  portal bounces them back to theirs; the API refuses it too (`WRONG_BUS_PORTAL`).
* Each portal's QR is unique to that bus: the token is tied to the bus's running trip, the
  link carries the bus number, and a bus 12 token presented on the bus 7 link is rejected.
* The fleet is defined in `scripts/fleet.js` (numbers, names, routes, stops). Everything can be
  renamed or reassigned later from **Admin → Buses & stops** and **Admin → Staff**; the
  portal URL follows the bus number.

---

## How it works

```
 Bus screen (incharge, signed in)        Student phone (no login)            Admin console
 ┌──────────────────────────────┐        ┌──────────────────────────┐        ┌───────────────────┐
 │ Start trip → rotating QR     │ scan   │ /checkin?t=<token>       │        │ live tiles, feed, │
 │ token = tripId.slot.HMAC     │ ─────► │ token → private session  │        │ trip cards, flags │
 │ new token every 20 s         │        │ name + ID → record shown │        │ students, buses,  │
 │ live count + names (SSE)     │ ◄───── │ Done → check-in recorded │ ─────► │ staff, trips,     │
 └──────────────────────────────┘ event  └──────────────────────────┘ event  │ audit, settings   │
                                                                             └───────────────────┘
```

1. **Incharge** signs in, lands on their bus portal, picks the direction (to / from college)
   and presses *Start trip*.
2. The portal shows the bus's QR with a countdown ring. The QR encodes `/checkin/<bus>` with a
   token that is an HMAC of the trip's secret and the current 20-second time slot.
3. **Student** scans with the normal camera app. The server validates the token, opens a
   5-minute check-in session bound to that phone, and asks for name + student ID.
4. Both must match the database record. Everything shown (course, year, specialization, stop,
   bus) comes from the server; the phone cannot change it.
5. **Done** writes the check-in atomically and sends it to the incharge screen and every admin
   dashboard: instantly over Server-Sent Events on a single server, or within ~2.5 s by polling
   on Vercel. The counter animates, the name appears, a flag
   is shown if anything is unusual.
6. **End trip** closes the trip; the QR and all pending sessions die immediately.

---

## Anti-proxy design (why nobody can "mark" for a friend)

| Threat | Defence |
| --- | --- |
| Screenshot / forwarded QR | Token rotates every 20 s and is accepted for at most 40 s. Old, tampered or future tokens are rejected. Only the live screen works. |
| Friend scans and types your ID | **One phone, one student.** The phone is identified by a signed HttpOnly cookie mirrored in localStorage; the first student who boards with a phone owns it. Another student on that phone is refused. A phone can board only one student per trip. |
| Student uses many phones | Max 2 phones per student per 30 days; after that admin must reset devices (Students → history). First boarding from a new phone is flagged **new_device**. |
| Boarding the wrong bus | Allowed (students do switch buses) but flagged **wrong_bus**; the incharge sees it live. |
| Guessing IDs | Name **and** ID must match; the error never says which was wrong. 6 attempts per scan, then a fresh scan is needed. Generous per-network rate limits (campus NAT friendly). |
| Double check-in | Database unique constraint per (trip, student) and per (trip, phone). |
| Staff account attacks | scrypt password hashing, constant-time checks, 5-strike 15-minute lockout, temporary passwords that must be changed, session ids stored hashed, sessions expire after 12 h idle / 7 days max. |
| CSRF / cross-site | SameSite cookies + per-session CSRF token + Origin check on every state-changing call. |
| XSS / injection | Strict Content-Security-Policy (no inline scripts or styles, same-origin only), all output escaped, all SQL parameterised, input validated with zod. |
| Tampering by staff | Manual check-ins are flagged **manual** with the staff name and reason; every admin action is in the audit log. |

What it cannot do: it cannot see whether the phone is physically on the bus. For that, the
incharge is in the loop: names appear live, flagged entries stand out, and the "not boarded yet"
list shows who is still missing.

---

## Configuration (`.env`)

Copy `.env.example` to `.env`. Everything is optional.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | where to listen |
| `BASE_URL` | auto (LAN IP) | public address encoded in QR codes, e.g. `https://bus.college.edu` |
| `NODE_ENV` | `development` | set `production` when deployed |
| `TRUST_PROXY` | off | set `1` behind nginx / Cloudflare so real IPs are logged and limited |
| `SESSION_SECRET` | generated once into `data/secret.key` | signing key for sessions, device ids and QR tokens |
| `SESSION_HOURS` | `12` | staff session idle lifetime |
| `QR_ROTATE_SECONDS` | `20` | QR refresh interval (minimum 10) |
| `QR_GRACE_SLOTS` | `1` | how many previous QR windows are still valid |
| `CHECKIN_MINUTES` | `5` | time a student has to finish after scanning |
| `MAX_DEVICES_PER_STUDENT` | `2` | phones a student may use in 30 days |
| `COOKIE_SECURE` | auto | force the `Secure` cookie flag (auto on when `BASE_URL` is https, always on Vercel) |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | unset (local SQLite file) | use a Turso database instead of `data/bus-erp.sqlite`; required on Vercel |
| `ADMIN_PASSWORD` | unset | password for the first `admin` account (on Vercel the only way to create it without seeding) |
| `LIVE_MODE` | `sse` locally, `poll` on Vercel | how screens get live updates |
| `RATE_LIMIT_STORE` | `memory` locally, `db` on Vercel | where login / scan throttles are counted |
| `SERVERLESS` | auto (`VERCEL` is set) | force serverless behaviour, e.g. for `npm run serve:function` |

---

## Deploy on Vercel

Students board on **mobile data**, so production needs a public HTTPS address. The repo is
ready for Vercel: `api/index.js` runs the whole app as one serverless function, `public/` is
served from Vercel's CDN, and functions are pinned to Mumbai (`bom1`) in `vercel.json`.

Serverless functions have no disk that survives between requests, so on Vercel the data lives
in **Turso**, a hosted database that speaks the same SQLite dialect (nothing in the app changes).
Live updates switch automatically from push to **polling every ~2.5 s**, and login / scan
throttles are shared through the database so every function instance enforces the same limits.

**1. Create the project**

1. Go to <https://vercel.com/new>, sign in with GitHub and import `Ashutosh26-uu/UU-bus-erp22`.
   The framework preset comes from `vercel.json` ("Other"); there is no build step.
2. Before the first deploy, add an environment variable `SESSION_SECRET` with a long random
   value. Generate one with:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```
   Keep it stable: changing it signs everyone out and invalidates running QR codes.

**2. Connect a Turso database**

In the Vercel project open **Storage → Create / Browse Marketplace → Turso**, create a database
(pick the **Mumbai / ap-south-1** region, next to the functions) and connect it to the project.
That adds `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. Then **redeploy** (Deployments → ⋯ →
Redeploy) so the function picks them up. Until both variables exist, every page shows a short
"Finish the server setup" checklist instead of failing.

**3. Create the 19 buses and accounts in Turso** (from your computer, once)

```bash
npx vercel link
npx vercel env pull .env.vercel --environment production
set -a; . ./.env.vercel; set +a; npm run seed:buses
```

`vercel env pull` writes the Turso URL and token into `.env.vercel` (git-ignored). It is
deliberately not `.env`: the app reads `.env` on every local start, so production settings
there would make your laptop write to the live database. The third line loads them only for
the seed (Git Bash / macOS / Linux syntax), which then creates the 19 buses, their stops,
`admin` and `incharge1` … `incharge19` directly in Turso.
The passwords are printed and saved to `data/turso-initial-admin.txt` and
`data/turso-incharge-accounts.txt` (separate from your local files). Instead of seeding you can
set `ADMIN_PASSWORD` on Vercel: the first request then creates `admin` with that password.

**4. Use it**

Open `https://<your-project>.vercel.app`, sign in as `admin`, change the password, import the
students (Admin → Students → Import CSV), and give each incharge their line. QR codes use the
production domain automatically; add a custom domain under Settings → Domains and it is picked
up the same way (or set it in Admin → Settings → Public base URL).

Good to know:

* **Plan.** Vercel's free Hobby plan is meant for personal, non-commercial projects. For the
  college's official system use **Pro**. Polling means each open bus screen makes about one
  request every 2.5 s, roughly 1 million function calls a month for 19 buses boarding about an
  hour a day. Check current limits on <https://vercel.com/pricing> and <https://turso.tech/pricing>.
* **Preview deployments** get the same variables unless you scope them. Scope the Turso
  variables to **Production** if previews must not touch real data.
* **CSV imports** are limited to about 4 MB per file on Vercel (≈ 30,000 students); split
  bigger files.
* **Backups.** Turso keeps point-in-time history; `turso db export` gives a local copy.

**Try serverless mode locally first** (optional): with the Turso variables in `.env`,
`SERVERLESS=1 npm run serve:function` runs the exact Vercel function on
<http://localhost:3001>.

## Other hosting

* **A college server / VPS** – `npm start` under a process manager
  (`pm2 start npm --name bus-erp -- start`) behind nginx or Caddy with HTTPS, set
  `BASE_URL=https://your-domain`, `NODE_ENV=production`, `TRUST_PROXY=1`. Uses the local
  SQLite file with instant push updates; back up `data/` with `npm run backup`.
* **Render / Railway / Fly.io** – same as a VPS with a persistent disk mounted at `data/`, or
  point `TURSO_DATABASE_URL` at Turso and skip the disk.
* **Quick public test from a laptop** – `cloudflared tunnel --url http://localhost:3000` or
  `ngrok http 3000`, then put the https URL in **Admin → Settings → Public base URL**.

---

## Importing students

**Admin → Students → Import CSV**. Header row required, column names are flexible:

```csv
uuid,name,course,year,specialization,bus,stop,phone
UU2023CS0142,Aditi Sharma,B.Tech,2nd,CSE (AI & ML),12,Rajpur Road,9876543210
```

* `uuid` can also be called `id`, `enrollment`, `roll no`, `reg no` …
* `bus` is the bus number (1–19); unknown buses and stops are created automatically.
* Existing IDs are updated, not duplicated. Export from the same page gives you the full list.

---

## Roles

* **Admin** – dashboard, students, buses & stops, staff accounts, trips, flags, audit log,
  settings, device resets. Can open any of the 19 bus portals.
* **Bus incharge** – one account per bus; signs in straight into their own bus portal, starts
  and ends that bus's trips, sees the live list, can mark a student manually with a reason.
  Cannot open another bus's portal.
* **Student** – no account, no app, no login. Scan, confirm, done.

---

## Project layout

```
api/index.js         Vercel serverless entry (exports the Express app)
vercel.json          Vercel config: static output, function settings, Mumbai region, rewrites
src/
  app.js             Express app: security headers, setup gate, routes, error handling
  server.js          long-running server for `npm start` (listen, timers, graceful shutdown)
  config.js          env, serverless detection, LAN detection
  db.js              async DB layer: node:sqlite locally or Turso/libSQL, migrations, housekeeping
  security.js        scrypt, HMAC, signed values, name/ID normalisation
  middleware/        session auth + CSRF, device identity, rate limits (memory or DB-shared)
  services/          rotating QR tokens, trips, check-ins (anti-proxy rules), live events, audit, CSV
  routes/            /api/auth, /api/admin, /api/incharge, /api/checkin
views/               login, admin, incharge, checkin, 404 pages
public/              css, js (vanilla ES modules, no build step), icons
scripts/             fleet (the 19 buses), seed-buses, seed-demo, reset-admin, backup,
                     security-test, serve-function (run the Vercel function locally)
data/                local database, secret key, credentials, backups (git-ignored)
```

---

## Troubleshooting

* **Phones say "site can't be reached"** – they are not on the same network as the server, or
  the QR address is wrong. Check **Admin → Settings**; use a public HTTPS address for mobile data.
* **"QR code expired" on every scan** – the bus-screen device and the server clocks are not the
  issue (tokens are server-generated); the student took longer than 40 s between the scan and
  the page opening. Keep the camera on the screen until the page loads.
* **Student blocked: "phone linked to someone else"** – that phone was first used by another
  student. Either use the right phone or have the incharge mark them manually.
* **Lost admin password** – `npm run reset-admin`.
* **Windows prints an ExperimentalWarning about SQLite** – harmless; the npm scripts already
  silence it.
