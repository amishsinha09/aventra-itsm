# Aventra ITSM

ITIL-aligned IT service management for MSPs and internal IT teams, wired into Aventra's self-healing agent.
Alerts open incidents, successful automatic fixes resolve them, and failed fixes escalate to a technician. No one has to touch the routine tickets.

**One runtime dependency.** Node 20+ and PostgreSQL 14+ (tested on Node 22 / Postgres 16). The database driver is [node-postgres](https://node-postgres.com) (`pg`), the standard, widely audited driver. Everything else (HTTP layer, auth with scrypt/HMAC, validation) uses Node's standard library.

A built-in zero-dependency Postgres client (`src/db/pg.js`) is kept as a fallback. It's used automatically when `pg` isn't installed, or when you force it with `DB_DRIVER=builtin`. CI runs the full test suite against both drivers.

## What's in v1

| Module | Capabilities |
|---|---|
| **Incidents** | Impact × urgency priority matrix, auto-routing by category, SLA response/resolution timers that pause on hold, resolution codes, reopen, major-incident (P1) Slack/Teams alerts |
| **Service requests** | Service catalog with dynamic forms, approver groups, fulfilment groups, required-field enforcement |
| **Problems** | Root cause and workaround, link incidents; resolving the problem resolves every linked open incident |
| **Changes** | Standard / normal / emergency; automatic 0–100 risk score; CAB approvals (all must approve for normal, any one for emergency); schedule-conflict detection on the same CI; standard changes skip CAB |
| **CMDB** | CIs per customer, criticality, relationships, recursive impact analysis ("what breaks if this goes down"), auto-discovery from the Aventra agent |
| **Knowledge** | Markdown articles, public/internal audience, drafts, helpful votes, deflection suggestions while users type, one-click "KB article from resolved ticket" |
| **AI assist** | Triage (category, impact, urgency, summary), draft replies and likely fixes from KB and similar resolved tickets, KB drafting. Uses Claude when `ANTHROPIC_API_KEY` is set and a built-in rules engine otherwise |
| **CSAT** | 1–5 star survey on resolved incidents and requests; low scores alert the technician; dashboard tile; per-customer and per-technician CSAT in Reports |
| **Dashboards & reports** | Live KPIs (open work, SLA %, self-heal %, MTTR, CSAT, breaches), created-vs-resolved trend, backlog age, team workload, upcoming changes, per-customer MSP scorecards, CSV export |
| **Time zones** | Workspace default (America/Chicago out of the box) with per-user override. Dashboards bucket days in local time |
| **Self-service portal** | Requesters see only their own tickets, search the KB, order from the catalog, comment, cancel/reopen, rate service |
| **Email** | Inbound email creates tickets or comments (by `[INC0001234]` in the subject); auto-registers senders from known customer domains; outbound notifications via Resend |
| **Multi-tenant** | One deployment hosts many workspaces with hard tenant isolation on every query; each workspace supports many customer companies |
| **Security** | scrypt passwords, HS256 sessions in HttpOnly/SameSite=Strict/Secure cookies, CSRF header check, strict CSP and security headers, HSTS, rate-limited login/reset, hashed API keys scoped to integration endpoints, audit log, parameterized SQL only, CSV formula-injection guard |

## Run locally

```bash
npm install                 # installs pg; commit the generated package-lock.json
# Postgres running locally, then:
cp .env.example .env        # set DATABASE_URL; JWT_SECRET is optional in dev
npm run migrate
npm run seed                # demo MSP workspace
npm start                   # http://localhost:3000
```

Demo sign-ins (password `Demo12345!`):
- `admin@northwind.example`: admin, CAB member
- `priya@northwind.example`, `marcus@northwind.example`: agents
- `sara@acmedental.example`, `tom@contoso.example`: requesters (portal view)

## Tests

```bash
createdb itsm_test
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/itsm_test npm test   # 17 API tests against real Postgres
BASE_URL=http://localhost:3000 node test/ui.e2e.mjs                         # browser flow (needs Playwright)
```

`npm run test:builtin` runs the same suite on the fallback driver.

The API suite covers tenant isolation, requester restrictions, CSRF, lifecycles, SLA pause and breach, CAB approvals, catalog approvals, problem→incident resolution, Aventra events, email-to-ticket, CSAT, time zones, password reset and admin permissions. On every push, CI (`.github/workflows/ci.yml`) runs:
1. the API suite on both drivers (`pg` and built-in), and
2. a Docker job that builds the production image, boots it against Postgres, checks `/api/health`, seeds demo data and drives the real UI with Playwright.

## Deploy to Railway

1. Create a project and add the **PostgreSQL** plugin.
2. Deploy this repo. `railway.json` builds the Dockerfile and health-checks `/api/health`.
3. Set variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `JWT_SECRET`: 48 random bytes (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`)
   - `APP_URL`: your public URL, e.g. `https://desk.aventratech.org`
   - `NODE_ENV=production`
   - Optional: `RESEND_API_KEY`, `EMAIL_FROM`, `ANTHROPIC_API_KEY`, `SLACK_WEBHOOK_URL`, `TEAMS_WEBHOOK_URL`, `ALLOW_SIGNUP=false`
4. Verify the live integrations. This sends a real test email, a test chat alert and a sample Claude triage, then prints a pass/fail table:
   `railway run npm run check:integrations -- --to you@yourdomain.com`
5. Migrations run automatically at boot (guarded by an advisory lock). Sign up at `/#/signup` to create the first workspace, or run `npm run seed` once for demo data.
6. Point a Cloudflare DNS record at the Railway domain.

Notes: the in-memory rate limiter is per instance, so keep `numReplicas: 1` or move limits to Postgres/Redis before scaling out. The SLA monitor is safe across replicas because it uses an advisory lock.

## Windows installers (.exe)

Two installers are built on a real Windows machine by `.github/workflows/windows.yml` (run it from the Actions tab, or push a tag such as `v1.0.0` to attach both files to a GitHub release):

| Installer | For | What it does |
|---|---|---|
| **AventraITSM-Server-Setup-x.y.z.exe** | Customers who want it on their own server (on-prem) | Installs the whole service desk as the Windows service **Aventra ITSM**, with a private PostgreSQL 16 (service **AventraITSM-DB**, localhost only), generated secrets, a firewall rule and Start-menu shortcuts. The first person to open `http://<server>:8080` creates the workspace, and sign-up then closes. Re-running a newer installer upgrades in place and keeps all data. |
| **AventraServiceDesk-Setup-x.y.z.exe** | Technicians and requesters | A desktop app that connects to any Aventra ITSM server (cloud or on-prem). It has its own window and taskbar icon, a tray icon with unread count, Windows notifications for assignments, replies, approvals and SLA warnings, and optional start at sign-in. |

How the server .exe is made: `src/cli.js` is bundled with esbuild and turned into `AventraITSM.exe` using Node's built-in single-executable-application feature. The installer (Inno Setup, `packaging/server/AventraITSM-Server.iss`) adds the PostgreSQL binaries, the WinSW service wrapper and the Visual C++ runtime. CI then installs it silently, checks that `/api/health` responds, confirms that the first sign-up works and a second one is blocked, and re-runs the installer to prove upgrades keep data.

On-prem details (paths, backups, HTTPS) are in `packaging/server/README.txt`, which is installed next to the program. The same first-run setup works on Linux and macOS for testing:
`node src/cli.js setup --data-dir /tmp/itsm --pg-bin /usr/lib/postgresql/16/bin --no-service`

Code signing: the installers are unsigned, so Windows SmartScreen will warn on first run. Add a code-signing certificate (for example Azure Trusted Signing) to the workflow before distributing to customers.

## Connect the Aventra agent

In **Settings → Integrations**, create an API key and send it as `X-API-Key`:

```http
POST /api/integrations/aventra/events
{"event":"alert.opened","alert_id":"a-123","hostname":"ACME-LT-0142","company":"Acme Dental Group","severity":"high","title":"Disk space low on C:"}
```

| Event | Effect |
|---|---|
| `alert.opened` | Creates an incident (deduplicated per `alert_id`), upserts the CI, marks it degraded/down |
| `remediation.started` | Internal note, moves the incident to In progress |
| `remediation.succeeded` | Resolves with code `auto_remediated`, counts toward the self-heal KPI, marks the CI operational |
| `remediation.failed` | Escalates (urgency 1), routes to the CI's support group, notifies the team |
| `alert.cleared` | Resolves as `no_fault_found` |

Inventory sync: `POST /api/integrations/aventra/inventory` with `{"devices":[{"hostname":"…","os":"…","ip_address":"…","company":"…"}]}`.

## Project layout

```
src/server.js            HTTP server, static files, security headers, routing, SLA job
src/db/pg.js             built-in fallback PostgreSQL client (pg is the default)
scripts/check-integrations.js  go-live check for DB, Claude, Resend, Slack/Teams
src/db/migrations/*.sql  schema (applied automatically)
src/lib/tickets.js       lifecycle engine: create/update/comment, SLA clock, approvals, history
src/lib/itsm.js          ITIL rules: lifecycles, priority matrix, change risk, numbering
src/lib/ai.js            triage, suggestions, draft replies, KB drafting (Claude or rules)
src/routes/*.js          REST API
public/                  single-page app (vanilla JS modules, no build step)
test/                    API tests (node:test) and browser E2E (Playwright)
```

## Roadmap after v1

Business-hours SLA calendars, SSO (SAML/OIDC via Entra ID), change calendar view, asset lifecycle and contracts, on-call scheduling, a workflow designer, Postgres row-level security as defence in depth, Redis-backed rate limits for multiple replicas, and file attachments (S3/R2).
