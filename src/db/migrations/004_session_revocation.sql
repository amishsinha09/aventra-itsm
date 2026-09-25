-- Sessions issued before this time are rejected (set on password change/reset and when an admin resets a password)
ALTER TABLE users ADD COLUMN sessions_valid_after timestamptz NOT NULL DEFAULT to_timestamp(0);
