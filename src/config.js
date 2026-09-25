import fs from 'node:fs';
import path from 'node:path';

// Load settings from ITSM_CONFIG (on-prem installs: C:\ProgramData\Aventra ITSM\config.env)
// or from .env in the working directory. Real environment variables always win.
const envFile = process.env.ITSM_CONFIG || path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;
const isProd = env.NODE_ENV === 'production';

if (isProd && (!env.JWT_SECRET || env.JWT_SECRET.length < 32)) {
  throw new Error('JWT_SECRET must be set to at least 32 characters in production');
}

export const config = {
  isProd,
  port: parseInt(env.PORT || '3000', 10),
  databaseUrl: env.DATABASE_URL || 'postgres://postgres:devpass@127.0.0.1:5432/itsm',
  dbPoolMax: parseInt(env.DB_POOL_MAX || '10', 10),
  jwtSecret: env.JWT_SECRET || 'dev-only-secret-change-me-dev-only-secret',
  sessionHours: parseInt(env.SESSION_HOURS || '12', 10),
  appUrl: env.APP_URL || `http://localhost:${env.PORT || 3000}`,
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5',
  resendKey: env.RESEND_API_KEY || '',
  emailFrom: env.EMAIL_FROM || 'Aventra Service Desk <support@aventratech.org>',
  slackWebhook: env.SLACK_WEBHOOK_URL || '',
  teamsWebhook: env.TEAMS_WEBHOOK_URL || '',
  inboundEmailSecret: env.INBOUND_EMAIL_SECRET || '',
  slaIntervalSec: parseInt(env.SLA_INTERVAL_SEC || '60', 10),
  trustProxy: env.TRUST_PROXY !== 'false',
  // true | false | first (only until the first workspace exists — used by on-prem installs)
  allowSignup: env.ALLOW_SIGNUP === 'first' ? 'first' : env.ALLOW_SIGNUP !== 'false',
  edition: env.ITSM_EDITION || 'cloud', // cloud | onprem
  // Billing: 'stripe' (cloud SaaS) | 'license' (on-prem) | 'off' (dev/self-hosted, everything unlocked)
  billingMode: env.BILLING_MODE || (env.ITSM_EDITION === 'onprem' ? 'license' : (env.STRIPE_SECRET_KEY ? 'stripe' : 'off')),
  stripeKey: env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  stripeApiBase: env.STRIPE_API_BASE || 'https://api.stripe.com',
  stripeAutomaticTax: env.STRIPE_AUTOMATIC_TAX === 'true',
  stripePrices: {
    starter: { month: env.STRIPE_PRICE_STARTER_MONTHLY || '', year: env.STRIPE_PRICE_STARTER_ANNUAL || '' },
    pro: { month: env.STRIPE_PRICE_PRO_MONTHLY || '', year: env.STRIPE_PRICE_PRO_ANNUAL || '' },
  },
  // Display prices (USD per technician per month); keep in sync with the Stripe prices
  priceStarter: parseFloat(env.PRICE_STARTER || '29'),
  pricePro: parseFloat(env.PRICE_PRO || '59'),
  salesEmail: env.SALES_EMAIL || 'sales@aventratech.org',
  marketingUrl: env.MARKETING_URL || 'https://aventratech.org',
  // Secure cookies need HTTPS. Default: on in production; on-prem LAN installs over HTTP set COOKIE_SECURE=false.
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,
};
