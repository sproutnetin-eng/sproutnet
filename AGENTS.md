# SproutNet — Agent Guide

## Quick start
```bash
npm run serve      # Express server at http://localhost:3001 (PORT env overrides)
npm run serve:dev  # with node --watch reload
npm install        # dependencies (no build step)
```

## Stack
- **Node.js 20+** + **Express 4** REST API, vanilla HTML/CSS/JS frontend
- **Supabase** (auth, database, storage via `@supabase/supabase-js`)
- **multer** (memory storage) for uploads, **nodemailer** for OTP email
- No framework, no bundler, no testing framework.

## Project structure
```
server/
  server.js                  entry: gzip, static client/ (/assets cached 1h), 60s cache on GET /api/public/*, API mounts
  supabase.js                getAdmin() (service role) + getUserClient(token)
  middleware/auth.js         authRequired / optionalAuth / loadProfile / requireRole
  middleware/upload.js       multer memory storage (replaces req.formData())
  lib/ + lib/workspace/     ported utilities, same export names as original TS lib
  routes/                    13 routers with full /api/... paths:
                             problems, enrollments, submissions, teams, workspaces,
                             mentors, blogs, auth, admin, misc,
                             public-reads, student-reads, staff-reads
client/
  *.html                     43 pages (clean URLs mapped in server.js)
  assets/app.js              Supabase browser client, api() helper (Bearer token),
                             requireAuth/requireRole guards, nav
  assets/styles.css          shared theme (.card .btn .input .table .badge .alert)
supabase/migrations/         raw SQL (apply manually in Supabase dashboard)
scripts/                     tsx utilities: seed mentors/test data, run migrations
```

## Key non-obvious patterns

### Auth is Bearer-token based
The browser holds the Supabase session (localStorage) and sends it as `Authorization: Bearer` via the `api()` helper in `client/assets/app.js`. Server middleware verifies the JWT with the anon client (`getUserFromToken`) and attaches `req.user` + `req.supabase`. Service-role work uses `getAdmin()`. All role enforcement lives in the API; page guards are UX only.

### Route files
Each file in `server/routes/` exports an `express.Router` with full `/api/...` paths and is mounted in `server.js`. `[id]`-style params are Express `:id` params. Upload routes use `upload.single('file')` and pass `req.file.buffer` to Supabase storage.

### Read-model routers
Page data that needs cross-user queries lives in `public-reads.js`, `student-reads.js`, `staff-reads.js` (`GET /api/public|student|staff|...`, admin client). Public single-table reads happen directly from the browser via `sb()`.

### Blog local fallback
When Supabase blog tables don't exist (migration not applied), blogs fall back to `.data/blogs.json` (gitignored via `.data/`). Controlled by env `BLOGS_ALLOW_LOCAL_FALLBACK` (default `true`).

### Supabase migrations
SQL files in `supabase/migrations/` must be applied manually in the Supabase SQL editor. No migration runner is configured. `scripts/run-migration.ts` can apply a file via direct Postgres connection.

### CSS style
Plain CSS in `client/assets/styles.css` with shared classes (`.card`, `.btn`, `.btn-primary`, `.input`, `.table`, `.badge`, `.alert`). New pages must follow the template: stylesheet link, `#sn-nav`, `.container`, `/assets/config.js` + module script importing `/assets/app.js`.

### Enrollments
- Students can have at most `MAX_ACTIVE_ENROLLMENTS = 2` active enrollments at once.
- Enrollments auto-complete when all milestones are submitted (checked in `syncCompletedEnrollments`).

### Registration
- Student signup checks `allowed_domains` table — only `@jyothyit.ac.in` is configured during Phase 1.
- New users are created via `supabase.auth.signUp()` in the browser, then profile fields upserted via `POST /api/auth/profile`.

### Env
`.env` is **committed** (Supabase URL + keys) despite `.env*` in `.gitignore`. Needed for local dev. Required vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Optional: `PORT` (default 3001), SMTP settings, `GROQ_API_KEY`.

### File uploads
- Problem thumbnails: `problem-thumbnails` bucket, max 5 MB, JPG/PNG/WebP/GIF
- Submission progress: `submission-progress` bucket, max 15 MB, PDF/Office/CSV/ZIP/images
- Post-problem form inserts via admin client with a fallback for missing `thumbnail_url` column
