# The Ledger

A server-authoritative inventory and asset-transfer system for multiplayer roleplaying games.

The Gamemaster (GM) manages players, roles, item definitions, currencies and ownership. Players organise
their role's shared inventory and donate items and resources to other roles. **The server is the single
source of truth**: the browser never decides ownership, quantities, permissions, deadlines or transfer
results.

The Ledger is deliberately *not* a game engine: there is no combat, stats, crafting, maps or land
management. Land deeds are ordinary unique items.

---

## Contents

1. [Features](#features)
2. [Requirements](#requirements)
3. [Local mode (GM's computer + LAN)](#local-mode)
4. [Online mode](#online-mode)
5. [Configuration](#configuration)
6. [Using The Ledger](#using-the-ledger)
7. [Testing](#testing)
8. [Architecture](#architecture)
9. [Data model](#data-model)
10. [Security and consistency](#security-and-consistency)
11. [Assumptions and design decisions](#assumptions-and-design-decisions)
12. [Backups, maintenance and troubleshooting](#backups-maintenance-and-troubleshooting)

---

## Features

**Players**
- Inventory grid (about five columns on desktop, fewer on phones) with virtualised scrolling for unlimited items.
- Stacks show a `×N` overlay; unique items are shown individually with their own instance ID.
- Search, and sort by name, quantity, most/least recently acquired, or the role's **custom order**.
- Custom order is rearranged by drag-and-drop (desktop) or the tap-based **Move** action (phones). It is saved on
  the server, shared by everyone controlling the role, and never overwritten by automatic sorting.
- Resource balances with optional bar or dial gauges.
- Two donation workflows (item-first and recipient-first), a five-second cancellation dial enforced by the server,
  an inbox for donations awaiting approval, and live updates over WebSockets.

**Gamemaster**
- Overview, Players, Roles, Inventories, Item Definitions, Currencies, Transactions and Settings.
- Create/disable/delete accounts, issue passwords, assign roles (one role per player, many players per role).
- Create, rename, duplicate (exact independent copy) and delete roles.
- Edit any inventory: add/remove items, set stack quantities, create/edit/move unique instances, adjust or transfer balances.
- Permanent, filterable audit history (player, role, asset, action type, date), immutable at the database level.
- Server-wide switch for mandatory recipient approval (off by default).

---

## Requirements

- **Node.js 22.13 or newer** (uses the built-in `node:sqlite` module). Download from <https://nodejs.org>.
- Any modern browser on desktop or mobile.

No separate database server is required.

---

## Local mode

The GM runs the server on their own computer; players join from browsers on the same network. After the
first install, no internet connection is needed.

### 1. Install and build (once)

```bash
cd "The Ledger"          # this folder
npm install
npm run build
```

### 2. Choose the GM password and start

Create a file named `.env` in this folder (copy `.env.example`) and set at least:

```ini
GM_PASSWORD=choose-a-strong-password
```

Then start the server:

```bash
npm start
```

The console prints the addresses to use, for example:

```
  The Ledger is running.
  This computer:  http://localhost:8080
  Local network:  http://192.168.1.23:8080
```

If you don't set `GM_PASSWORD`, a random GM password is generated on the first start and printed once.
Forgot it? Run `npm run reset-gm-password` (works while the server is running).

### 3. Let players connect

Players open the **Local network** address on their phone or computer. The server listens on all network
interfaces by default (`HOST=0.0.0.0`).

- **Windows:** the first time, Windows Defender Firewall asks whether to allow Node.js. Allow it on *Private networks*.
  If you missed the prompt: *Windows Security → Firewall → Allow an app through firewall → Node.js*.
- **macOS:** allow incoming connections for `node` when asked (System Settings → Network → Firewall).
- Make sure everyone is on the same Wi-Fi network, and that it isn't a "guest" network that isolates devices.

### 4. Try it with demo data (optional)

With the server running on an empty database:

```bash
node scripts/seed-demo.mjs http://localhost:8080 gm your-gm-password
```

This creates five roles, six players (`alice`, `bob`, `cersei`, `jaime`, `banker`, `newcomer`; password `password1`),
fourteen item definitions and three currencies.

### Development mode

```bash
npm run dev     # rebuilds the client and restarts the server when files change
```

---

## Online mode

The same application runs on any internet-accessible host (VPS, cloud VM, container platform). Online and local
installations are independent; nothing is synchronised between them.

### Option A: plain Node.js behind a reverse proxy (recommended)

1. Copy this folder to the server, then `npm install && npm run build`.
2. Create `.env`:

   ```ini
   HOST=127.0.0.1                 # only the proxy talks to Node
   PORT=8080
   PUBLIC_URL=https://ledger.example.com
   TRUST_PROXY=true
   GM_PASSWORD=a-long-random-password
   DATABASE_PATH=/var/lib/the-ledger/ledger.db
   ```

3. Put a TLS-terminating reverse proxy in front. With [Caddy](https://caddyserver.com) (automatic HTTPS certificates),
   the whole `Caddyfile` is:

   ```
   ledger.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```

   With nginx, forward WebSocket upgrades and the original scheme:

   ```nginx
   location / {
       proxy_pass http://127.0.0.1:8080;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```

4. Keep it running with systemd (`/etc/systemd/system/the-ledger.service`):

   ```ini
   [Unit]
   Description=The Ledger
   After=network.target

   [Service]
   WorkingDirectory=/opt/the-ledger
   ExecStart=/usr/bin/npm start
   Restart=always
   User=ledger
   Environment=NODE_ENV=production

   [Install]
   WantedBy=multi-user.target
   ```

   `sudo systemctl enable --now the-ledger`

### Option B: built-in HTTPS

Set `TLS_CERT_FILE` and `TLS_KEY_FILE` to your certificate and key; the server then speaks HTTPS and WSS directly
and marks cookies `Secure`.

### Option C: Docker

```bash
docker build -t the-ledger .
docker run -d --name ledger -p 8080:8080 \
  -e GM_PASSWORD=change-me -e PUBLIC_URL=https://ledger.example.com -e TRUST_PROXY=true \
  -v ledger-data:/app/data the-ledger
```

Put it behind an HTTPS proxy as in option A. The database lives in the `ledger-data` volume.

In production always use HTTPS: session cookies are `Secure` whenever `PUBLIC_URL` starts with `https://`.

---

## Configuration

All settings are environment variables (or lines in `.env`). Everything is optional.

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `0.0.0.0` | Interface to listen on. `0.0.0.0` = all (LAN-accessible); `127.0.0.1` = this machine only. |
| `PORT` | `8080` | HTTP(S) port. |
| `DATABASE_PATH` | `data/ledger.db` | SQLite database file (created automatically). |
| `GM_USERNAME` | `gm` | Username of the GM account created on first start. |
| `GM_PASSWORD` | *(generated)* | Password for that account; only used when the database has no GM yet. |
| `PUBLIC_URL` | – | Public address, e.g. `https://ledger.example.com`. Used for origin checks and secure cookies. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For/Proto/Host` from a reverse proxy. |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | – | Serve HTTPS directly. |
| `COOKIE_SECURE` | auto | Force `Secure` cookies on/off. |
| `ALLOWED_ORIGINS` | – | Extra allowed browser origins (comma separated). |
| `SESSION_TTL_HOURS` | `336` | Session lifetime (sliding). |
| `MAX_IMAGE_KB` | `2048` | Maximum uploaded image size. |

---

## Using The Ledger

**GM first steps:** sign in as the GM → *Item Definitions* (define items, optionally with images) →
*Currencies* (define resources) → *Roles* (create roles) → *Players* (create accounts, pick a role, hand out the
passwords) → *Inventories* (give roles their starting items and balances).

**Players:** sign in → *My Inventory* shows the role's inventory, shared live with everyone in the role.

**Donating**

- *Item-first:* open an item (or a resource card) → **Donate** → choose a recipient role and the amount → **Review**
  (the server validates ownership and availability) → **Confirm**.
- *Recipient-first:* the prominent **Donate** button → search and choose a role → add items with **+** or drag them
  into the donation area → set quantities and amounts → **Review** → **Confirm**. Everything is one atomic transaction.

After confirming, the assets are reserved on the server and a five-second dial appears with a **Cancel** button.
When the window ends the donation either completes automatically (default) or, if the GM enabled approval, waits up
to five minutes in the recipient's *Pending* inbox for **Accept** or **Reject**. Unanswered donations are rejected
automatically and the assets return to the sender.

---

## Testing

```bash
npm test          # 86 backend tests: real HTTP server, real database, injectable clock
npm run typecheck # TypeScript checks for server and client
```

The tests start the actual server on a random port against a temporary SQLite file and exercise the API like a
browser would (cookies, JSON, WebSockets). Time-dependent rules use an injectable server clock, so the 5-second and
5-minute windows are tested exactly without waiting.

| Area | Test file |
|---|---|
| Player authentication, sessions, disabled accounts, origin checks | `auth-and-permissions.test.ts` |
| Role assignment restrictions (one role per player, unassigned players) | `auth-and-permissions.test.ts` |
| GM permissions, audit immutability | `auth-and-permissions.test.ts` |
| Item stacking, unique items, exact currency arithmetic | `inventory.test.ts` |
| Persistent custom sorting (incl. restart) | `inventory.test.ts` |
| Shared-role inventory access and live WebSocket updates | `inventory.test.ts` |
| Five-second cancellation, automatic completion | `donations.test.ts` |
| Unique item transfers, currency donations | `donations.test.ts` |
| Recipient approval, rejection, 5-minute timeout, late approval, double resolution | `donations.test.ts` |
| Concurrent donation attempts, duplicate requests | `donations.test.ts` |
| Multi-item atomicity (validation and completion failure) | `donations.test.ts` |
| Server restart during countdown and pending donations | `donations.test.ts` |
| Role duplication, deletion, catalog management, audit filters | `gm.test.ts` |

---

## Architecture

```
Browser (React + TypeScript)
   │  HTTPS JSON API (cookie session)       ▲  WebSocket "something changed" pushes
   ▼                                         │
Node.js server (TypeScript)  ── router → services (all rules) → SQLite (node:sqlite, WAL)
                              └ deadline scheduler (sweeps due donations, also at startup)
```

- **Server** – `server/src`. Plain `node:http` with a small router, a domain-service layer
  (`services/*.ts`) that contains every rule, and `ws` for WebSockets. The only runtime dependency is `ws`.
- **Database** – SQLite through Node's built-in `node:sqlite`, WAL journal, `synchronous=FULL`, foreign keys on,
  versioned migrations in `server/src/migrations.ts`.
- **Live updates** – after a transaction commits, the server pushes a small "changed" message to the affected roles
  and the GM. Clients then refetch authoritative state; messages never carry state the client must trust. After a
  reconnect, clients refetch everything.
- **Deadlines** – stored as server timestamps. A scheduler wakes at the next deadline (at least once per second) and
  at startup. Cancel/accept requests also check the deadline themselves, so a late request is refused even if the
  sweep hasn't run yet.
- **Client** – `client/src`, bundled by esbuild into `dist/public` and served by the same Node process.
  `player/` (inventory, resources, donate, pending), `gm/` (dashboard), `components/` (grid, dialogs, gauges, dials).

### API overview

| | Endpoints |
|---|---|
| Auth | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/password` |
| Player | `GET /api/me/state`, `GET /api/roles/directory`, `POST /api/me/inventory/reorder` |
| Donations | `POST /api/donations/validate`, `POST /api/donations`, `GET /api/donations/:id`, `POST /api/donations/:id/{cancel,accept,reject}` |
| GM | `/api/gm/overview`, `/api/gm/players…`, `/api/gm/roles…`, `/api/gm/roles/:id/{inventory,items,reorder,currencies/:cid,duplicate}`, `/api/gm/entries/:id…`, `/api/gm/item-definitions…`, `/api/gm/images`, `/api/gm/currencies…`, `/api/gm/currency-transfers`, `/api/gm/donations`, `/api/gm/audit`, `/api/gm/settings` |

---

## Data model

| Table | Purpose |
|---|---|
| `users` | Player and GM accounts (scrypt password hashes, disabled flag). |
| `sessions` | Session tokens (only SHA-256 hashes are stored). |
| `roles` | Roles (unique names). |
| `inventories` | Exactly one per role (`UNIQUE role_id`). |
| `role_assignments` | Player → role. `user_id` is the primary key, so a player has at most one role. |
| `item_definitions` | Reusable item templates (name, description, image, stackable/unique). |
| `inventory_entries` | Stacks (`kind='stack'`, quantity > 0) and unique instances (`kind='unique'`, quantity 1, row id = instance ID). A partial unique index guarantees one stack per definition per inventory. `position` stores the saved custom order. |
| `images` | Uploaded images (PNG/JPEG/GIF/WebP, content-checked). |
| `currencies` | Currency definitions: precision, optional min/max, gauge style, color, icon. |
| `currency_balances` | Balances in integer minor units (amount × 10^precision). |
| `donations` | Donation transactions with status, server deadlines, resolver and snapshots of role names. |
| `donation_lines` | Line items with name snapshots (history survives deletions). |
| `asset_reservations` | Active holds during countdown/pending. A partial unique index makes double reservation of a unique item impossible. |
| `audit_events`, `audit_event_assets` | Permanent audit log. Triggers reject any UPDATE or DELETE. |
| `settings` | GM configuration (`approval_required`). |
| `schema_migrations` | Applied migrations. |

Donation status flow:

```
countdown ──cancel (before deadline)──▶ cancelled
    │
    └─ deadline ─┬─ approval off ─▶ completed   (or failed → assets released)
                 └─ approval on ──▶ pending ─┬─ accept (before deadline) ─▶ completed / failed
                                             ├─ reject ─────────────────▶ rejected
                                             └─ 5-minute deadline ──────▶ rejected (timed out)
```

---

## Security and consistency

- **Authentication:** scrypt password hashing with per-password salts; random 256-bit session tokens in `HttpOnly`,
  `SameSite=Lax` cookies (`Secure` in production); only token hashes are stored; sliding expiry; login rate limiting.
  Disabling an account, deleting it or resetting its password ends its sessions and closes its WebSockets.
- **Authorization:** every endpoint declares its access level (`public`, `user`, `player`, `gm`) and the server
  re-reads the player's role assignment from the database on every request. Audit history and all GM endpoints are
  GM-only on the backend.
- **CSRF / cross-site WebSockets:** mutating requests must be JSON and come from the same origin (or a configured
  one); WebSocket upgrades check the origin and session.
- **Never trust the client:** quantities, amounts, ownership and timestamps are validated and computed server-side.
  The client sends only *intent* (entry IDs and requested amounts).
- **Atomicity and concurrency:** every ownership change runs inside one `BEGIN IMMEDIATE` SQLite transaction.
  `node:sqlite` is synchronous, so a transaction runs to completion before any other request is processed: two
  players racing for the same item are strictly serialised, and the loser receives a clear error. Database
  constraints (CHECKs, unique indexes, foreign keys, triggers) back up the application rules.
- **Duplicate requests:** each donation carries a client-generated `requestId`; resubmissions return the original
  donation instead of creating another. State transitions use compare-and-set (`UPDATE … WHERE status = ?`),
  so a donation can only be resolved once.
- **Disconnects and restarts:** deadlines are server timestamps processed by the scheduler, including immediately
  at startup, so browser disconnects or server restarts never leave a donation stuck or let a deadline be missed.
- **Exact money:** balances are integers of minor units; amounts travel as decimal strings; no floating point.
- **Uploads:** images only (content-sniffed); SVG refused; served with `nosniff` and a restrictive CSP.
- **Headers:** CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`.

---

## Assumptions and design decisions

Where the specification was open, the simplest consistent behaviour was chosen:

1. **Technology.** React + TypeScript and Node + TypeScript as recommended. Instead of Fastify/Express + Prisma +
   PostgreSQL, the server uses `node:http`, the built-in `node:sqlite` and hand-written, versioned SQL migrations.
   This makes the *same* install work offline on a GM's laptop and online, with one runtime dependency (`ws`) and
   no database server to operate. SQLite in WAL mode comfortably handles a gaming group's traffic. PostgreSQL is
   **not** included; the data access is plain SQL in one layer if a port is ever needed. The client is bundled with
   esbuild (the bundler Vite uses internally) to keep the build dependency-light.
2. **Reservation model.** Reserved assets stay owned by (and visible to) the sender, marked "reserved"; they cannot
   be donated again, moved or reduced by the GM below the reserved amount. Ownership changes only on completion.
3. **Who can cancel.** Any player controlling the sending role can cancel during the countdown (they share the
   inventory). Only players of the recipient role can accept or reject.
4. **When approval applies.** The approval setting is read when a donation's cancellation window ends. The 5-minute
   approval window starts exactly at the end of the cancellation window. Turning approval off does not auto-complete
   donations that are already pending; they keep their deadline.
5. **Recipient limits.** If completing a donation would push the recipient above a currency maximum (or an asset
   is somehow unavailable), the whole donation fails atomically, nothing moves, everything is released, and both
   sides are notified. The UI warns before confirming when a recipient is already near the maximum.
6. **Currency limits.** Without a configured minimum, balances cannot go below zero. A configured minimum must be
   ≤ 0 and a maximum ≥ 0, because roles without a balance hold zero. Players can never donate into a negative balance.
   Raising precision rescales balances exactly; lowering it is refused if it would lose fractions.
7. **"Delete currency balances".** The GM resets a role's balance (to zero, or the minimum) or deletes the currency
   entirely; every currency is always shown for every role, as specified.
8. **Recently acquired.** A stack's acquisition time is the last time units were added to it; a unique item's is
   when it arrived in the current inventory.
9. **Sorting.** Sort mode is a per-device display preference (stored in the browser). Rearranging is available in
   *Custom order* without an active search. New and received items are appended to the end of the custom order;
   adding to an existing stack keeps its position.
10. **Role names** are unique (case-insensitive) so recipients can be found unambiguously. Duplicates get
    `(copy)`, `(copy 2)`, ….
11. **Duplicating a role** copies the full owned quantities (including units currently reserved by the original's
    in-flight donations, since they are still owned), with new IDs for every entry and unique instance. Pending
    donations and players are not copied.
12. **Deleting a role** cancels its in-flight donations first (returning assets to senders), unassigns its players
    and deletes its inventory. **Deleting an item definition** removes it from all inventories and is refused while
    any unit is part of an in-flight donation. History is preserved in all cases via name snapshots.
13. **Unassigned players** can sign in and see a waiting screen that updates automatically when the GM assigns them.
14. **Unique-item names.** A unique instance may carry its own name and description (e.g. *Deed: Winterfell* on a
    *Land deed* definition). Duplication and transfers keep them.
15. **Rearranging** the custom order is not written to the permanent audit log (it isn't an ownership change); all
    donations, GM operations and sign-ins are.
16. **One GM account** is created automatically; the GM cannot be assigned a role or disabled. Players may change
    their own password; the GM can reset anyone's.

---

## Backups, maintenance and troubleshooting

- **Backup:** stop the server and copy `data/ledger.db` (plus `ledger.db-wal`/`-shm` if present). While running,
  use `sqlite3 data/ledger.db ".backup backup.db"`.
- **Reset everything:** stop the server and delete the `data` folder.
- **Forgotten GM password:** `npm run reset-gm-password` (or `npm run reset-gm-password -- NewPassword`).
- **"The Ledger frontend has not been built":** run `npm run build`.
- **Players cannot connect over LAN:** check the firewall prompt, that `HOST` is `0.0.0.0`, that devices share the
  same network, and use the IP address printed at startup (not `localhost`).
- **Live indicator says "Reconnecting…":** the browser lost the WebSocket; it reconnects automatically and refetches
  state. Behind a proxy, make sure WebSocket upgrades are forwarded.
- **`node:sqlite` not found:** upgrade Node.js to 22.13 or newer.
