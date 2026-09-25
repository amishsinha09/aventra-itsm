// Billing: public plan catalog, Stripe Checkout / Customer Portal / seat changes, webhook sync,
// and on-prem license activation.
import { tx, one, many, q, db } from '../db/index.js';
import { bad, forbidden, HttpError } from '../lib/http.js';
import { validate, int, oneOf, str } from '../lib/validate.js';
import { adminOnly, audit } from '../lib/auth.js';
import { config } from '../config.js';
import { stripe, verifyWebhook, planForPrice } from '../lib/stripe.js';
import { PLANS, PRO_FEATURES, FEATURE_LABEL, TRIAL_SEATS, billingFor, invalidateBilling, computeBilling } from '../lib/plans.js';
import { verifyLicense, licensingConfigured } from '../lib/license.js';
import { sendEmail } from '../lib/notify.js';

const STARTER_FEATURES = ['Incident & service request management', 'Self-service portal & service catalog', 'Knowledge base', 'SLA timers & breach alerts',
  'CSAT surveys', 'Email-to-ticket', 'Dashboards & CSV export', 'Unlimited requesters (free)'];
const PRO_EXTRA = PRO_FEATURES.map((f) => FEATURE_LABEL[f]);

async function staffCount(tenantId) {
  return (await one(`SELECT count(*)::int AS n FROM users WHERE tenant_id=$1 AND active AND role IN ('admin','agent')`, [tenantId])).n;
}

async function notifyAdmins(tenantId, subject, text) {
  const admins = await many(`SELECT email FROM users WHERE tenant_id=$1 AND role='admin' AND active`, [tenantId]);
  for (const a of admins) sendEmail(a.email, subject, text);
}

// Bring a tenant in line with a Stripe subscription object
export async function syncSubscription(d, sub) {
  const item = sub.items?.data?.[0];
  const mapped = planForPrice(item?.price?.id);
  let tenant = sub.metadata?.tenant_id ? await d.one('SELECT * FROM tenants WHERE id=$1', [parseInt(sub.metadata.tenant_id, 10)]) : null;
  tenant ||= await d.one('SELECT * FROM tenants WHERE stripe_customer_id=$1', [sub.customer]);
  if (!tenant) { console.warn(`Stripe subscription ${sub.id}: no matching workspace`); return null; }
  if (sub.status === 'incomplete') return tenant; // first payment still processing
  const status = ['active', 'trialing'].includes(sub.status) ? 'active'
    : ['past_due', 'unpaid'].includes(sub.status) ? 'past_due' : 'canceled';
  const periodEnd = sub.current_period_end ?? item?.current_period_end;
  // Keep a comped workspace comped even if an old subscription changes
  if (tenant.billing_status === 'comped') return tenant;
  await d.query(`UPDATE tenants SET billing_plan = COALESCE($2, billing_plan), billing_interval = COALESCE($3, billing_interval), billing_status = $4,
      seats = COALESCE($5, seats), stripe_customer_id = $6, stripe_subscription_id = $7, current_period_end = $8, cancel_at_period_end = $9,
      past_due_since = CASE WHEN $4 = 'past_due' THEN COALESCE(past_due_since, now()) ELSE NULL END
    WHERE id = $1`, [tenant.id, mapped?.plan ?? null, mapped?.interval ?? null, status, item?.quantity ?? null, sub.customer, sub.id,
    periodEnd ? new Date(periodEnd * 1000) : null, Boolean(sub.cancel_at_period_end)]);
  invalidateBilling(tenant.id);
  return tenant;
}

