import test from 'node:test';
import assert from 'node:assert/strict';
import {
  randomSalt, fingerprints, findMatches, encodeInvite, decodeInvite,
  encodeResults, decodeResults, parseIcs, fromGoogle, dedupeEvents, isNoiseCalendar,
} from '../core.js';

const at = (iso) => Date.parse(iso);
const A = [
  { uid: 'inv-1@google.com', title: 'Dinner at Sam\'s', allDay: false, start: at('2026-08-01T19:00:00Z') },
  { uid: 'a-only', title: 'Dentist', allDay: false, start: at('2026-08-02T15:00:00Z') },
  { uid: 'x1', title: 'Beach Trip!', allDay: true, date: '2026-08-10' },
  { uid: 'a-gym', title: 'Gym', allDay: false, start: at('2026-08-03T07:00:00Z') },
];
const B = [
  // same invite, B renamed it
  { uid: 'inv-1@google.com', title: 'dinner w/ rachael', allDay: false, start: at('2026-08-01T19:00:00Z') },
  // separately created, same title & time
  { uid: 'y9', title: 'beach trip', allDay: true, date: '2026-08-10' },
  { uid: 'b-only', title: 'Dentist', allDay: false, start: at('2026-08-02T16:00:00Z') },
  { uid: 'b-yoga', title: 'Yoga', allDay: false, start: at('2026-08-03T07:00:00Z') },
];

test('strict match: same invite or same title+time', async () => {
  const salt = randomSalt();
  const from = at('2026-07-01T00:00:00Z'), to = at('2026-09-01T00:00:00Z');
  const hashes = await fingerprints(A, salt, false);
  const link = encodeInvite({ salt, loose: false, from, to, name: 'Rachael', hashes });
  const inv = decodeInvite(link);
  assert.equal(inv.name, 'Rachael');
  assert.equal(inv.from, from);
  assert.equal(inv.to, to);
  assert.equal(inv.loose, false);
  assert.deepEqual([...inv.salt], [...salt]);
  const m = await findMatches(B, inv);
  assert.deepEqual(m.map((e) => e.uid), ['inv-1@google.com', 'y9']);
});

test('loose match also counts same start time', async () => {
  const salt = randomSalt();
  const inv = decodeInvite(encodeInvite({ salt, loose: true, from: 0, to: 6e12, name: '', hashes: await fingerprints(A, salt, true) }));
  const m = await findMatches(B, inv);
  assert.deepEqual(m.map((e) => e.uid), ['inv-1@google.com', 'b-yoga', 'y9']);
});

test('different salt never matches', async () => {
  const hashes = await fingerprints(A, randomSalt(), false);
  const inv = decodeInvite(encodeInvite({ salt: randomSalt(), loose: false, from: 0, to: 6e12, hashes }));
  assert.equal((await findMatches(B, inv)).length, 0);
});

test('link carries no plaintext', async () => {
  const salt = randomSalt();
  const link = encodeInvite({ salt, loose: false, from: 0, to: 6e12, hashes: await fingerprints(A, salt, false) });
  const bytes = Buffer.from(link, 'base64url').toString('latin1');
  for (const w of ['Dentist', 'Dinner', 'inv-1', 'Beach']) assert.ok(!bytes.includes(w));
});

test('truncated link rejected', () => {
  assert.throws(() => decodeInvite('AQ'));
});

test('results roundtrip', async () => {
  const s = await encodeResults({ name: 'Sam', from: 0, to: 6e12, events: [A[0], A[2]] });
  const r = await decodeResults(s);
  assert.equal(r.name, 'Sam');
  assert.equal(r.events[0].start, A[0].start);
  assert.equal(r.events[1].date, '2026-08-10');
  assert.equal(r.events[1].title, 'Beach Trip!');
});

test('ics parse', () => {
  const ics = [
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:abc@x', 'SUMMARY:Party\\, yay', 'DTSTART:20260801T190000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:tz@x', 'SUMMARY:NYC', 'DTSTART;TZID=America/New_York:20260801T150000', 'BEGIN:VALARM', 'DTSTART:19990101T000000Z', 'END:VALARM', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:d@x', 'SUMMARY:Long', ' Title', 'DTSTART;VALUE=DATE:20260810', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c@x', 'SUMMARY:Cancelled', 'STATUS:CANCELLED', 'DTSTART:20260801T190000Z', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const ev = parseIcs(ics);
  assert.equal(ev.length, 3);
  assert.equal(ev[0].title, 'Party, yay');
  assert.equal(ev[1].start, at('2026-08-01T19:00:00Z'));
  assert.equal(ev[2].title, 'LongTitle');
  assert.equal(ev[2].date, '2026-08-10');
});

test('google mapping skips declined/cancelled/workingLocation', () => {
  assert.equal(fromGoogle({ status: 'cancelled', start: {} }), null);
  assert.equal(fromGoogle({ start: { date: '2026-01-01' }, eventType: 'workingLocation' }), null);
  assert.equal(fromGoogle({ start: { dateTime: '2026-01-01T10:00:00Z' }, attendees: [{ self: true, responseStatus: 'declined' }] }), null);
  const e = fromGoogle({ iCalUID: 'u', summary: 'S', start: { dateTime: '2026-01-01T10:00:00-05:00' } });
  assert.equal(e.start, at('2026-01-01T15:00:00Z'));
  assert.ok(isNoiseCalendar({ id: 'en.usa#holiday@group.v.calendar.google.com' }));
  assert.equal(dedupeEvents([e, { ...e }]).length, 1);
});
