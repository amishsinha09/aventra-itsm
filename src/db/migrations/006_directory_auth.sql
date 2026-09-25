-- Sign-in through Active Directory (LDAP) and Microsoft Entra ID
ALTER TABLE users ADD COLUMN auth_source text NOT NULL DEFAULT 'local' CHECK (auth_source IN ('local','ldap','entra'));
ALTER TABLE users ADD COLUMN external_id text;           -- AD objectGUID / Entra object id
ALTER TABLE users ADD COLUMN directory_groups text[];     -- groups seen at last sign-in (for admins' visibility)
ALTER TABLE users ADD COLUMN invited_at timestamptz;
CREATE UNIQUE INDEX users_external ON users (tenant_id, auth_source, external_id) WHERE external_id IS NOT NULL;
-- Invite links live longer than reset links; same table
ALTER TABLE password_resets ADD COLUMN purpose text NOT NULL DEFAULT 'reset' CHECK (purpose IN ('reset','invite'));
