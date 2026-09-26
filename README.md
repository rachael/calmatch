# calmatch

Find the calendar events you and a friend have in common. It's a one-time comparison that runs in your browser. There's no server and no account, and nothing is stored.

**→ https://rachael.github.io/calmatch**

## How it works

1. **You** pick a range: the last N months, or custom dates. Then you connect Google Calendar. You get back a link, which you send to your friend.
2. **Your friend** opens the link and connects their calendar. They see the events you both have.
3. They tap **Send results back**. You open that link and see the same list.

Privacy:

- The page is fully static: HTML plus JS on GitHub Pages. Everything runs on your device.
- Google access is read-only (`calendar.readonly`). It's requested through a pop-up, held in memory only, and **revoked** as soon as your events are loaded. There are no refresh tokens, cookies or localStorage.
- The invite link holds only the date range, a random salt, and a 4-byte salted SHA-256 fingerprint for each event. It holds no titles or times. The data sits after the `#`, and browsers never send that part to a server. The page also wipes it from the address bar and history once it's loaded.
- Two events count as "common" when they are the same invite at the same start time (same iCal UID), or when they have the same title (ignoring case and punctuation) at the same start. There's an optional loose mode: anything at the exact same start time.
- The results-back link holds only the events you both have, compressed into the `#`.
- Caveat: fingerprints are scrambled, not encrypted. Someone who holds the link could test guesses. Only send it to the person you're comparing with.

Declined events, cancelled events, working-location entries, and holiday/birthday/weather calendars are skipped.

### Not on Google?

Use **"or use an .ics file"** instead. Any calendar export works (Apple Calendar on Mac, Outlook, Fastmail…). One limit: recurring events from a file only count their first occurrence.

## One-time setup: Google OAuth client ID (~3 min)

The site needs a Google OAuth client ID. It is public and safe to commit.

1. Go to <https://console.cloud.google.com/> and create a project, e.g. `calmatch`.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type **External**. App name `calmatch`, plus your email.
   - **Data access / Scopes** → add `https://www.googleapis.com/auth/calendar.readonly`.
   - **Audience → Test users** → add your Google account **and your friend's**. The app can stay in "Testing" mode forever for up to 100 test users. People will see a "Google hasn't verified this app" screen: tap *Continue*.
4. **Clients / Credentials → Create OAuth client ID** → type **Web application**.
   - **Authorized JavaScript origins**: `https://rachael.github.io`. Add `http://localhost:8765` too if you want to test locally.
   - No redirect URIs are needed.
5. Paste the client ID into [`config.js`](config.js) and push.

## One-time setup: GitHub Pages

Repo **Settings → Pages** → Source: *Deploy from a branch* → `main` / `(root)`. The site appears at `https://rachael.github.io/calmatch/`.

## Local dev

```sh
python3 -m http.server 8765    # then open http://localhost:8765
npm test                       # unit tests for the matching/link logic
npm run e2e                    # browser test with a fake Google (needs the server above on :8765 + playwright)
```

Files: `index.html` (markup), `style.css`, `app.js` (UI + Google), `core.js` (fingerprints, link encoding, .ics parser; no DOM), `config.js`.
