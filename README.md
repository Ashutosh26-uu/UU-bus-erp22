# UU Bus ERP

A secure, proxy-proof **QR boarding system** for college buses.

The bus incharge opens the bus screen; it shows a QR code that changes every 20 seconds.
Each student scans it with their **own phone**, types their name and student ID, sees their
record (course, year, specialization, stop) and taps **Done**. The incharge's screen and the
admin dashboard update **instantly** with the student's name and the running count.

This is deliberately **not** an attendance register: it only records who boarded which trip.

---

## Quick start (local / same Wi-Fi)

Requirements: **Node.js 22.13 or newer** (uses the built-in SQLite, no native modules).

```bash
npm install
npm run seed:demo     # optional: 3 buses, 2 incharges, 45 students
npm start
```

Then open <http://localhost:3000>.

* First run creates the **admin** account and prints its one-time password in the console
  (also saved to `data/initial-admin.txt`; delete that file after signing in). You are forced
  to set a new password at first sign-in.
* The console also prints the **Network** address, e.g. `http://192.168.1.10:3000`. That is
  what the QR code encodes, so student phones must be able to reach it (same Wi-Fi).
  Change it any time from **Admin → Settings**, or set `BASE_URL` in `.env`.

Demo accounts after `npm run seed:demo`: `incharge12 / Incharge12pass` (Bus 12) and
`incharge7 / Incharge7pass` (Bus 7). Sample student: `Aditi Sharma`, ID `UU2023CS0100`.

Useful scripts:

| Command | What it does |
| --- | --- |
| `npm start` | run the server |
| `npm run dev` | run with auto-restart on file changes |
| `npm run seed:demo` | load demo buses / incharges / students |
| `npm run reset-admin` | reset the admin password if it is lost |
| `npm run backup` | consistent copy of the database into `data/backups/` |
| `npm run test:security` | end-to-end test of every security rule against a running server |

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

1. **Incharge** signs in, picks bus + direction (to / from college), presses *Start trip*.
2. The screen shows a QR with a countdown ring. The QR encodes a URL with a token that is an
   HMAC of the trip's secret and the current 20-second time slot.
3. **Student** scans with the normal camera app. The server validates the token, opens a
   5-minute check-in session bound to that phone, and asks for name + student ID.
4. Both must match the database record. Everything shown (course, year, specialization, stop,
   bus) comes from the server; the phone cannot change it.
5. **Done** writes the check-in atomically and broadcasts it over Server-Sent Events to the
   incharge screen and every admin dashboard. The counter animates, the name appears, a flag
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
| `COOKIE_SECURE` | auto | force the `Secure` cookie flag (auto on when `BASE_URL` is https) |

---

## Production deployment

Students usually board on **mobile data**, so for real use the server needs a public HTTPS
address. Any of these work:

* **A small VPS / college server** – run `npm start` under a process manager
  (`pm2 start npm --name bus-erp -- start`) behind nginx or Caddy with HTTPS, set
  `BASE_URL=https://your-domain`, `NODE_ENV=production`, `TRUST_PROXY=1`.
* **Render / Railway / Fly.io** – deploy the repo, add a persistent disk mounted at `data/`
  (set `DATA_DIR` if the mount is elsewhere), set the same env vars.
* **Quick public test from a laptop** – `cloudflared tunnel --url http://localhost:3000` or
  `ngrok http 3000`, then put the https URL in **Admin → Settings → Public base URL**.

Keep `data/` backed up (`npm run backup` can run from cron / Task Scheduler). The database is
SQLite in WAL mode, which is safe for a single server and far more than enough for a college.

---

## Importing students

**Admin → Students → Import CSV**. Header row required, column names are flexible:

```csv
uuid,name,course,year,specialization,bus,stop,phone
UU2023CS0142,Aditi Sharma,B.Tech,2nd,CSE (AI & ML),12,Rajpur Road,9876543210
```

* `uuid` can also be called `id`, `enrollment`, `roll no`, `reg no` …
* `bus` is the bus number; unknown buses and stops are created automatically.
* Existing IDs are updated, not duplicated. Export from the same page gives you the full list.

---

## Roles

* **Admin** – dashboard, students, buses & stops, staff accounts, trips, flags, audit log,
  settings, device resets. Can also run any bus screen.
* **Bus incharge** – starts / ends trips for their assigned bus (or any bus if none is
  assigned), sees the live list, can mark a student manually with a reason.
* **Student** – no account, no app, no login. Scan, confirm, done.

---

## Project layout

```
src/
  server.js          Express app, security headers, routes, graceful shutdown
  config.js          env + LAN detection
  db.js              SQLite (node:sqlite), schema migrations, housekeeping
  security.js        scrypt, HMAC, signed values, name/ID normalisation
  middleware/        session auth + CSRF, device identity, rate limits
  services/          rotating QR tokens, trips, check-ins (anti-proxy rules), SSE hub, audit, CSV
  routes/            /api/auth, /api/admin, /api/incharge, /api/checkin
views/               login, admin, incharge, checkin, 404 pages
public/              css, js (vanilla ES modules, no build step), icons
scripts/             seed-demo, reset-admin, backup, security-test
data/                database, secret key, backups (git-ignored)
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
