// Public read endpoints for the vanilla frontend.
// Uses the service-role admin client (replaces admin-client page queries).
// Mounted by server/server.js via app.use(require('./routes/public-reads')).
const express = require('express');
const { getAdmin, getUserFromToken } = require('../supabase');
const { authRequired, loadProfile } = require('../middleware/auth');

const router = express.Router();

const THUMB_FALLBACK_PREFIX = 'thumbnail::';

function decodeThumbnailFallback(value) {
  if (typeof value !== 'string') return null;
  if (!value.startsWith(THUMB_FALLBACK_PREFIX)) return null;
  const url = value.slice(THUMB_FALLBACK_PREFIX.length).trim();
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

function isMissingThumbnailColumnError(message) {
  if (!message) return false;
  const m = String(message).toLowerCase();
  return (
    m.includes('thumbnail_url') &&
    (m.includes('schema cache') || m.includes('does not exist') || m.includes('unknown column'))
  );
}

function normalizeUsersJoin(row) {
  if (!row) return row;
  if (Array.isArray(row.users)) row.users = row.users[0] || null;
  return row;
}

async function authUser(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const { user } = await getUserFromToken(m[1]);
    return user;
  } catch {
    return null;
  }
}

// GET /api/public/stats -> { openProblems }
// Counts only enrollable problems: status=open AND deadline not passed.
// (Expired problems are hidden from student listings but stay visible to posters.)
router.get('/api/public/stats', async (req, res, next) => {
  try {
    const admin = getAdmin();
    const nowIso = new Date().toISOString();
    const { count, error } = await admin
      .from('problems')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'open')
      .or(`deadline.is.null,deadline.gt.${nowIso}`);
    if (error) throw new Error(error.message);
    res.json({ openProblems: count ?? 0 });
  } catch (e) {
    next(e);
  }
});

function applyProblemFilters(query, domain, type) {
  if (domain && domain !== 'All') query = query.eq('domain', domain);
  if (type && type !== 'all') query = query.eq('problem_type', type);
  return query;
}

// GET /api/public/problems?domain=All&type=all -> { problems }
// Student-facing listing: only enrollable problems (status=open AND
// deadline not passed). Expired problems stay visible to posters via
// /api/poster/problems and to enrolled students via /api/student/overview.
function isEnrollable(p, nowMs) {
  if (!p || !p.deadline) return true;
  const t = new Date(p.deadline).getTime();
  if (Number.isNaN(t)) return true;
  return t >= nowMs;
}
router.get('/api/public/problems', async (req, res, next) => {
  try {
    const admin = getAdmin();
    const domain = req.query.domain || 'All';
    const type = req.query.type || 'all';
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const FULL =
      'id, title, domain, problem_type, status, thumbnail_url, reward_amount, milestones, deadline, submission_count, context, difficulty_label, difficulty_score, impact_score, estimated_hours';
    const FALLBACK =
      'id, title, domain, problem_type, status, reward_amount, milestones, deadline, submission_count, context, rejected_reason, difficulty_label, difficulty_score, impact_score, estimated_hours';

    let q = admin.from('problems').select(FULL).order('created_at', { ascending: false }).eq('status', 'open').or(`deadline.is.null,deadline.gt.${nowIso}`);
    let { data, error } = await applyProblemFilters(q, domain, type);

    if (error && isMissingThumbnailColumnError(error.message)) {
      let q2 = admin.from('problems').select(FALLBACK).order('created_at', { ascending: false }).eq('status', 'open').or(`deadline.is.null,deadline.gt.${nowIso}`);
      const fb = await applyProblemFilters(q2, domain, type);
      error = fb.error;
      data = (fb.data || []).map((p) => ({
        ...p,
        thumbnail_url: decodeThumbnailFallback(p.rejected_reason),
      }));
    }
    if (error) throw new Error(error.message);
    // Safety net for clock skew / cached rows: drop anything already past deadline.
    const problems = (data || []).filter((p) => isEnrollable(p, nowMs));
    res.json({ problems });
  } catch (e) {
    next(e);
  }
});

