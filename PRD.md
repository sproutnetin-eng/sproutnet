# SproutNet — Product Requirements Document

## 1. Product Overview

**SproutNet** is a structured innovation platform designed for Indian college students to identify, collaborate on, and solve real-world problems. It connects **students**, **problem posters**, and **mentors** in a unified workspace-driven ecosystem.

**Tagline:** *"Structured Thinking for Real India"*

---

## 2. User Roles

| Role | Description |
|------|-------------|
| **Student** | Browses problems, enrolls (max 2 active), forms teams, submits milestone-based progress, collaborates in workspaces |
| **Poster** | Posts real-world problems, manages submissions, removes students, participates in team workspaces |
| **Mentor** | Guides teams via mentorship requests, has profile with skills/availability/bio, assigned to workspaces |
| **Admin** | Cross-user access via service-role client, manages all resources, `is_master` flag for elevated privileges |

---

## 3. Authentication & Authorization

- Role-based login pages: `/login/student`, `/login/poster`, `/login/mentor`
- Registration gated by `allowed_domains` table (only `@jyothyit.ac.in` configured for Phase 1)
- Sign-up flow: `supabase.auth.signUp()` → profile created in `users` table
- Express auth middleware (`server/middleware/auth.js`) verifies the Bearer JWT on API routes and enforces role-based access; pages guard client-side via `requireAuth`/`requireRole`

---

## 4. Core Features

### 4.1 Problems
- **Browse:** Anyone can view problems at `/problems` and `/problems/[id]`
- **Post:** Posters and admins can create problems with title, domain, type, milestones, deadlines, reward amount, thumbnail, context, problem statement, scope, constraints, deliverables
- **Manage:** Update, delete, toggle status (open/pending), reject with reason
- **Discussion:** Threaded Q&A per problem via `/api/discussion` with likes

### 4.2 Enrollments
- Students enroll in problems (max **2 active enrollments** at a time)
- Enrollment lifecycle: `active` → `completed` (auto when all milestones submitted) or `cancelled` (by student, only if no submissions started) or `removed` (by poster/admin)
- Re-activation of previously cancelled enrollments supported

### 4.3 Submissions
- Students upload milestone progress files to `submission-progress` bucket (max 15 MB, PDF/Office/CSV/ZIP/images)
- Uploads tracked in `submissions` table per milestone

### 4.4 Teams
- Create team with invite code (`SPROUT-XXXXXX`), auto-creates workspace + "general" channel
- Join by invite code, auto-added to workspace channel
- Leader can transfer leadership; members can leave (leader cannot)
- Min/max team size configurable per problem; team mode optional

### 4.5 Workspaces (Collaboration Hub)
Each team gets a workspace with:

#### 4.5.1 Channels
- Create/delete text-based channels (cannot delete "general")
- Public or private channels within workspace

#### 4.5.2 Milestones
- Create/edit/delete milestones with title, description, due date, status
- Mark complete (tracks who completed and when)
- **Auto-calculates workspace progress** (completed/total ratio)

#### 4.5.3 Files
- Upload files with category tagging, paginated listing, filterable by category
- Track uploader, size, mime type

#### 4.5.4 Announcements
- Types: general, poster, system, deadline
- Pin announcements, set expiry
- Poster and team members can post announcements

#### 4.5.5 Activity Log
- Records all workspace events: team creation, member joins/removals, role changes, channel ops, milestones, mentor actions, leader transfers
- Paginated and filterable

#### 4.5.6 Invites
- Email-based workspace invites with role assignment and expiry
- Accept via invite code or workspace ID

#### 4.5.7 Role Permissions
- Roles: leader, co_leader, member, mentor, poster, admin
- Granular permissions stored in `workspace_role_permissions` table
- Wildcard (`*`) support for admin-level access

### 4.6 Messaging / Chat
- Conversations (channels and DMs) tied to workspaces
- Messages with emoji reactions (`/api/messages/react`)

### 4.7 Mentor System
- **Mentor Profiles:** Bio, skills, technologies, availability, max active teams, links (LinkedIn, GitHub, portfolio)
- **Team Requests:** Teams send mentorship requests to mentors with message; mentors accept/reject (capacity-checked)
- **Direct Connect:** Students send direct mentorship connection requests; mentors accept/decline
- **Assignments:** Mentors assigned to workspaces with active/ended status tracking
- **Capacity enforcement:** Mentors have `max_active_teams` limit checked before assignment or acceptance

### 4.8 Blogs (Community)
- Plain HTML blog editor (`/blogs/new`) with textarea + fields
- CRUD via `/api/blogs/posts` with fields: title, body, cover image, slug, excerpt, tags, category, SEO fields, draft/published status
- Post types: `knowledge`, `question`
- **Threaded comments** via `/api/blogs/comments` with parent_comment_id
- **Likes** via `/api/blogs/likes` (toggle)
- **Image uploads** to `blog-images` bucket (max 10 MB)
- **Local JSON fallback:** When Supabase blog tables don't exist, falls back to `.data/blogs.json` (controlled by `BLOGS_ALLOW_LOCAL_FALLBACK` env var, defaults to `true`)

