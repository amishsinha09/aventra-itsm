Aventra ITSM Server (on-prem)
=============================

Open the service desk:   http://localhost:8080   (or http://<this-server>:8080 from other PCs)
First visit:             create your workspace and administrator account.

Files
  Program files   C:\Program Files\Aventra ITSM
  Data + config   C:\ProgramData\Aventra ITSM
    config.env    settings (port, email, AI, Slack/Teams). Restart the "Aventra ITSM" service after editing.
    pgdata\       PostgreSQL database — back this folder up (stop both services first) or use pg_dump.
    logs\         application and database logs

Windows services
  Aventra ITSM      the web application (AventraITSM-Service.exe wraps AventraITSM.exe)
  AventraITSM-DB    the bundled PostgreSQL 16 database (localhost only, port 5433)

Backups (online, no downtime)
  "C:\Program Files\Aventra ITSM\pgsql\bin\pg_dump.exe" -h 127.0.0.1 -p 5433 -U itsm -Fc -f itsm-backup.dump itsm
  (the password is ITSM_DB_PASSWORD in config.env)

HTTPS
  For access beyond your LAN, put the server behind a reverse proxy with a certificate (IIS ARR, Caddy,
  or Cloudflare Tunnel), then set APP_URL=https://... and COOKIE_SECURE=true in config.env.

Command line
  AventraITSM.exe version | migrate | seed | check
  (run from an elevated prompt with:  set ITSM_CONFIG=C:\ProgramData\Aventra ITSM\config.env)
