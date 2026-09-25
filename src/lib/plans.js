// Plans, features and the billing state that every request is checked against.
import { config } from '../config.js';
import { one } from '../db/index.js';
import { verifyLicense } from './license.js';
import { HttpError } from './http.js';

// Feature keys gated by plan (everything not listed here is in every plan)
export const PRO_FEATURES = ['problems', 'changes', 'cmdb', 'ai', 'reports', 'aventra'];
export const FEATURE_LABEL = {
  problems: 'Problem management', changes: 'Change management & CAB', cmdb: 'CMDB & impact analysis',
  ai: 'AI assist', reports: 'Reports & CSAT scorecards', aventra: 'Aventra self-healing integration',
};

export const PLANS = {
  starter: { name: 'Starter', features: [], price: () => config.priceStarter },
  pro: { name: 'Pro', features: PRO_FEATURES, price: () => config.pricePro },
};

export const TRIAL_SEATS = 10;
const PAST_DUE_GRACE_DAYS = 7;
const LICENSE_GRACE_DAYS = 14;
const ONPREM_TRIAL_DAYS = 30;
const DAY = 86400000;

// Billing mode: 'stripe' (cloud SaaS), 'license' (on-prem), or 'off' (self-hosted/dev: everything unlocked)
export const billingMode = () => config.billingMode;

export function computeBilling(t, now = Date.now()) {
  const mode = billingMode();
  const base = { mode, plan: 'pro', status: 'active', seats: null, readOnly: false, features: PRO_FEATURES, trialEndsAt: null, trialDaysLeft: null, message: null };
  if (mode === 'off') return base;

  if (t.billing_status === 'comped') return { ...base, status: 'comped', seats: t.seats > 0 ? t.seats : null };

  if (mode === 'license') {
    const lic = t.license_key ? verifyLicense(t.license_key) : null;
    if (lic?.valid) {
      const exp = new Date(lic.payload.expires).getTime();
      const plan = PLANS[lic.payload.plan] ? lic.payload.plan : 'pro';
      const out = { ...base, plan, seats: lic.payload.seats, features: PLANS[plan].features, licensee: lic.payload.licensee, licenseExpires: lic.payload.expires };
      if (exp > now) return out;
      if (exp + LICENSE_GRACE_DAYS * DAY > now) return { ...out, status: 'past_due', message: `Your license expired on ${new Date(exp).toDateString()}. Renew within ${Math.ceil((exp + LICENSE_GRACE_DAYS * DAY - now) / DAY)} days to avoid read-only mode.` };
      return { ...out, status: 'canceled', readOnly: true, message: 'Your license has expired. The service desk is read-only until a renewed license is activated.' };
    }
    const end = new Date(t.created_at).getTime() + ONPREM_TRIAL_DAYS * DAY;
    const left = Math.ceil((end - now) / DAY);
    if (left > 0) return { ...base, plan: 'trial', status: 'trialing', seats: TRIAL_SEATS, trialEndsAt: new Date(end), trialDaysLeft: left };
    return { ...base, plan: 'trial', status: 'canceled', seats: TRIAL_SEATS, readOnly: true, trialEndsAt: new Date(end), trialDaysLeft: 0, message: 'Your 30-day trial has ended. Activate a license to continue.' };
  }

  // Stripe subscriptions
  const plan = PLANS[t.billing_plan] ? t.billing_plan : null;
  const trialEnd = new Date(t.trial_ends_at).getTime();
  const trialLeft = Math.ceil((trialEnd - now) / DAY);
  const inTrial = trialLeft > 0;
  if (plan && t.billing_status === 'active') return { ...base, plan, seats: t.seats, features: PLANS[plan].features, interval: t.billing_interval, periodEnd: t.current_period_end, cancelAtPeriodEnd: t.cancel_at_period_end };
  if (plan && t.billing_status === 'past_due') {
    const since = new Date(t.past_due_since || now).getTime();
    const graceLeft = Math.ceil((since + PAST_DUE_GRACE_DAYS * DAY - now) / DAY);
    if (graceLeft > 0) return { ...base, plan, status: 'past_due', seats: t.seats, features: PLANS[plan].features, message: `Your last payment failed. Update your payment method within ${graceLeft} day${graceLeft === 1 ? '' : 's'} to avoid read-only mode.` };
    return { ...base, plan, status: 'past_due', seats: t.seats, features: PLANS[plan].features, readOnly: true, message: 'Payment is overdue. The service desk is read-only until billing is updated.' };
  }
  if (inTrial) return { ...base, plan: 'trial', status: 'trialing', seats: TRIAL_SEATS, trialEndsAt: new Date(trialEnd), trialDaysLeft: trialLeft };
  const wasPaid = t.billing_status === 'canceled' && plan;
  return { ...base, plan: plan || 'trial', status: 'canceled', seats: t.seats, readOnly: true, trialDaysLeft: 0,
    message: wasPaid ? 'Your subscription has ended. Choose a plan to keep working — all your data is still here.' : 'Your free trial has ended. Choose a plan to keep working — all your data is still here.' };
}

// Short cache so the check adds no noticeable latency; webhooks/license changes clear it.
const cache = new Map();
export function invalidateBilling(tenantId) { cache.delete(tenantId); }
export async function billingFor(tenantId) {
  const hit = cache.get(tenantId);
  if (hit && hit.at > Date.now() - 30_000) return hit.value;
  const t = await one('SELECT * FROM tenants WHERE id=$1', [tenantId]);
  const value = computeBilling(t);
  cache.set(tenantId, { at: Date.now(), value });
  return value;
}

export async function assertFeature(tenantId, feature) {
  const b = await billingFor(tenantId);
  if (!b.features.includes(feature) && PRO_FEATURES.includes(feature)) {
    throw new HttpError(402, `${FEATURE_LABEL[feature]} is part of the Pro plan. Upgrade to use it.`, { code: 'upgrade_required', feature });
  }
}
export const requireFeature = (feature) => async (req) => assertFeature(req.user.tenant_id, feature);

export async function assertSeatAvailable(db, tenantId, { excludeUserId = null } = {}) {
  const b = await billingFor(tenantId);
  if (!b.seats) return;
  const used = await db.one(`SELECT count(*)::int AS n FROM users WHERE tenant_id=$1 AND active AND role IN ('admin','agent') AND ($2::int IS NULL OR id <> $2)`, [tenantId, excludeUserId]);
  if (used.n >= b.seats) {
    throw new HttpError(402, `All ${b.seats} technician seats are in use. Add seats in Settings → Billing, or make this user a requester (requesters are free).`, { code: 'seat_limit', seats: b.seats, used: used.n });
  }
}