### 4.9 Notifications
- In-app notifications for events: mentor accepted/rejected, connect requests, team member joined, mentor assigned
- Tracked in `notifications` table with event type, title, body, link URL, read status, metadata

### 4.10 Leaderboard
- `/leaderboard` page — public ranking display

### 4.11 User Profiles
- `/profile/[slug]` — public user profile with name, role, department, year

### 4.12 Analytics (Admin)
- `/admin/analytics` — platform-wide analytics dashboard

---

## 5. Public Pages

| Route | Description |
|-------|-------------|
| `/` | Landing/splash page |
| `/login`, `/login/student`, `/login/poster`, `/login/mentor` | Authentication |
| `/join` | Registration |
| `/problems`, `/problems/[id]` | Problem browsing and detail |
| `/blogs`, `/blogs/[slug]` | Blog feed and individual posts |
| `/leaderboard` | Public leaderboard |
| `/impact` | Impact showcase |
| `/how-it-works` | Platform explanation |
| `/about` | About SproutNet |
| `/mentors` | Browse mentors directory |

---

## 6. Protected Dashboard Routes

| Route | Role(s) | Description |
|-------|---------|-------------|
| `/dashboard` | Student | Enrollments, active problems, submissions |
| `/poster/dashboard` | Poster | Own problems, enrollments, student submissions |
| `/poster/post-problem` | Poster, Admin | Create new problem |
| `/poster/problems` | Poster, Admin | Manage own problems |
| `/poster/solutions` | Poster, Admin | View student solutions |
| `/mentor/dashboard` | Mentor, Admin | Mentor overview |
| `/admin/judging` | Admin | Judging interface |
| `/admin/analytics` | Admin | Analytics dashboard |
| `/admin/problems` | Admin | Manage all problems |
| `/teams/[id]` | Team member | Workspace hub |
| `/blogs/editor`, `/blogs/manage`, `/blogs/new` | Authenticated | Blog management |
| `/profile/[slug]` | Authenticated | Profile settings |
| `/problems/[id]/submit` | Student | Submit progress |

---

## 7. API Endpoints

### 7.1 Auth
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth/signout` | POST | Sign out |

### 7.2 Problems
| Endpoint | Methods | Allowed |
|----------|---------|---------|
| `/api/problems/create` | POST | poster, admin |
| `/api/problems/update` | POST | poster, admin |
| `/api/problems/delete` | POST | poster, admin |
| `/api/problems/status` | POST | poster, admin |
| `/api/problems/thumbnail` | POST | poster, admin |

### 7.3 Enrollments
| Endpoint | Methods | Allowed |
|----------|---------|---------|
| `/api/enrollments/create` | POST | student |
| `/api/enrollments/cancel` | POST | student |
| `/api/enrollments/status` | POST | student |
| `/api/enrollments/remove` | POST | poster, admin |

### 7.4 Submissions
| Endpoint | Methods | Allowed |
|----------|---------|---------|
| `/api/submissions/progress-upload` | POST | student |

### 7.5 Teams
| Endpoint | Methods | Allowed |
|----------|---------|---------|
| `/api/teams/create` | POST | student |
| `/api/teams/join` | POST | student |
| `/api/teams/request-mentor` | POST | team member |

### 7.6 Mentors
| Endpoint | Methods | Allowed |
|----------|---------|---------|
| `/api/mentors/profile` | POST | mentor, admin |
| `/api/mentors/connect` | POST | student |
| `/api/mentors/respond-connect` | POST | mentor |
| `/api/mentors/request` | POST | mentor |

### 7.7 Workspaces
| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/workspaces` | GET | List workspaces |
| `/api/workspaces/[id]` | GET, PATCH | Get/update workspace |
| `/api/workspaces/[id]/members` | GET | List members |
| `/api/workspaces/[id]/members/[userId]` | PATCH, DELETE | Change role, remove member |
| `/api/workspaces/[id]/channels` | GET, POST | List/create channels |
| `/api/workspaces/[id]/channels/[channelId]` | DELETE | Delete channel |
| `/api/workspaces/[id]/milestones` | GET, POST | List/create milestones |
| `/api/workspaces/[id]/milestones/[milestoneId]` | PATCH, DELETE | Update/delete milestone |
| `/api/workspaces/[id]/progress` | GET | Get progress |
| `/api/workspaces/[id]/files` | GET | List files |
| `/api/workspaces/[id]/announcements` | GET, POST | List/create announcements |
| `/api/workspaces/[id]/announcements/[announcementId]` | DELETE | Delete announcement |
| `/api/workspaces/[id]/mentors` | POST | Assign mentor |
| `/api/workspaces/[id]/mentors/[mentorId]` | DELETE | Remove mentor |
| `/api/workspaces/[id]/activity` | GET | Get activity log |
| `/api/workspaces/[id]/invites` | POST | Create invite |
| `/api/workspaces/[id]/leave` | POST | Leave workspace |
| `/api/workspaces/[id]/transfer` | POST | Transfer leadership |
| `/api/workspaces/invites/accept` | POST | Accept invite |

