# Inventory Tagger — Hosted (Phase 1)

Your app, online: same look and features, but your data lives on a server (so it's the
same on every device) and you log in with a password. Phase 2 adds the eBay connection.

This folder is the whole app:

- `server.js` — the little backend (serves the app + stores your data)
- `public/index.html` — the app itself (your data is already baked in as the starting point)
- `package.json` — tells the host what to install/run
- `.env.example` — the settings you'll set on Railway

---

## Deploy it on Railway (no terminal needed)

You'll do this once. Takes ~15 minutes.

### Step 1 — Put the code on GitHub
1. Make a free account at **github.com**.
2. Click **New repository** → name it `inventory-tagger` → **Create**.
3. On the new repo page click **“uploading an existing file”**, then drag in **everything in this
   folder EXCEPT the `node_modules` folder** (i.e. `server.js`, `package.json`, `.gitignore`,
   `.env.example`, and the whole `public` folder). Click **Commit changes**.

   *(If a `node_modules` folder exists, don't upload it — the host rebuilds it.)*

### Step 2 — Deploy on Railway
1. Go to **railway.app** and sign up (you can sign in with GitHub).
2. **New Project** → **Deploy from GitHub repo** → pick `inventory-tagger`.
3. Railway starts building it automatically.

### Step 3 — Add the database
1. In the same project, click **+ New** → **Database** → **Add PostgreSQL**.
2. That's it — Railway automatically gives the app a `DATABASE_URL`. You don't copy anything.

### Step 4 — Set your password
1. Click your app service → **Variables** tab → **+ New Variable**, add these two:
   - `APP_PASSWORD` = a password you choose (this is how you log in)
   - `SECRET` = any long random jumble of letters/numbers (keep it private)
2. Railway redeploys automatically.

### Step 5 — Open it
1. On the app service → **Settings** → **Networking** → **Generate Domain**.
2. You'll get a link like `inventory-tagger-production.up.railway.app`.
3. Open it, log in with your `APP_PASSWORD`. **Your data loads automatically** and is now saved
   in the cloud. Open the same link on your phone or any computer and log in — same data.

---

## Day-to-day

- Just use it like before. Every change saves to the cloud automatically (you'll see a small
  “Saved to cloud” note). If you're offline it saves on the device and syncs the next time.
- **Log in** once per device; it stays signed in.
- **Add to your phone home screen:** open the link in Safari/Chrome → Share → *Add to Home Screen*
  for an app-like icon.

## Cost

- Railway: roughly **$5–10/month** (includes the database). eBay API (Phase 2) is free.
- Optional custom domain: ~$10–15/year.

## Good to know

- Your original local `InventoryTagger.html` keeps working untouched — nothing here changes it.
- **Backups:** the **Export** button still downloads a full JSON anytime — keep doing that
  occasionally as insurance.
- **Updates:** when I give you new features, you replace the changed files in the GitHub repo and
  Railway redeploys automatically. Your data in the database is untouched by code updates.

## Test on your own computer first (optional, needs Node installed)

```
npm install
APP_PASSWORD=test npm start
```
Then open `http://localhost:3000` and log in with `test`. (Locally, without a database, data is
temporary — that's expected; the real database only exists on Railway.)
