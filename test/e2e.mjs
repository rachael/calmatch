// End-to-end browser test with a fake Google (no real account needed).
// Run: python3 -m http.server 8765 & node test/e2e.mjs
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(execSync('npm root -g').toString().trim() + '/playwright'); }

const BASE = process.env.BASE || 'http://localhost:8765/';
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } };

// Two people's calendars, keyed by fake token.
const CALS = {
  tokA: [
    { iCalUID: 'dinner@google.com', summary: "Dinner at Sam's", start: { dateTime: '2026-08-01T19:00:00Z' } },
    { iCalUID: 'a1', summary: 'Dentist', start: { dateTime: '2026-08-02T15:00:00Z' } },
    { iCalUID: 'a2', summary: 'Beach trip', start: { date: '2026-08-10' } },
    { iCalUID: 'a3', summary: 'Skipped party', start: { dateTime: '2026-08-05T20:00:00Z' }, attendees: [{ self: true, responseStatus: 'declined' }] },
  ],
  tokB: [
    { iCalUID: 'dinner@google.com', summary: 'Dinner w/ Rachael', start: { dateTime: '2026-08-01T19:00:00Z' } },
    { iCalUID: 'b2', summary: 'BEACH TRIP', start: { date: '2026-08-10' } },
    { iCalUID: 'b3', summary: 'Yoga', start: { dateTime: '2026-08-02T15:00:00Z' } },
    { iCalUID: 'b4', summary: 'Skipped party', start: { dateTime: '2026-08-05T20:00:00Z' } },
  ],
};

const fakeGis = (token) => `
  window.CALMATCH_CONFIG = { googleClientId: 'test-client' };
  window.__revoked = [];
  window.google = { accounts: { oauth2: {
    initTokenClient: (o) => ({ requestAccessToken: () => setTimeout(() => o.callback({ access_token: '${token}' }), 10) }),
    revoke: (t, cb) => { window.__revoked.push(t); cb && cb(); },
  } } };`;

async function page(ctx, token) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => assert(false, 'page error: ' + e.message));
  await p.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: fakeGis(token) }));
  await p.route(/accounts\.google\.com/, (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
  await p.route(/googleapis\.com/, (r) => {
    const url = new URL(r.request().url());
    const tok = r.request().headers().authorization.split(' ')[1];
    const body = url.pathname.endsWith('/calendarList')
      ? { items: [{ id: 'me@x', summary: 'Me', primary: true }, { id: 'en.usa#holiday@group.v.calendar.google.com', selected: true }] }
      : { items: url.pathname.includes('holiday') ? [{ iCalUID: 'xmas', summary: 'Holiday', start: { date: '2026-08-10' } }] : CALS[tok] };
    r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  return p;
}

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });

// A: create invite
const a = await page(ctx, 'tokA');
await a.goto(BASE);
await a.check('input[value=custom]');
await a.fill('#from', '2026-07-01');
await a.fill('#to', '2026-08-31');
await a.fill('#name-a', 'Rachael');
await a.click('.connect[data-who=a] button.google');
await a.waitForSelector('#share-a:not([hidden])');
const link = await a.inputValue('#link-a');
assert(link.includes('#i='), 'invite link generated');
assert(!/Dentist|Dinner|Beach/i.test(decodeURIComponent(link)), 'no plaintext in link');
assert((await a.evaluate(() => window.__revoked)).includes('tokA'), 'A token revoked');

// B: open invite, compare
const b = await page(ctx, 'tokB');
await b.goto(link);
assert(!b.url().includes('#'), 'fragment scrubbed from address bar');
assert((await b.textContent('#invite-title')).includes('Rachael'), 'invite shows name');
await b.fill('#name-b', 'Sam');
await b.click('.connect[data-who=b] button.google');
await b.waitForSelector('#view-results:not([hidden])');
const titles = await b.$$eval('#results-list .title', (els) => els.map((e) => e.textContent));
assert(JSON.stringify(titles) === JSON.stringify(['Dinner w/ Rachael', 'BEACH TRIP']), 'matches: ' + titles);
assert((await b.evaluate(() => window.__revoked)).includes('tokB'), 'B token revoked');

// B → A: results link
await b.click('#copy-back-btn');
await b.waitForFunction(() => document.querySelector('#copy-back-btn').textContent === 'Copied!');
const back = await b.evaluate(() => navigator.clipboard.readText());
const a2 = await page(ctx, 'none');
await a2.goto(back);
await a2.waitForSelector('#view-results:not([hidden])');
assert((await a2.textContent('#results-title')) === '2 in common with Sam', 'A sees results');

await browser.close();
console.log('e2e ok');
