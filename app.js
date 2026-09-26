import {
  randomSalt, fingerprints, findMatches, encodeInvite, decodeInvite, encodeResults, decodeResults,
  fromGoogle, isNoiseCalendar, parseIcs, inRange, dedupeEvents, sortEvents,
} from './core.js';

const $ = (id) => document.getElementById(id);
const CLIENT_ID = (window.CALMATCH_CONFIG || {}).googleClientId || '';
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const API = 'https://www.googleapis.com/calendar/v3';
const BASE = location.origin + location.pathname;

// Lives only in memory for this tab.
let invite = null;
let lastResultsLink = '';

// ---------- formatting ----------

const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtShort = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function fmtRange(from, to) {
  return `${fmtShort.format(new Date(from))} – ${fmtShort.format(new Date(to - 1))}`;
}

function renderEvents(list, events) {
  list.replaceChildren();
  for (const ev of events) {
    const li = document.createElement('li');
    const when = document.createElement('span');
    when.className = 'when';
    if (ev.allDay) {
      when.textContent = fmtDay.format(new Date(ev.date + 'T00:00:00')) + ' · all day';
    } else {
      const d = new Date(ev.start);
      when.textContent = `${fmtDay.format(d)} · ${fmtTime.format(d)}`;
    }
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = ev.title || '(no title)';
    li.append(title, when);
    list.append(li);
  }
}

function show(view) {
  for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== view;
}

function fail(msg) {
  $('error-msg').textContent = msg;
  show('view-error');
}

async function shareOrCopy(url, text, btn) {
  if (navigator.share) {
    try { await navigator.share({ title: 'calmatch', text, url }); return; } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  await copy(url, btn);
}

async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => (btn.textContent = old), 1500);
}

// ---------- Google (token held in a local variable, revoked right after use) ----------

function getGoogleToken() {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) return reject(new Error('Google sign-in is still loading — try again in a second.'));
    const client = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (resp) => (resp.error ? reject(new Error(resp.error_description || resp.error)) : resolve(resp.access_token)),
      error_callback: (err) => reject(new Error(err.type === 'popup_closed' ? 'Sign-in window was closed.' :
        err.type === 'popup_failed_to_open' ? 'Pop-up was blocked. Allow pop-ups, or open this link in Safari/Chrome.' : err.message || 'Sign-in failed.')),
    });
    client.requestAccessToken();
  });
}

async function gget(token, path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error(`Google Calendar said ${r.status}. ${r.status === 403 ? 'Make sure you ticked the calendar permission.' : ''}`);
  return r.json();
}

async function loadGoogleEvents(from, to, primaryOnly, status) {
  const token = await getGoogleToken();
  try {
    status('Reading your calendars…');
    let cals;
    if (primaryOnly) {
      cals = [{ id: 'primary', summary: 'primary' }];
    } else {
      const list = await gget(token, '/users/me/calendarList', { minAccessRole: 'reader', fields: 'items(id,summary,primary,selected)' });
      cals = (list.items || []).filter((c) => (c.primary || c.selected) && !isNoiseCalendar(c));
    }
    const events = [];
    for (const cal of cals) {
      let pageToken;
      do {
        const page = await gget(token, `/calendars/${encodeURIComponent(cal.id)}/events`, {
          timeMin: new Date(from).toISOString(),
          timeMax: new Date(to).toISOString(),
          singleEvents: 'true',
          maxResults: '2500',
          pageToken,
          fields: 'nextPageToken,items(iCalUID,summary,start,status,eventType,attendees(self,responseStatus))',
        });
        for (const item of page.items || []) {
          const ev = fromGoogle(item, cal.summary);
          if (ev) events.push(ev);
        }
        pageToken = page.nextPageToken;
        status(`Reading your calendars… ${events.length} events`);
      } while (pageToken);
    }
    return dedupeEvents(events);
  } finally {
    google.accounts.oauth2.revoke(token, () => {});
  }
}

async function loadIcsEvents(file, from, to) {
  const events = parseIcs(await file.text()).filter((e) => inRange(e, from, to));
  return dedupeEvents(events);
}

// ---------- connect widget ----------

function mountConnect(el, onEvents) {
  el.append($('connect-tpl').content.cloneNode(true));
  const btn = el.querySelector('button.google');
  const file = el.querySelector('input[type=file]');
  const statusEl = el.querySelector('.status');
  const status = (msg, isErr) => { statusEl.textContent = msg; statusEl.classList.toggle('err', !!isErr); };

  if (!CLIENT_ID) {
    btn.disabled = true;
    btn.title = 'Google sign-in is not configured for this site yet';
    status('Google sign-in isn\'t set up on this site yet (see README) — .ics files still work.');
  }

  const run = async (loader, viaGoogle) => {
    btn.disabled = true;
    try {
      const events = await loader();
      await onEvents(events, status, viaGoogle ? 'Google access revoked, nothing stored.' : 'Nothing stored.');
    } catch (e) {
      status(e.message, true);
    } finally {
      btn.disabled = !CLIENT_ID;
      file.value = '';
    }
  };

  btn.addEventListener('click', () => run(async () => {
    status('Waiting for Google…');
    const { from, to, primaryOnly } = el._range();
    return loadGoogleEvents(from, to, primaryOnly, status);
  }, true));
  file.addEventListener('change', () => file.files[0] && run(async () => {
    status('Reading file…');
    const { from, to } = el._range();
    return loadIcsEvents(file.files[0], from, to);
  }, false));
}