// GET /api/public/problems/:id -> { problem }
router.get('/api/public/problems/:id', async (req, res, next) => {
  try {
    const admin = getAdmin();
    const { data, error } = await admin.from('problems').select('*').eq('id', req.params.id).single();
    if (error) {
      if (error.code === 'PGRST116' || /no rows|not found/i.test(error.message || '')) {
        return res.status(404).json({ error: 'Problem not found' });
      }
      throw new Error(error.message);
    }
    if (!data) return res.status(404).json({ error: 'Problem not found' });
    if (data.thumbnail_url == null) {
      data.thumbnail_url = decodeThumbnailFallback(data.rejected_reason);
    }
    res.json({ problem: data });
  } catch (e) {
    next(e);
  }
});

// GET /api/public/leaderboard -> { leaders }
router.get('/api/public/leaderboard', async (req, res, next) => {
  try {
    const admin = getAdmin();
    const { data, error } = await admin
      .from('leaderboard')
      .select('*')
      .order('builder_score', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    res.json({ leaders: data || [] });
  } catch (e) {
    next(e);
  }
});

// GET /api/public/mentors -> { mentors }
router.get('/api/public/mentors', async (req, res, next) => {
  try {
    const admin = getAdmin();
    const { data, error } = await admin
      .from('mentor_profiles')
      .select('user_id, bio, skills, technologies, experience_years, linkedin_url, github_url, availability_status, max_active_teams, users(id, name, email)')
      .order('experience_years', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ mentors: (data || []).map(normalizeUsersJoin) });
  } catch (e) {
    next(e);
  }
});

// GET /api/public/mentor-context -> { currentUser, userTeams, pendingMentorIds, connectedMentorIds }
// Authenticated (Bearer JWT via api() helper); returns empty context when anonymous.
router.get('/api/public/mentor-context', async (req, res, next) => {
  try {
    const user = await authUser(req);
    if (!user) {
      return res.json({ currentUser: null, userTeams: [], pendingMentorIds: [], connectedMentorIds: [] });
    }
    const admin = getAdmin();
    const { data: profile } = await admin
      .from('users')
      .select('id, name, role, profile_slug')
      .eq('id', user.id)
      .single();
    const currentUser = profile || null;
    let userTeams = [];
    if (currentUser && currentUser.role === 'student') {
      const { data: tmRows } = await admin
        .from('team_members')
        .select('team_id, teams(id, name)')
        .eq('user_id', currentUser.id);
      userTeams = (tmRows || [])
        .map((r) => (Array.isArray(r.teams) ? r.teams[0] : r.teams))
        .filter(Boolean)
        .map((t) => ({ id: t.id, name: t.name }));
    }
    let pendingMentorIds = [];
    let connectedMentorIds = [];
    if (currentUser && currentUser.role === 'student') {
      const { data: notifs } = await admin
        .from('notifications')
        .select('user_id, metadata')
        .eq('event_type', 'MENTOR_CONNECT_REQUEST')
        .filter('metadata->>student_id', 'eq', currentUser.id);
      if (notifs) {
        connectedMentorIds = notifs.filter((n) => n.metadata && n.metadata.response === 'accepted').map((n) => n.user_id).filter(Boolean);
        pendingMentorIds = notifs.filter((n) => !(n.metadata && n.metadata.response)).map((n) => n.user_id).filter(Boolean);
      }
      if (connectedMentorIds.length === 0) {
        const { data: accepted } = await admin
          .from('notifications')
          .select('metadata')
          .eq('event_type', 'MENTOR_ACCEPTED')
          .eq('user_id', currentUser.id);
        if (accepted) {
          for (const n of accepted) {
            const mid = n.metadata && n.metadata.mentor_id;
            if (mid) connectedMentorIds.push(mid);
          }
        }
      }
    }
    res.json({ currentUser, userTeams, pendingMentorIds, connectedMentorIds });
  } catch (e) {
    next(e);
  }
});

function parseDeliverables(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (d) => d && (d.kind === 'link' || d.kind === 'file') && typeof d.label === 'string' && typeof d.url === 'string'
  );
}