### 7.8 Blogs
| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/blogs/posts` | GET, POST, PATCH, DELETE | Blog CRUD |
| `/api/blogs/comments` | POST, DELETE | Threaded comments |
| `/api/blogs/likes` | POST | Toggle like |
| `/api/blogs/images` | POST | Upload image |

### 7.9 Discussion (Problem Q&A)
| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/discussion` | GET, POST | Threaded discussion |
| `/api/discussion/like` | POST | Toggle like |

### 7.10 Messages
| Endpoint | Methods | Purpose |
|----------|---------|---------|
| `/api/messages/react` | POST | Toggle emoji reaction |

---

## 8. Database Tables

### 8.1 Core
- `users` — profiles, roles, auth linkage
- `allowed_domains` — registration domain gating
- `problems` — problem definitions with milestones, deadlines, team config
- `enrollments` — student-problem enrollment records
- `submissions` — milestone progress submissions

### 8.2 Teams & Workspaces
- `teams` — team definitions with invite codes
- `team_members` — membership with workspace ref and role
- `workspaces` — collaboration hubs per team
- `workspace_milestones` — project milestones with status
- `workspace_progress` — computed progress percentage
- `workspace_files` — uploaded file metadata
- `workspace_announcements` — announcements with type, pin, expiry
- `workspace_invites` — email-based invites
- `workspace_roles` — role definitions
- `workspace_role_permissions` — granular permission strings

### 8.3 Mentors
- `mentor_profiles` — bio, skills, availability, capacity, links
- `mentor_requests` — team-to-mentor request workflow
- `mentor_assignments` — active mentor-team assignments

### 8.4 Messaging
- `conversations` — channels and DMs
- `conversation_members` — conversation membership
- `messages` — chat messages
- `message_reactions` — emoji reactions

### 8.5 Blogs
- `blog_posts` — rich content with SEO fields
- `blog_comments` — threaded comments
- `blog_post_likes` — like tracking

### 8.6 Discussion
- `discussion` — per-problem threaded comments
- `discussion_likes` — like tracking

### 8.7 Notifications & Activity
- `notifications` — in-app notifications with event types
- `activity_logs` — workspace audit trail
- `audit_logs` — general audit trail

---

## 9. Storage Buckets

| Bucket | Max Size | Allowed Types |
|--------|----------|---------------|
| `problem-thumbnails` | 5 MB | JPG, PNG, WebP, GIF |
| `submission-progress` | 15 MB | PDF, Office, CSV, ZIP, images |
| `blog-images` | 10 MB | PNG, JPG, WebP, GIF |

---

## 10. Business Rules

- **Max 2 active enrollments** per student. Re-activation of cancelled enrollments allowed.
- **Enrollment auto-completion** when all milestones submitted (`syncCompletedEnrollments`).
- **Mentor capacity limit** enforced via `max_active_teams` before assignment/acceptance.
- **Workspace progress auto-calculated** from milestone completion ratio.
- **Team invite codes** format: `SPROUT-XXXXXX`.
- **Workspace leader cannot leave**; must transfer leadership first.
- **Blog local fallback** enabled by default; blogs served from `.data/blogs.json` when Supabase tables missing.
- **Thumbnail fallback:** base64 encoding in `rejected_reason` column if `thumbnail_url` column missing.
- **Registration** gated to `@jyothyit.ac.in` email domain during Phase 1.

---

## 11. Technology Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 20+ |
| Server | Express 4 (REST API) |
| Frontend | Vanilla HTML/CSS/JS (static, no build step) |
| Backend / DB | Supabase (PostgreSQL, Auth, Storage) |
| Uploads | multer (memory) → Supabase Storage |
| Email | Nodemailer (SMTP) |
| Testing | None configured |

---

## 12. Infrastructure

- **Auth:** Bearer-JWT middleware (`server/middleware/auth.js`: `authRequired`, `loadProfile`, `requireRole`)
- **Supabase Clients:** browser client (vanilla JS via CDN) + user-scoped server client (carries caller JWT) + admin client (service role key) in `server/supabase.js`
- **Migrations:** 11 SQL files in `supabase/migrations/`, must be applied manually in Supabase SQL editor
- **Env Vars:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_APP_URL`, `BLOGS_ALLOW_LOCAL_FALLBACK`
