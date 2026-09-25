// ---------------------------------------------------------------------------
// Site settings — the only place you need to edit.
// ---------------------------------------------------------------------------
const SITE = {
  // Set to true once the cloud app is live on Railway at APP_URL. While false, cloud sign-up buttons
  // are replaced with "download the free trial" / "contact sales" so no link points at a missing site.
  CLOUD_AVAILABLE: false,
  APP_URL: 'https://desk.aventratech.org',
  MAIN_SITE: 'https://aventratech.org',
  SALES_EMAIL: 'sales@aventratech.org',
  PRICE_STARTER: 29, // USD per technician per month (keep in sync with Stripe)
  PRICE_PRO: 59,
};

(function () {
  const $all = (sel) => Array.from(document.querySelectorAll(sel));
  const money = (n) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

  // Links driven by settings
  $all('[data-app]').forEach((a) => { a.href = SITE.APP_URL + a.getAttribute('data-app'); });
  $all('[data-main]').forEach((a) => { a.href = SITE.MAIN_SITE + (a.getAttribute('data-main') || ''); });
  $all('[data-mail]').forEach((a) => {
    const subject = a.getAttribute('data-mail');
    a.href = `mailto:${SITE.SALES_EMAIL}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`;
    if (a.hasAttribute('data-mail-text')) a.textContent = SITE.SALES_EMAIL;
  });
  $all('[data-cloud]').forEach((el) => el.classList.toggle('hidden', !SITE.CLOUD_AVAILABLE));
  $all('[data-no-cloud]').forEach((el) => el.classList.toggle('hidden', SITE.CLOUD_AVAILABLE));

  // Pricing toggle (monthly / yearly = 2 months free)
  const prices = { starter: SITE.PRICE_STARTER, pro: SITE.PRICE_PRO };
  function renderPrices(yearly) {
    $all('[data-price]').forEach((el) => {
      const m = prices[el.getAttribute('data-price')];
      el.textContent = money(yearly ? Math.round((m * 10 / 12) * 100) / 100 : m);
    });
    $all('[data-billed]').forEach((el) => {
      const m = prices[el.getAttribute('data-billed')];
      el.textContent = yearly ? `billed yearly (${money(m * 10)} per technician) — 2 months free` : 'billed monthly';
    });
    $all('[data-period]').forEach((b) => b.setAttribute('aria-pressed', String((b.getAttribute('data-period') === 'year') === yearly)));
  }
  $all('[data-period]').forEach((b) => b.addEventListener('click', () => renderPrices(b.getAttribute('data-period') === 'year')));
  if ($all('[data-price]').length) renderPrices(true);

  const y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();
})();