// GET /api/public/solutions -> { solutions }
// GET /api/public/solutions?id=<submissionId> -> { solution } (full detail
// with the 7 framework fields, for the solution detail page)
router.get('/api/public/solutions', async (req, res, next) => {
  try {
    const admin = getAdmin();
    const detailId = typeof req.query.id === 'string' ? req.query.id.trim() : '';
    const baseSelect = detailId
      ? 'id, problem_id, student_id, participant_type, score, judge_feedback, final_deliverables, submitted_at, f_understanding, f_rootcause, f_solution, f_impact, f_feasibility, f_risks, f_implementation'
      : 'id, problem_id, student_id, participant_type, score, judge_feedback, final_deliverables, submitted_at';
    let q = admin
      .from('submissions')
      .select(baseSelect)
      .eq('stage', 'full')
      .eq('status', 'approved');
    if (detailId) q = q.eq('id', detailId).limit(1);
    else q = q.order('submitted_at', { ascending: false }).limit(100);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const completed = (rows || []).filter((r) => parseDeliverables(r.final_deliverables).length > 0);

    if (detailId && !completed.length) {
      return res.status(404).json({ error: 'Solution not found.' });
    }

    const enriched = await enrichSolutions(admin, completed);
    if (detailId) {
      const s = enriched[0];
      return res.json({
        solution: {
          ...s,
          fields: {
            understanding: rows[0].f_understanding || '',
            rootcause: rows[0].f_rootcause || '',
            solution: rows[0].f_solution || '',
            impact: rows[0].f_impact || '',
            feasibility: rows[0].f_feasibility || '',
            risks: rows[0].f_risks || '',
            implementation: implText(rows[0].f_implementation),
            files: implFiles(rows[0].f_implementation),
          },
        },
      });
    }
    res.json({ solutions: enriched });
  } catch (e) {
    next(e);
  }
});

// f_implementation may be plain text or JSON { text, files[] } (see submit.html).
function implText(value) {
  if (!value) return '';
  const t = String(value).trim();
  if (!t.startsWith('{')) return value;
  try {
    const j = JSON.parse(t);
    return typeof j.text === 'string' ? j.text : '';
  } catch {
    return value;
  }
}

function implFiles(value) {
  if (!value) return [];
  const t = String(value).trim();
  if (!t.startsWith('{')) return [];
  try {
    const j = JSON.parse(t);
    return Array.isArray(j.files) ? j.files.filter((f) => f && typeof f.name === 'string') : [];
  } catch {
    return [];
  }
}

async function enrichSolutions(admin, completed) {
  const problemIds = Array.from(new Set(completed.map((r) => r.problem_id)));
  const studentIds = Array.from(new Set(completed.map((r) => r.student_id)));

  const [probRes, userRes, teamRes] = await Promise.all([
    problemIds.length
      ? admin.from('problems').select('id, title, domain').in('id', problemIds)
      : Promise.resolve({ data: [] }),
    studentIds.length
      ? admin.from('users').select('id, name, profile_slug').in('id', studentIds)
      : Promise.resolve({ data: [] }),
    studentIds.length
      ? admin.from('team_members').select('user_id, teams!inner(problem_id)').in('user_id', studentIds)
      : Promise.resolve({ data: [] }),
  ]);
  if (probRes.error) throw new Error(probRes.error.message);
  if (userRes.error) throw new Error(userRes.error.message);

  const problemMap = new Map((probRes.data || []).map((p) => [p.id, p]));
  const userMap = new Map((userRes.data || []).map((u) => [u.id, u]));
  const teamKeys = new Set();
  for (const row of teamRes.data || []) {
    const t = Array.isArray(row.teams) ? row.teams[0] : row.teams;
    if (t && t.problem_id) teamKeys.add(`${row.user_id}:${t.problem_id}`);
  }

  return completed.map((r) => {
    const p = problemMap.get(r.problem_id);
    const u = userMap.get(r.student_id);
    const participantType =
      teamKeys.has(`${r.student_id}:${r.problem_id}`) || r.participant_type === 'team' ? 'team' : 'individual';
    return {
      id: r.id,
      problemId: r.problem_id,
      problemTitle: (p && p.title) || 'Unknown problem',
      problemDomain: (p && p.domain) || null,
      authorId: r.student_id,
      authorName: (u && u.name) || 'SproutNet builder',
      authorSlug: (u && u.profile_slug) || null,
      participantType,
      score: r.score ?? null,
      feedback: r.judge_feedback ?? null,
      deliverables: parseDeliverables(r.final_deliverables),
      completedAt: r.submitted_at,
    };
  });
}

// --- Solution comments (mirrors blog comments) -------------------------------
const SOLUTION_COMMENTS_SETUP_SQL_PATH = 'supabase/migrations/20260826_solution_comments.sql';
const SOLUTION_COMMENTS_SETUP_REQUIRED_MESSAGE =
  `Solution comments are not set up yet. Run the SQL in ${SOLUTION_COMMENTS_SETUP_SQL_PATH} and refresh this page.`;

