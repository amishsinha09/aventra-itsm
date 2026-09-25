-- Aventra ITSM core schema. Every business table carries tenant_id for hard multi-tenant isolation.

CREATE TABLE tenants (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,
  plan          text NOT NULL DEFAULT 'starter',
  settings      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Customer companies an MSP supports (or departments for internal IT)
CREATE TABLE companies (
  id            serial PRIMARY KEY,
  tenant_id     int NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  domain        text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE users (
  id            serial PRIMARY KEY,
  tenant_id     int NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id    int REFERENCES companies(id) ON DELETE SET NULL,
  email         text NOT NULL,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin','agent','requester')),
  password_hash text,
  active        boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE UNIQUE INDEX users_email_lower ON users (tenant_id, lower(email));

CREATE TABLE groups (
  id            serial PRIMARY KEY,
  tenant_id     int NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  categories    text[] NOT NULL DEFAULT '{}',   -- auto-assignment: tickets in these categories route here
  is_cab        boolean NOT NULL DEFAULT false, -- Change Advisory Board
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE group_members (
  group_id      int NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id       int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE sla_policies (
  id            serial PRIMARY KEY,
  tenant_id     int NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_type   text NOT NULL,
  priority      int NOT NULL CHECK (priority BETWEEN 1 AND 4),
  response_mins int NOT NULL,
  resolve_mins  int NOT NULL,
  UNIQUE (tenant_id, ticket_type, priority)
);

-- Configuration items (CMDB)
CREATE TABLE cis (
  id            serial PRIMARY KEY,
  tenant_id     int NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id    int REFERENCES companies(id) ON DELETE SET NULL,
  name          text NOT NULL,
  ci_class      text NOT NULL,              -- server, workstation, network, application, database, service, cloud
  status        text NOT NULL DEFAULT 'operational', -- operational, degraded, down, maintenance, retired
  environment   text NOT NULL DEFAULT 'production',
  criticality   int NOT NULL DEFAULT 3 CHECK (criticality BETWEEN 1 AND 4),
  ip_address    text,
  os            text,
  serial_number text,
  owner_id      int REFERENCES users(id) ON DELETE SET NULL,
  support_group_id int REFERENCES groups(id) ON DELETE SET NULL,
  attributes    jsonb NOT NULL DEFAULT '{}',
  source        text NOT NULL DEFAULT 'manual', -- manual, aventra, import
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE ci_relationships (
  id            serial PRIMARY KEY,
  tenant_id     int NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id     int NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
  child_id      int NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
  rel_type      text NOT NULL DEFAULT 'depends_on', -- depends_on, runs_on, connects_to, hosts
  UNIQUE (parent_id, child_id, rel_type),
  CHECK (parent_id <> child_id)
);

CREATE TABLE catalog_items (
  id            serial PRIMARY KEY,
  tenant_id     int NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  category      text NOT NULL DEFAULT 'General',
  fields        jsonb NOT NULL DEFAULT '[]', -- [{name,label,type,required,options}]
  approval_required boolean NOT NULL DEFAULT false,
  approver_group_id int REFERENCES groups(id) ON DELETE SET NULL,
  fulfillment_group_id int REFERENCES groups(id) ON DELETE SET NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Unified task table (incident / request / problem / change), like ServiceNow's task table.
CREATE TABLE tickets (
  id            serial PRIMARY KEY,
  tenant_id     int NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number        text NOT NULL,
  type          text NOT NULL CHECK (type IN ('incident','request','problem','change')),
  title         text NOT NULL,
  description   text NOT NULL DEFAULT '',
  status        text NOT NULL,
  impact        int NOT NULL DEFAULT 3 CHECK (impact BETWEEN 1 AND 3),
  urgency       int NOT NULL DEFAULT 3 CHECK (urgency BETWEEN 1 AND 3),
  priority      int NOT NULL DEFAULT 4 CHECK (priority BETWEEN 1 AND 4),
  category      text,
  company_id    int REFERENCES companies(id) ON DELETE SET NULL,
  requester_id  int REFERENCES users(id) ON DELETE SET NULL,
  assignee_id   int REFERENCES users(id) ON DELETE SET NULL,
  group_id      int REFERENCES groups(id) ON DELETE SET NULL,
  ci_id         int REFERENCES cis(id) ON DELETE SET NULL,
  problem_id    int REFERENCES tickets(id) ON DELETE SET NULL, -- incident -> problem link
  catalog_item_id int REFERENCES catalog_items(id) ON DELETE SET NULL,
  details       jsonb NOT NULL DEFAULT '{}', -- type-specific: change risk/plan/window, request variables, problem RCA
  source        text NOT NULL DEFAULT 'portal', -- portal, agent, email, api, aventra
  external_ref  text,                          -- e.g. Aventra alert id
  resolution_code  text,
  resolution_notes text,
  ai            jsonb NOT NULL DEFAULT '{}', -- AI triage output
  auto_remediated boolean NOT NULL DEFAULT false,
  -- SLA
  response_due  timestamptz,
  resolve_due   timestamptz,
  responded_at  timestamptz,
  resolved_at   timestamptz,
  closed_at     timestamptz,
  sla_paused_at timestamptz,
  sla_breached  boolean NOT NULL DEFAULT false,
  sla_warned    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  search        tsvector GENERATED ALWAYS AS (
                  setweight(to_tsvector('english', coalesce(number,'') || ' ' || coalesce(title,'')), 'A') ||
                  setweight(to_tsvector('english', coalesce(description,'')), 'B')) STORED,
  UNIQUE (tenant_id, number)
);
CREATE INDEX tickets_list ON tickets (tenant_id, type, status, priority);
CREATE INDEX tickets_assignee ON tickets (tenant_id, assignee_id) WHERE resolved_at IS NULL;
CREATE INDEX tickets_requester ON tickets (tenant_id, requester_id);
CREATE INDEX tickets_sla ON tickets (resolve_due) WHERE resolved_at IS NULL AND sla_breached = false;
CREATE INDEX tickets_ext ON tickets (tenant_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX tickets_search ON tickets USING gin (search);

CREATE TABLE ticket_comments (
  id            serial PRIMARY KEY,
  tenant_id     int NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id     int NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id     int REFERENCES users(id) ON DELETE SET NULL,
  author_label  text,             -- for system/integration authors
  body          text NOT NULL,
  internal      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_comments_t ON ticket_comments (ticket_id, created_at);

-- Field-level history for every ticket
CREATE TABLE ticket_events (
  id            bigserial PRIMARY KEY,
  tenant_id     int NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id     int NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor_id      int REFERENCES users(id) ON DELETE SET NULL,
  actor_label   text,
  kind          text NOT NULL,     -- created, field, comment, approval, sla, automation
  field         text,
  old_value     text,
  new_value     text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_events_t ON ticket_events (ticket_id, created_at);

CREATE TABLE approvals (
  id            serial PRIMARY KEY,
  tenant_id     int NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id     int NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  approver_id   int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state         text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','canceled')),
  comment       text,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, approver_id)
);
CREATE INDEX approvals_pending ON approvals (approver_id) WHERE state = 'pending';

CREATE TABLE kb_articles (
  id            serial PRIMARY KEY,
  tenant_id     int NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number        text NOT NULL,
  title         text NOT NULL,
  body          text NOT NULL,
  category      text,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  audience      text NOT NULL DEFAULT 'public' CHECK (audience IN ('public','internal')),
  author_id     int REFERENCES users(id) ON DELETE SET NULL,
  source_ticket_id int REFERENCES tickets(id) ON DELETE SET NULL,
  views         int NOT NULL DEFAULT 0,
  helpful       int NOT NULL DEFAULT 0,
  not_helpful   int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  search        tsvector GENERATED ALWAYS AS (
                  setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
                  setweight(to_tsvector('english', coalesce(category,'')), 'B') ||
                  setweight(to_tsvector('english', coalesce(body,'')), 'C')) STORED,
  UNIQUE (tenant_id, number)
);
CREATE INDEX kb_search ON kb_articles USING gin (search);

CREATE TABLE counters (
  tenant_id     int NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  prefix        text NOT NULL,
  value         int NOT NULL DEFAULT 1000,
  PRIMARY KEY (tenant_id, prefix)
);

-- Integration API keys (Aventra agent, email inbound, scripts). Only a SHA-256 hash is stored.
CREATE TABLE api_keys (
  id            serial PRIMARY KEY,
  tenant_id     int NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  prefix        text NOT NULL,
  key_hash      text NOT NULL UNIQUE,
  scopes        text[] NOT NULL DEFAULT '{integrations}',
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  tenant_id     int REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       int REFERENCES users(id) ON DELETE SET NULL,
  action        text NOT NULL,
  entity        text,
  entity_id     text,
  data          jsonb,
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_t ON audit_log (tenant_id, created_at DESC);

CREATE TABLE notifications (
  id            bigserial PRIMARY KEY,
  tenant_id     int NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       int REFERENCES users(id) ON DELETE CASCADE,
  ticket_id     int REFERENCES tickets(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  message       text NOT NULL,
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_u ON notifications (user_id, created_at DESC);
