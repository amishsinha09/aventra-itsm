-- Customer satisfaction surveys and time zones
ALTER TABLE tickets ADD COLUMN csat_score int CHECK (csat_score BETWEEN 1 AND 5);
ALTER TABLE tickets ADD COLUMN csat_comment text;
ALTER TABLE tickets ADD COLUMN csat_at timestamptz;
CREATE INDEX tickets_csat ON tickets (tenant_id, csat_at) WHERE csat_score IS NOT NULL;

ALTER TABLE tenants ADD COLUMN timezone text NOT NULL DEFAULT 'America/Chicago';
ALTER TABLE users ADD COLUMN timezone text; -- NULL = use workspace timezone