function isMissingSolutionCommentsTableError(message) {
  if (!message) return false;
  const normalized = String(message).toLowerCase();
  return (
    normalized.includes('solution_comments') &&
    (normalized.includes('schema cache') ||
      normalized.includes('does not exist') ||
      normalized.includes('unknown table') ||
      normalized.includes('relation'))
  );
}

// GET /api/solutions/comments?solution_id=<id> -> { comments } (public)
router.get('/api/solutions/comments', async (req, res, next) => {
  try {
    const solutionId = typeof req.query.solution_id === 'string' ? req.query.solution_id.trim() : '';
    if (!solutionId) return res.status(400).json({ error: 'solution_id is required.' });
    const admin = getAdmin();
    const { data: rows, error } = await admin
      .from('solution_comments')
      .select('id, solution_id, body, created_at, author_id, parent_comment_id')
      .eq('solution_id', solutionId)
      .order('created_at', { ascending: true });
    if (error) {
      if (isMissingSolutionCommentsTableError(error.message)) {
        return res.status(503).json({ error: SOLUTION_COMMENTS_SETUP_REQUIRED_MESSAGE });
      }
      throw new Error(error.message);
    }
    const authorIds = Array.from(new Set((rows || []).map((c) => c.author_id)));
    const { data: users } = authorIds.length
      ? await admin.from('users').select('id, name').in('id', authorIds)
      : { data: [] };
    const userById = new Map((users || []).map((u) => [u.id, u]));
    res.json({
      comments: (rows || []).map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.created_at,
        author: userById.get(c.author_id) ? { id: c.author_id, name: userById.get(c.author_id).name } : null,
        parentId: c.parent_comment_id || null,
      })),
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/solutions/comments — add a comment (auth required)
router.post('/api/solutions/comments', authRequired, async (req, res, next) => {
  try {
    const user = req.user;
    const payload = req.body || {};
    const solutionId = typeof payload.solution_id === 'string' ? payload.solution_id.trim() : '';
    const body = typeof payload.body === 'string' ? payload.body.trim() : '';
    const parentCommentId = typeof payload.parent_comment_id === 'string' && payload.parent_comment_id.trim()
      ? payload.parent_comment_id.trim()
      : null;
    if (!solutionId) return res.status(400).json({ error: 'solution_id is required.' });
    if (!body) return res.status(400).json({ error: 'Comment body is required.' });
    if (body.length > 2000) return res.status(400).json({ error: 'Comment is too long (max 2000 characters).' });

    const admin = getAdmin();
    // Only comment on publicly visible (approved, full-stage) solutions.
    const { data: sub, error: subError } = await admin
      .from('submissions')
      .select('id')
      .eq('id', solutionId)
      .eq('stage', 'full')
      .eq('status', 'approved')
      .maybeSingle();
    if (subError) throw new Error(subError.message);
    if (!sub) return res.status(404).json({ error: 'Solution not found.' });

    if (parentCommentId) {
      const { data: parent, error: parentError } = await admin
        .from('solution_comments')
        .select('id')
        .eq('id', parentCommentId)
        .eq('solution_id', solutionId)
        .maybeSingle();
      if (parentError) {
        if (isMissingSolutionCommentsTableError(parentError.message)) {
          return res.status(503).json({ error: SOLUTION_COMMENTS_SETUP_REQUIRED_MESSAGE });
        }
        throw new Error(parentError.message);
      }
      if (!parent) return res.status(404).json({ error: 'Parent comment not found.' });
    }

    const { data: inserted, error } = await admin
      .from('solution_comments')
      .insert({ solution_id: solutionId, author_id: user.id, body, parent_comment_id: parentCommentId })
      .select('id, solution_id, body, created_at, author_id, parent_comment_id')
      .single();
    if (error) {
      if (isMissingSolutionCommentsTableError(error.message)) {
        return res.status(503).json({ error: SOLUTION_COMMENTS_SETUP_REQUIRED_MESSAGE });
      }
      throw new Error(error.message);
    }
    const { data: author } = await admin.from('users').select('id, name').eq('id', user.id).single();
    res.json({
      comment: {
        id: inserted.id,
        body: inserted.body,
        createdAt: inserted.created_at,
        author: author ? { id: author.id, name: author.name } : null,
        parentId: inserted.parent_comment_id || null,
      },
    });
  } catch (e) {
    next(e);
  }
});

// DELETE /api/solutions/comments — delete own comment (admins can delete any)
router.delete('/api/solutions/comments', authRequired, loadProfile, async (req, res, next) => {
  try {
    const user = req.user;
    const payload = req.body || {};
    const commentId = typeof payload.comment_id === 'string' ? payload.comment_id.trim() : '';
    if (!commentId) return res.status(400).json({ error: 'comment_id is required.' });

    const admin = getAdmin();
    const { data: rows, error } = await admin
      .from('solution_comments')
      .select('id, author_id')
      .eq('id', commentId);
    if (error) {
      if (isMissingSolutionCommentsTableError(error.message)) {
        return res.status(503).json({ error: SOLUTION_COMMENTS_SETUP_REQUIRED_MESSAGE });
      }
      throw new Error(error.message);
    }
    if (!rows || !rows.length) return res.status(404).json({ error: 'Comment not found.' });
    const isModerator = req.profile?.role === 'admin' || req.profile?.is_master;
    if (rows[0].author_id !== user.id && !isModerator) {
      return res.status(403).json({ error: 'You can only delete your own comments.' });
    }
    // Delete the comment plus its direct replies.
    const { error: delError } = await admin
      .from('solution_comments')
      .delete()
      .or(`id.eq.${commentId},parent_comment_id.eq.${commentId}`);
    if (delError) throw new Error(delError.message);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// GET /api/public/profile/:slug -> { profile, isOwnProfile, neighbors, myRank, submissions, enrollments }
router.get('/api/public/profile/:slug', async (req, res, next) => {
  try {
    const admin = getAdmin();
    const slug = req.params.slug;
    const COLS =
      'id, name, dept, year, role, profile_slug, builder_score, attempted, avg_score, milestones_done, bio, github, linkedin, twitter, avatar_url';

    let profile = null;
    const bySlug = await admin.from('users').select(COLS).eq('profile_slug', slug).maybeSingle();
    if (bySlug.error) throw new Error(bySlug.error.message);
    profile = bySlug.data;
    if (!profile) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug);
      if (isUuid) {
        const byId = await admin.from('users').select(COLS).eq('id', slug).maybeSingle();
        if (byId.error) throw new Error(byId.error.message);
        profile = byId.data;
      }
    }
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const user = await authUser(req);
    const isOwnProfile = !!user && user.id === profile.id;

    const { data: leaderboardRows, error: lbError } = await admin
      .from('leaderboard')
      .select('rank, builder_score, name, profile_slug')
      .order('builder_score', { ascending: false });
    if (lbError) throw new Error(lbError.message);
    const allEntries = leaderboardRows || [];
    const myIdx = allEntries.findIndex((e) => e.profile_slug === (profile.profile_slug || slug));
    const myEntry = myIdx >= 0 ? allEntries[myIdx] : null;
    let neighbors = [];
    if (myEntry) {
      neighbors = allEntries.slice(Math.max(0, myIdx - 2), Math.min(allEntries.length, myIdx + 3));
    }

    const { data: submissionRows, error: subError } = await admin
      .from('submissions')
      .select('id, score, status, submitted_at, problems(title)')
      .eq('student_id', profile.id)
      .eq('status', 'approved')
      .order('submitted_at', { ascending: false })
      .limit(10);
    if (subError) throw new Error(subError.message);
    const submissions = (submissionRows || []).map((s) => {
      const p = Array.isArray(s.problems) ? s.problems[0] : s.problems;
      return {
        id: s.id,
        problem_title: (p && p.title) || null,
        score: s.score,
        status: s.status,
        created_at: s.submitted_at || null,
      };
    });

    const { data: enrollRows, error: enrError } = await admin
      .from('enrollments')
      .select('problem_id, problems(title, milestones)')
      .eq('student_id', profile.id)
      .neq('status', 'completed')
      .limit(10);
    if (enrError) throw new Error(enrError.message);
    const enrollments = (enrollRows || []).map((e) => {
      const p = Array.isArray(e.problems) ? e.problems[0] : e.problems;
      const totalMilestones = Array.isArray(p?.milestones)
        ? p.milestones.length
        : typeof p?.milestones === 'number'
        ? p.milestones
        : 1;
      return {
        problem_id: e.problem_id,
        problem_title: (p && p.title) || null,
        milestone: 1,
        total_milestones: totalMilestones || 1,
      };
    });

    res.json({
      profile,
      isOwnProfile,
      neighbors,
      myRank: myEntry ? myEntry.rank : null,
      submissions,
      enrollments,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
