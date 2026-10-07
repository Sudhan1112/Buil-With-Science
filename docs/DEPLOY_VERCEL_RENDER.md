# Deploy CareFit on Vercel + Render + Supabase

No custom domain. Browser origin is `https://<app>.vercel.app`; API is
`https://<api>.onrender.com`; durable state lives in Supabase.

## 1. Supabase

1. Create a project.
2. Run the SQL in [`supabase/migrations/20260307120000_carefit.sql`](../supabase/migrations/20260307120000_carefit.sql) (SQL editor or CLI).
3. Confirm Storage bucket `media` exists (the migration inserts it).
4. Copy **Project URL** and **service_role** key (Settings → API). Never put the service role in Vercel.

## 2. Import existing `./data` (once)

```bash
set SUPABASE_URL=https://xxxx.supabase.co
set SUPABASE_SERVICE_ROLE_KEY=eyJ...
node scripts/import-to-supabase.mjs ./data
```

Copy `data/secret` into Render as `SESSION_SECRET` if you want existing session cookies to keep verifying; otherwise mint a new secret and everyone signs in again with password.

## 3. Render (API)

- Blueprint: [`render.yaml`](../render.yaml), or Docker with root `api/` and `api/Dockerfile`.
- Env: `ORIGIN`, `RP_ID`, `SESSION_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PASSWORD_LOGIN=1`, `TRUST_PROXY=1`.
- Single instance (WebAuthn challenges are in-memory).
- Free tier sleeps after ~15 minutes; the web app allows up to 90s on GET for cold starts.

Use a placeholder `ORIGIN`/`RP_ID` until Vercel has a URL, then set the real host and restart.

## 4. Vercel (frontend)

- Root directory: `frontend`
- Framework: Vite (see `frontend/vercel.json` for SPA rewrites)
- Env (Production): `VITE_API_BASE=https://<api>.onrender.com`
- After first deploy, set Render `ORIGIN=https://<app>.vercel.app` and `RP_ID=<app>.vercel.app` (full subdomain, not `vercel.app`).

## 5. First login

1. Open the Vercel URL.
2. Sign in as **Sudhan** with password (passkeys from localhost/Tailscale will not work on the new origin).
3. Re-register a passkey on that host.
4. Release device locks in Admin if a phone still holds an old binding.

## Local development

Leave `SUPABASE_*` and `VITE_API_BASE` unset: `cd frontend && npm run dev` proxies `/api` to a local `node server.js` with `DATA_DIR=../data`.
