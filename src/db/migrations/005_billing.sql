-- Subscriptions (cloud, Stripe) and licensing (on-prem)
ALTER TABLE tenants ADD COLUMN billing_plan text NOT NULL DEFAULT 'trial';        -- trial | starter | pro
ALTER TABLE tenants ADD COLUMN billing_status text NOT NULL DEFAULT 'trialing';   -- trialing | active | past_due | canceled | comped
ALTER TABLE tenants ADD COLUMN billing_interval text;                              -- month | year
ALTER TABLE tenants ADD COLUMN trial_ends_at timestamptz NOT NULL DEFAULT now() + interval '14 days';
ALTER TABLE tenants ADD COLUMN seats int NOT NULL DEFAULT 10;                       -- paid technician seats (trial cap)
ALTER TABLE tenants ADD COLUMN stripe_customer_id text UNIQUE;
ALTER TABLE tenants ADD COLUMN stripe_subscription_id text UNIQUE;
ALTER TABLE tenants ADD COLUMN current_period_end timestamptz;
ALTER TABLE tenants ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN past_due_since timestamptz;
ALTER TABLE tenants ADD COLUMN license_key text;                                    -- on-prem signed license
ALTER TABLE tenants ADD COLUMN trial_reminded_at timestamptz;

-- Webhook idempotency: every processed Stripe event id is recorded once
CREATE TABLE billing_events (
  id          text PRIMARY KEY,
  type        text NOT NULL,
  tenant_id   int REFERENCES tenants(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
