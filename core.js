// calmatch core: pure functions, no DOM. Shared by the app and the tests.
//
// How matching works without a server:
//   1. Person A loads their events in the browser and turns each one into a few
//      "keys" (e.g. same invite + same start, or same title + same start).
//   2. Each key is hashed with a random per-link salt and cut to 4 bytes.
//      Only these fingerprints (plus the date range) go into the link.
//   3. Person B opens the link, loads their own events, hashes them the same
//      way, and any event whose fingerprint appears in A's set is a match.
//   The link lives in the URL #fragment, which browsers never send to servers.

export const VERSION = 1;
export const FLAG_LOOSE = 1;
const HEADER = 19; // version, flags, salt(8), from(4), to(4), nameLen(1)

const te = new TextEncoder();
const td = new TextDecoder();

// ---------- base64url ----------

export function b64urlEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- event keys & fingerprints ----------

export function normTitle(t) {
  return (t || '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// ev: { uid, title, allDay, date: 'YYYY-MM-DD' (all-day), start: ms (timed) }
export function eventKeys(ev, loose) {
  const when = ev.allDay ? 'd' + ev.date : 'm' + Math.round(ev.start / 60000);
  const keys = [];
  if (ev.uid) keys.push('u|' + ev.uid + '|' + when);
  if (loose && !ev.allDay) {
    keys.push('s|' + when);
  } else {
    const t = normTitle(ev.title);
    if (t) keys.push('t|' + when + '|' + t);
  }
  return keys;
}

export function randomSalt() {
  return crypto.getRandomValues(new Uint8Array(8));
}

async function hash32(salt, key) {
  const kb = te.encode(key);
  const buf = new Uint8Array(salt.length + kb.length);
  buf.set(salt);
  buf.set(kb, salt.length);
  const d = new DataView(await crypto.subtle.digest('SHA-256', buf));
  return d.getUint32(0);
}

export async function fingerprints(events, salt, loose) {
  const set = new Set();
  for (const ev of events) {
    for (const k of eventKeys(ev, loose)) set.add(await hash32(salt, k));
  }
  return set;
}

export async function findMatches(events, invite) {
  const out = [];
  for (const ev of events) {
    for (const k of eventKeys(ev, invite.loose)) {
      if (invite.hashes.has(await hash32(invite.salt, k))) { out.push(ev); break; }
    }
  }
  return sortEvents(out);
}

export function sortEvents(events) {
  const t = (e) => (e.allDay ? Date.parse(e.date + 'T00:00:00') : e.start);
  return events.slice().sort((a, b) => t(a) - t(b));
}

// Same event pulled from two of your own calendars counts once.
export function dedupeEvents(events) {
  const seen = new Set();
  return events.filter((ev) => {
    const k = (ev.uid || normTitle(ev.title)) + '|' + (ev.allDay ? ev.date : ev.start);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------- invite link payload ----------

export function encodeInvite({ salt, loose, from, to, name, hashes }) {
  let nb = te.encode((name || '').trim());
  while (nb.length > 60) nb = te.encode(td.decode(nb.subarray(0, nb.length - 1)).replace(/�$/, ''));
  const hs = [...hashes].sort((a, b) => a - b);
  const buf = new Uint8Array(HEADER + nb.length + hs.length * 4);
  const dv = new DataView(buf.buffer);
  buf[0] = VERSION;
  buf[1] = loose ? FLAG_LOOSE : 0;
  buf.set(salt, 2);
  dv.setUint32(10, Math.floor(from / 60000));
  dv.setUint32(14, Math.floor(to / 60000));
  buf[18] = nb.length;
  buf.set(nb, HEADER);
  let o = HEADER + nb.length;
  for (const h of hs) { dv.setUint32(o, h); o += 4; }
  return b64urlEncode(buf);
}

export function decodeInvite(str) {
  const buf = b64urlDecode(str);
  if (buf.length < HEADER || buf[0] !== VERSION) throw new Error('This link is from a different version of calmatch, or got cut off.');
  const dv = new DataView(buf.buffer);
  const nameLen = buf[18];
  const body = buf.length - HEADER - nameLen;
  if (body < 0 || body % 4) throw new Error('This link looks incomplete — ask for it again.');
  const hashes = new Set();
  for (let o = HEADER + nameLen; o < buf.length; o += 4) hashes.add(dv.getUint32(o));
  return {
    loose: !!(buf[1] & FLAG_LOOSE),
    salt: buf.slice(2, 10),
    from: dv.getUint32(10) * 60000,
    to: dv.getUint32(14) * 60000,
    name: td.decode(buf.subarray(HEADER, HEADER + nameLen)),
    hashes,
  };
}

// ---------- results-back link payload ----------
// Only the already-common events (both of you have them), compressed.

async function pipeThrough(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

export async function encodeResults({ name, from, to, events }) {
  const data = {
    n: (name || '').trim().slice(0, 40),
    f: Math.floor(from / 60000),
    t: Math.floor(to / 60000),
    e: events.map((e) => [e.title || '', e.allDay ? e.date : Math.round(e.start / 60000)]),
  };
  const raw = te.encode(JSON.stringify(data));
  if (typeof CompressionStream !== 'undefined') {
    const z = await pipeThrough(raw, new CompressionStream('deflate-raw'));
    return 'z' + b64urlEncode(z);
  }
  return 'j' + b64urlEncode(raw);
}

export async function decodeResults(str) {
  let raw = b64urlDecode(str.slice(1));
  if (str[0] === 'z') raw = await pipeThrough(raw, new DecompressionStream('deflate-raw'));
  else if (str[0] !== 'j') throw new Error('Unrecognised results link.');
  const d = JSON.parse(td.decode(raw));
  return {
    name: d.n,
    from: d.f * 60000,
    to: d.t * 60000,
    events: d.e.map(([title, w]) =>
      typeof w === 'string' ? { title, allDay: true, date: w } : { title, allDay: false, start: w * 60000 }),
  };
}

// ---------- Google Calendar event → internal ----------

export function fromGoogle(item, calendar) {
  if (item.status === 'cancelled' || !item.start) return null;
  if (item.eventType === 'workingLocation') return null;
  const me = (item.attendees || []).find((a) => a.self);
  if (me && me.responseStatus === 'declined') return null;
  const allDay = !!item.start.date;
  return {
    uid: item.iCalUID || '',
    title: item.summary || '',
    allDay,
    date: allDay ? item.start.date : undefined,
    start: allDay ? undefined : Date.parse(item.start.dateTime),
    calendar,
  };
}

// Calendars that everybody has and would "match" on noise.
export function isNoiseCalendar(cal) {
  return /#holiday@|#contacts@|#weather@|#weeknum@|addressbook#/.test(cal.id || '');
}

// ---------- minimal .ics parser (fallback for non-Google calendars) ----------

function tzOffsetMs(tz, utcMs) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    let t = guess - tzOffsetMs(tz, guess);
    t = guess - tzOffsetMs(tz, t); // settle across DST edges
    return t;
  } catch {
    return new Date(y, mo - 1, d, h, mi, s).getTime(); // unknown TZID → treat as local
  }
}

function parseIcsDate(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined || params.VALUE === 'DATE') return { allDay: true, date: `${y}-${mo}-${d}` };
  const args = [+y, +mo, +d, +h, +mi, +(s || 0)];
  let start;
  if (z) start = Date.UTC(args[0], args[1] - 1, ...args.slice(2));
  else if (params.TZID) start = zonedToUtc(...args, params.TZID.replace(/^"|"$/g, ''));
  else start = new Date(args[0], args[1] - 1, ...args.slice(2)).getTime();
  return { allDay: false, start };
}

function unescapeIcs(s) {
  return s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
}

export function parseIcs(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let cur = null;
  let depth = 0; // skip nested blocks like VALARM
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; depth = 0; continue; }
    if (!cur) continue;
    if (line.startsWith('BEGIN:')) { depth++; continue; }
    if (line.startsWith('END:') && depth) { depth--; continue; }
    if (line === 'END:VEVENT') {
      if (cur.when && cur.status !== 'CANCELLED') {
        events.push({ uid: cur.uid || '', title: cur.title || '', ...cur.when, recurring: !!cur.rrule, calendar: 'file' });
      }
      cur = null;
      continue;
    }
    if (depth) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const [name, ...paramParts] = line.slice(0, colon).split(';');
    const value = line.slice(colon + 1);
    const params = Object.fromEntries(paramParts.map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).toUpperCase(), p.slice(i + 1)];
    }));
    switch (name.toUpperCase()) {
      case 'UID': cur.uid = value.trim(); break;
      case 'SUMMARY': cur.title = unescapeIcs(value); break;
      case 'DTSTART': cur.when = parseIcsDate(value, params); break;
      case 'STATUS': cur.status = value.trim().toUpperCase(); break;
      case 'RRULE': cur.rrule = value; break;
    }
  }
  return events;
}

export function inRange(ev, from, to) {
  const t = ev.allDay ? Date.parse(ev.date + 'T00:00:00') : ev.start;
  return t >= from && t < to;
}
