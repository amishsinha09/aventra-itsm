// Browser smoke test of the core ITSM loop. Requires Playwright and a seeded server:
//   npm run seed && npm start   then   BASE_URL=http://localhost:3000 node test/ui.e2e.mjs
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const base = process.env.BASE_URL || 'http://localhost:3000';
const pw = process.env.DEMO_PASSWORD || 'Demo12345!';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];
async function session(email) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/401/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${base}/#/login`);
  await page.fill('#email', email); await page.fill('#password', pw);
  await page.click('button[type=submit]');
  await page.waitForSelector('#view');
  return page;
}
const title = `Keyboard stopped working ${Date.now()}`;

// 1. Requester reports an issue from the portal
const req = await session('sara@acmedental.example');
await req.click('text=Report an issue >> nth=0');
await req.fill('#title', title);
await req.fill('#description', 'No keys respond after a coffee spill.');
await req.click('button:has-text("Submit")');
await req.waitForSelector('h1:has-text("Keyboard stopped working")');
const url = req.url(); const id = url.split('/').pop();
console.log('requester created ticket', id);

// 2. Agent picks it up, replies, resolves
const agent = await session('priya@northwind.example');
await agent.goto(`${base}/#/tickets/${id}`);
await agent.click('button:has-text("Assign to me")');
await agent.waitForSelector('.badge:has-text("In progress")');
await agent.fill('#composer textarea', 'Sending a replacement keyboard today.');
await agent.click('#composer button[type=submit]');
await agent.waitForSelector('.bubble:has-text("replacement keyboard")');
await agent.click('button[data-status=resolved]');
await agent.fill('textarea[name=resolution_notes]', 'Replaced keyboard.');
await agent.click('.modal button[type=submit]');
await agent.waitForSelector('.badge:has-text("Resolved")');
console.log('agent resolved');

// 3. Requester sees the reply and rates the experience
await req.goto(`${base}/#/tickets/${id}`); await req.reload();
await req.waitForSelector('.bubble:has-text("replacement keyboard")');
await req.click('[data-star="5"]');
await req.fill('#csat textarea', 'Super quick!');
await req.click('#csat button[type=submit]');
await req.waitForSelector('text=Customer satisfaction');
console.log('requester rated 5 stars');

// 4. Rating shows up in reports
await agent.goto(`${base}/#/reports`);
await agent.waitForSelector('text=Super quick!');

// 5. Global search finds the ticket
await agent.fill('#gsearch', 'keyboard coffee');
await agent.waitForSelector('#gresults a');

assert.deepEqual(errors, [], 'no browser errors');
console.log('UI E2E PASSED');
await browser.close();
