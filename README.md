# SproutNet

SproutNet is a platform where real Indian problems meet structured student solutions. Anyone can post civic or industry challenges, and students submit thoughtful, milestone-based responses evaluated through blind judging.

**Tagline:** *"Structured Thinking for Real India"*

## Stack

Plain **Node.js + Express** REST API with a vanilla HTML/CSS/JS frontend. No framework, no build step, no React.

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 20+ |
| Server | Express 4 |
| Frontend | Vanilla HTML/CSS/JS (static files in `client/`) |
| Backend / DB | Supabase (PostgreSQL, Auth, Storage) |
| Uploads | multer (memory) → Supabase Storage |
| Email | Nodemailer (SMTP) |

## Quick start

```bash
npm install
npm run serve      # http://localhost:3001 (PORT env overrides)
npm run serve:dev  # with --watch reload
```

Required env vars (see `.env`): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Optional: `PORT`, SMTP settings for OTP email, `GROQ_API_KEY` for AI problem evaluation.

## Project structure

```
server/
  server.js              entry: page routes, static files, API mounts
  supabase.js            getAdmin() (service role) + getUserClient(token)
  middleware/auth.js     authRequired / optionalAuth / loadProfile / requireRole (Bearer JWT)
  middleware/upload.js   multer memory storage
  lib/                   ported utilities (same export names as the original TS lib)
  routes/                13 routers with full /api/... paths (problems, enrollments,
                         submissions, teams, workspaces, mentors, blogs, auth, admin,
                         misc, public-reads, student-reads, staff-reads)
client/
  *.html                 43 pages, clean URLs (e.g. /problems/:id -> problem-detail.html)
  assets/app.js          Supabase browser client, api() helper, auth guards, nav
  assets/styles.css      shared theme
supabase/migrations/     raw SQL — apply manually in the Supabase SQL editor
scripts/                 tsx utilities (seed mentors/test data, run migrations, buckets)
```

## Auth model

The browser holds the Supabase session (localStorage) and sends it as an `Authorization: Bearer` header via the `api()` helper. The server verifies the JWT with the anon client and uses the service-role client for privileged queries. All role enforcement lives in the API; page guards (`requireAuth`/`requireRole`) are a UX layer on top.

## Roles & rules

- **Student** — browse, enroll (max 2 active), teams, milestone submissions
- **Poster** — post/manage problems, review solutions
- **Mentor** — guide teams, connect requests
- **Admin** — cross-user access, judging, analytics
- Registration gated to `@jyothyit.ac.in` during Phase 1