export default function (r) {
  // Public: what the pricing page shows
  r.get('/api/billing/plans', async () => ({
    mode: config.billingMode, currency: 'usd', trialDays: 14, trialSeats: TRIAL_SEATS, salesEmail: config.salesEmail,
    plans: [
      { id: 'starter', name: 'Starter', monthly: config.priceStarter, annualPerMonth: Math.round((config.priceStarter * 10) / 12 * 100) / 100, features: STARTER_FEATURES },
      { id: 'pro', name: 'Pro', monthly: config.pricePro, annualPerMonth: Math.round((config.pricePro * 10) / 12 * 100) / 100, features: ['Everything in Starter', ...PRO_EXTRA], recommended: true },
    ],
  }), { public: true });

  r.get('/api/billing', adminOnly, async (req) => {
    const t = await one('SELECT * FROM tenants WHERE id=$1', [req.user.tenant_id]);
    const b = computeBilling(t);
    const lic = t.license_key ? verifyLicense(t.license_key) : null;
    return {
      ...b, seatsUsed: await staffCount(t.id),
      requesters: (await one(`SELECT count(*)::int AS n FROM users WHERE tenant_id=$1 AND role='requester'`, [t.id])).n,
      hasSubscription: Boolean(t.stripe_subscription_id), stripeConfigured: Boolean(config.stripeKey),
      pricesConfigured: Object.values(config.stripePrices).every((p) => p.month && p.year),
      licensingConfigured: licensingConfigured(),
      license: lic?.valid ? { licensee: lic.payload.licensee, plan: lic.payload.plan, seats: lic.payload.seats, expires: lic.payload.expires, id: lic.payload.id } : null,
    };
  });

  r.post('/api/billing/checkout', adminOnly, async (req) => {
    if (config.billingMode !== 'stripe') throw bad('Online billing is not enabled on this server.');
    const b = validate({ plan: oneOf(['starter', 'pro'], { required: true }), interval: oneOf(['month', 'year'], { required: true }), seats: int({ min: 1, max: 5000 }) }, req.body);
    const t = await one('SELECT * FROM tenants WHERE id=$1', [req.user.tenant_id]);
    if (t.stripe_subscription_id && ['active', 'past_due'].includes(t.billing_status)) throw bad('You already have a subscription. Use "Manage billing" to change plan or payment details.');
    const price = config.stripePrices[b.plan][b.interval];
    if (!price) throw new HttpError(503, 'This plan is not available for purchase yet.');
    const used = await staffCount(t.id);
    const seats = Math.max(b.seats || used, used, 1);
    const trialEnd = new Date(t.trial_ends_at).getTime();
    const keepTrial = trialEnd - Date.now() > 49 * 3600 * 1000; // Stripe needs ≥ 48h
    const admin = await one('SELECT email FROM users WHERE id=$1', [req.user.id]);
    const session = await stripe('POST', 'checkout/sessions', {
      mode: 'subscription',
      client_reference_id: String(t.id),
      ...(t.stripe_customer_id ? { customer: t.stripe_customer_id } : { customer_email: admin.email }),
      line_items: [{ price, quantity: seats }],
      subscription_data: { metadata: { tenant_id: String(t.id), workspace: t.slug }, ...(keepTrial ? { trial_end: Math.floor(trialEnd / 1000) } : {}) },
      metadata: { tenant_id: String(t.id) },
      allow_promotion_codes: 'true',
      billing_address_collection: 'auto',
      ...(config.stripeAutomaticTax ? { automatic_tax: { enabled: 'true' }, tax_id_collection: { enabled: 'true' } } : {}),
      success_url: `${config.appUrl}/#/admin/billing?checkout=success`,
      cancel_url: `${config.appUrl}/#/admin/billing?checkout=canceled`,
    }, { idempotencyKey: `checkout-${t.id}-${b.plan}-${b.interval}-${seats}-${Math.floor(Date.now() / 60000)}` });
    await audit(req, 'billing.checkout_started', 'tenant', t.id, { plan: b.plan, interval: b.interval, seats });
    return { url: session.url };
  });

  r.post('/api/billing/portal', adminOnly, async (req) => {
    const t = await one('SELECT stripe_customer_id FROM tenants WHERE id=$1', [req.user.tenant_id]);
    if (!t.stripe_customer_id) throw bad('No billing account yet — choose a plan first.');
    const s = await stripe('POST', 'billing_portal/sessions', { customer: t.stripe_customer_id, return_url: `${config.appUrl}/#/admin/billing` });
    return { url: s.url };
  });

  // Change the number of technician seats (prorated by Stripe)
  r.post('/api/billing/seats', adminOnly, async (req) => {
    const b = validate({ seats: int({ required: true, min: 1, max: 5000 }) }, req.body);
    const t = await one('SELECT * FROM tenants WHERE id=$1', [req.user.tenant_id]);
    if (!t.stripe_subscription_id) throw bad('Choose a plan first.');
    const used = await staffCount(t.id);
    if (b.seats < used) throw bad(`You have ${used} active technicians. Deactivate some or make them requesters before reducing seats to ${b.seats}.`);
    const sub = await stripe('GET', `subscriptions/${t.stripe_subscription_id}`);
    const updated = await stripe('POST', `subscriptions/${sub.id}`, {
      items: [{ id: sub.items.data[0].id, quantity: b.seats }], proration_behavior: 'create_prorations',
    }, { idempotencyKey: `seats-${t.id}-${b.seats}-${Math.floor(Date.now() / 60000)}` });
    await tx((d) => syncSubscription(d, updated));
    await audit(req, 'billing.seats_changed', 'tenant', t.id, { from: t.seats, to: b.seats });
    return billingFor(t.id);
  });

  // Stripe → us. Signature-verified, idempotent, transactional (Stripe retries on any non-2xx).
  r.post('/api/billing/webhook', async (req) => {
    const event = verifyWebhook(req.rawBody, req.headers['stripe-signature']);
    return tx(async (d) => {
      const first = await d.one('INSERT INTO billing_events (id, type) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING RETURNING id', [event.id, event.type]);
      if (!first) return { received: true, duplicate: true };
      const o = event.data?.object || {};
      let tenant = null;
      switch (event.type) {
        case 'checkout.session.completed': {
          const tid = parseInt(o.client_reference_id || o.metadata?.tenant_id, 10);
          tenant = await d.one('SELECT * FROM tenants WHERE id=$1', [tid]);
          if (!tenant) break;
          await d.query('UPDATE tenants SET stripe_customer_id=$2, stripe_subscription_id=COALESCE($3, stripe_subscription_id) WHERE id=$1', [tid, o.customer, o.subscription]);
          if (o.subscription) await syncSubscription(d, await stripe('GET', `subscriptions/${o.subscription}`));
          later(() => notifyAdmins(tid, 'Your Aventra ITSM subscription is active', `Thanks for subscribing to Aventra ITSM!\n\nManage your plan, seats and invoices any time in Settings → Billing:\n${config.appUrl}/#/admin/billing`));
          break;
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
          tenant = await syncSubscription(d, o);
          break;
        case 'invoice.payment_failed': {
          tenant = await d.one('SELECT * FROM tenants WHERE stripe_customer_id=$1', [o.customer]);
          if (tenant) {
            await d.query(`UPDATE tenants SET billing_status = CASE WHEN billing_status='active' THEN 'past_due' ELSE billing_status END, past_due_since = COALESCE(past_due_since, now()) WHERE id=$1 AND billing_status <> 'comped'`, [tenant.id]);
            const tid = tenant.id;
            later(() => notifyAdmins(tid, 'Payment failed for Aventra ITSM', `We couldn't process your latest payment. Please update your payment method within 7 days to avoid interruption:\n${config.appUrl}/#/admin/billing`));
          }
          break;
        }
        case 'invoice.paid':
          tenant = await d.one('SELECT * FROM tenants WHERE stripe_customer_id=$1', [o.customer]);
          if (tenant) await d.query(`UPDATE tenants SET past_due_since=NULL, billing_status = CASE WHEN billing_status='past_due' THEN 'active' ELSE billing_status END WHERE id=$1`, [tenant.id]);
          break;
        default: break;
      }
      if (tenant) { await d.query('UPDATE billing_events SET tenant_id=$2 WHERE id=$1', [event.id, tenant.id]); invalidateBilling(tenant.id); }
      return { received: true };
    });
  }, { public: true });

  // On-prem: activate a signed license key
  r.post('/api/license', adminOnly, async (req) => {
    if (config.billingMode !== 'license') throw bad('License keys are only used by on-prem installations.');
    const b = validate({ key: str({ required: true, max: 5000 }) }, req.body);
    const lic = verifyLicense(b.key);
    if (!lic.valid) throw bad(lic.error);
    if (new Date(lic.payload.expires) < new Date()) throw bad(`This license expired on ${new Date(lic.payload.expires).toDateString()}.`);
    await q('UPDATE tenants SET license_key=$2 WHERE id=$1', [req.user.tenant_id, b.key.trim()]);
    invalidateBilling(req.user.tenant_id);
    await audit(req, 'license.activated', 'tenant', req.user.tenant_id, { id: lic.payload.id, seats: lic.payload.seats, expires: lic.payload.expires });
    return billingFor(req.user.tenant_id);
  });
}

const later = (fn) => setImmediate(() => Promise.resolve().then(fn).catch((e) => console.warn(e.message)));

// Hourly: remind admins 3 days before a trial ends (cloud only)
export async function billingSweep() {
  if (config.billingMode !== 'stripe') return;
  const due = await many(`UPDATE tenants SET trial_reminded_at = now()
    WHERE billing_status='trialing' AND trial_reminded_at IS NULL AND trial_ends_at BETWEEN now() AND now() + interval '3 days'
    RETURNING id, name, trial_ends_at`);
  for (const t of due) {
    notifyAdmins(t.id, 'Your Aventra ITSM trial ends soon', `Your free trial for ${t.name} ends on ${new Date(t.trial_ends_at).toDateString()}.\n\nChoose a plan to keep everything running — your tickets, CMDB and settings stay exactly as they are:\n${config.appUrl}/#/admin/billing`);
  }
}
