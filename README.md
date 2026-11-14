# Follow Audit

A small **local** web app that answers:

- **Who am I following that doesn't follow me back?**
- **Who follows me that I don't follow back?**
- **Who unfollowed me since my last sync?**

Two ways to get your data in — no manual export needed for the first one:

1. **Automatic sync (recommended):** connect your Instagram account via the **official Instagram
   Graph API (OAuth)**. The app never sees your password — you approve access on Instagram's own
   page. Then press **⟳ Sync now** whenever you like; every sync is saved as a snapshot and diffs
   are computed automatically, so unfollowers are detected between syncs.
2. **Manual upload (fallback):** drag Instagram's official data-export JSON
   (`followers_1.json` / `following.json`) into the app. Needed if your account is a personal
   account, because the API only exposes follower/following lists for **Business or Creator**
   accounts.

> Not affiliated with Instagram. Uses only the official API and your own exported data.

## Quick start

```bash
cp .env.example .env        # then fill in IG_APP_ID / IG_APP_SECRET (see below)
npm start                   # or: node server.js
# open http://localhost:3000
```

No dependencies to install — plain Node.js (>= 18). The server binds to **127.0.0.1 only**; do not
expose it publicly (set `HOST` only if you know what you're doing).

## Setting up the Meta app (for automatic sync)

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create App**.
2. Add the product **Instagram API with Instagram login** (or "Facebook Login" + Instagram Graph
   API for page-connected business accounts).
3. In the app dashboard, note the **App ID** and **App Secret** → put them in `.env` as
   `IG_APP_ID` / `IG_APP_SECRET`.
4. Under the login product settings, add the redirect URI:
   `http://localhost:3000/auth/callback` (localhost is allowed for development).
5. Adjust `IG_SCOPES` in `.env` if your app was granted different permissions
   (default: `instagram_business_basic,instagram_business_manage_insights`).
6. Your Instagram account must be **Business or Creator** for the `followers` / `following`
   Graph API edges to return lists.
7. Restart the server, open the app, click **Connect Instagram**, approve on Instagram's page,
   then press **⟳ Sync now**.

Notes:

- Long-lived tokens last ~60 days; the app refreshes them automatically and will ask you to
  reconnect if they expire.
- Some permissions require Meta **app review** before they work outside your own account.
  For a personal tool, add yourself as a tester in the app dashboard (Roles → Roles).

## Using the app

- **Connect Instagram** → approve → **⟳ Sync now** pulls both lists via the API and saves a snapshot.
- Tabs: **Not following back** (you follow, they don't), **Fans**, **Mutual**, full lists, and
  **Changes / unfollowers** (diff between the latest sync and any earlier snapshot).
- Search filters the current tab; click a username to open the profile, **copy** to copy it;
  **Export CSV** downloads the current list.
- **Snapshots** are listed at the bottom (source: `api` or `upload`) and stored locally in
  `data/store.json`. Delete individual snapshots or clear all.
- **Sample data** loads fake data to try the UI (not saved as a snapshot).
- Manual upload: request an export from Instagram (**Settings → Your activity → Download your
  information**, format **JSON**, select **Followers and following**), then drop the
  `followers_*.json` and `following_*.json` files into the drop zones.

## Privacy & security

- Everything runs on your machine: the server listens on `127.0.0.1`, and data is stored only in
  `data/store.json` (gitignored). The access token is stored there too — treat that file like a
  password and never commit or share it. `.env` holds your app secret and is also gitignored.
- The web UI is protected by an HttpOnly session cookie; the OAuth flow uses a CSRF `state` parameter.
- Responses set `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`.
- To revoke access at any time: **Disconnect** in the app, and/or remove the app under
  instagram.com → Settings → Apps and Websites.

## Project layout

```
server.js           zero-dependency backend: OAuth, Graph API sync, snapshots, REST API, static files
index.html          UI shell
styles.css          styling
app.js              frontend controller (fetches /api/*)
lib/parse.js        parsing + set-diff logic (shared browser/Node)
lib/sample.js       deterministic sample-data generator
test/parse.test.js  unit tests for parsing/diffing
test/server.test.js API tests with a stubbed Instagram client (no network)
```

## Tests

```bash
npm test
```

## Limitations

- Instagram's API returns only the **current** lists, so "unfollowers" are detected by comparing
  snapshots taken at different times.
- Follower/following list edges require a Business/Creator account; personal accounts must use
  the manual JSON upload.
- Graph API rate limits apply; the app pages through results automatically.