// ---------- view A: start ----------

function rangeA() {
  if (document.querySelector('input[name=range]:checked').value === 'custom') {
    const f = $('from').value, t = $('to').value;
    if (!f || !t) throw new Error('Pick both a start and end date.');
    const from = new Date(f + 'T00:00:00').getTime();
    const to = new Date(t + 'T00:00:00').getTime() + 86400000; // end date inclusive
    if (to <= from) throw new Error('The end date needs to be after the start date.');
    return { from, to };
  }
  const n = Math.min(36, Math.max(1, parseInt($('months').value, 10) || 3));
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1); // include today
  const start = new Date(end);
  start.setMonth(start.getMonth() - n);
  return { from: start.getTime(), to: end.getTime() };
}

function initStart() {
  show('view-start');
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
  $('to').value = today;
  for (const r of document.querySelectorAll('input[name=range]')) {
    r.addEventListener('change', () => ($('custom-range').hidden = r.value !== 'custom' || !r.checked));
  }
  $('months').addEventListener('focus', () => (document.querySelector('input[value=last]').checked = true, $('custom-range').hidden = true));

  const el = document.querySelector('.connect[data-who=a]');
  el._range = () => ({ ...rangeA(), primaryOnly: $('primary-only-a').checked });
  mountConnect(el, async (events, status, privacy) => {
    const { from, to } = rangeA();
    const loose = $('loose').checked;
    const salt = randomSalt();
    const hashes = await fingerprints(events, salt, loose);
    const link = BASE + '#i=' + encodeInvite({ salt, loose, from, to, name: $('name-a').value, hashes });
    events.length = 0; // drop our copy; only fingerprints remain in the link
    status('Done. ' + privacy);
    $('link-a').value = link;
    $('share-a-info').textContent = `${fmtRange(from, to)} · ${hashes.size} fingerprints · ${link.length.toLocaleString()} characters`;
    $('share-a').hidden = false;
    $('share-a').scrollIntoView({ behavior: 'smooth', block: 'start' });
    const who = $('name-a').value.trim();
    const text = `${who ? who + ' wants' : 'Want'} to see which calendar events we have in common? Open this and connect your calendar:`;
    $('share-a-btn').onclick = () => shareOrCopy(link, text, $('share-a-btn'));
    $('copy-a-btn').onclick = () => copy(link, $('copy-a-btn'));
  });
}

// ---------- view B: invite ----------

function initInvite() {
  show('view-invite');
  $('invite-title').textContent = `${invite.name || 'A friend'} wants to find events you have in common`;
  $('invite-range').textContent = `${fmtRange(invite.from, invite.to)}${invite.loose ? ' · including anything at the same start time' : ''}. Connect your calendar to compare — nothing is sent anywhere.`;

  const el = document.querySelector('.connect[data-who=b]');
  el._range = () => ({ from: invite.from, to: invite.to, primaryOnly: $('primary-only-b').checked });
  mountConnect(el, async (events, status, privacy) => {
    const matches = await findMatches(events, invite);
    const total = events.length;
    events.length = 0;
    showResults({
      title: matches.length ? `${matches.length} in common${invite.name ? ' with ' + invite.name : ''}` : 'Nothing in common',
      sub: `${fmtRange(invite.from, invite.to)} · compared ${total} of your events. ${privacy}`,
      events: matches,
      canSendBack: true,
    });
  });
}

// ---------- results ----------

function showResults({ title, sub, events, canSendBack }) {
  show('view-results');
  $('results-title').textContent = title;
  $('results-sub').textContent = sub;
  renderEvents($('results-list'), events);
  $('results-back').hidden = !canSendBack;
  if (!canSendBack) return;
  const build = async () => {
    if (!lastResultsLink) {
      lastResultsLink = BASE + '#r=' + await encodeResults({ name: $('name-b').value, from: invite.from, to: invite.to, events });
    }
    return lastResultsLink;
  };
  const who = () => $('name-b').value.trim();
  $('send-back-btn').onclick = async () => shareOrCopy(await build(),
    `${who() || 'I'} found ${events.length} event${events.length === 1 ? '' : 's'} we have in common:`, $('send-back-btn'));
  $('copy-back-btn').onclick = async () => copy(await build(), $('copy-back-btn'));
}

// ---------- boot ----------

async function boot() {
  const hash = location.hash.slice(1);
  // Keep the payload out of browser history once it's in memory.
  if (hash) history.replaceState(null, '', BASE);
  try {
    if (hash.startsWith('i=')) {
      invite = decodeInvite(hash.slice(2));
      initInvite();
    } else if (hash.startsWith('r=')) {
      const r = await decodeResults(hash.slice(2));
      const events = sortEvents(r.events);
      showResults({
        title: events.length ? `${events.length} in common${r.name ? ' with ' + r.name : ''}` : 'Nothing in common',
        sub: fmtRange(r.from, r.to),
        events,
        canSendBack: false,
      });
    } else {
      initStart();
    }
  } catch (e) {
    fail(e.message || 'That link didn\'t work — it may have been cut off when it was sent.');
  }
}

boot();
