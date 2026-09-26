// Public read endpoints for the vanilla frontend.
// Uses the service-role admin client (replaces admin-client page queries).
// Mounted by server/server.js via app.use(require('./routes/public-reads')).
const express = require('express');
const { getAdmin, getUserFromToken } = require('../supabase');

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
router.get('/api/public/stats', async (req, res, next) => {
  try {
    const admin = getAdmin();
    const { count, error } = await admin
      .from('problems')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'open');
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
router.get('/api/public/problems', async (req, res, next) => {
  try {
    const admin = getAdmin();
    const domain = req.query.domain || 'All';
    const type = req.query.type || 'all';
    const FULL =
      'id, title, domain, problem_type, status, thumbnail_url, reward_amount, milestones, deadline, submission_count, context, difficulty_label, difficulty_score, impact_score, estimated_hours';
    const FALLBACK =
      'id, title, domain, problem_type, status, reward_amount, milestones, deadline, submission_count, context, rejected_reason, difficulty_label, difficulty_score, impact_score, estimated_hours';

    let q = admin.from('problems').select(FULL).order('created_at', { ascending: false }).eq('status', 'open');
    let { data, error } = await applyProblemFilters(q, domain, type);

    if (error && isMissingThumbnailColumnError(error.message)) {
      let q2 = admin.from('problems').select(FALLBACK).order('created_at', { ascending: false }).eq('status', 'open');
      const fb = await applyProblemFilters(q2, domain, type);
      error = fb.error;
      data = (fb.data || []).map((p) => ({
        ...p,
        thumbnail_url: decodeThumbnailFallback(p.rejected_reason),
      }));
    }
    if (error) throw new Error(error.message);
    res.json({ problems: data || [] });
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
router.get('/api/public/solutions', async (req, res, next) => {
  try {
    const admin = getAdmin();
    const { data: rows, error } = await admin
      .from('submissions')
      .select('id, problem_id, student_id, participant_type, score, judge_feedback, final_deliverables, submitted_at')
      .eq('stage', 'full')
      .eq('status', 'approved')
      .order('submitted_at', { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    const completed = (rows || []).filter((r) => parseDeliverables(r.final_deliverables).length > 0);

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

    const solutions = completed.map((r) => {
      const p = problemMap.get(r.problem_id);
      const u = userMap.get(r.student_id);
      const participantType =
        teamKeys.has(`${r.student_id}:${r.problem_id}`) || r.participant_type === 'team' ? 'team' : 'individual';
      return {
        id: r.id,
        problemId: r.problem_id,
        problemTitle: (p && p.title) || 'Unknown problem',
        problemDomain: (p && p.domain) || null,
        authorName: (u && u.name) || 'SproutNet builder',
        authorSlug: (u && u.profile_slug) || null,
        participantType,
        score: r.score ?? null,
        feedback: r.judge_feedback ?? null,
        deliverables: parseDeliverables(r.final_deliverables),
        completedAt: r.submitted_at,
      };
    });
    res.json({ solutions });
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
      const byId = await admin.from('users').select(COLS).eq('id', slug).maybeSingle();
      if (byId.error) throw new Error(byId.error.message);
      profile = byId.data;
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
    const myIdx = allEntries.findIndex((e) => e.profile_slug === slug);
    const myEntry = myIdx >= 0 ? allEntries[myIdx] : null;
    let neighbors = [];
    if (myEntry) {
      neighbors = allEntries.slice(Math.max(0, myIdx - 2), Math.min(allEntries.length, myIdx + 3));
    }

    const { data: submissionRows, error: subError } = await admin
      .from('submissions')
      .select('id, score, status, created_at, problems(title)')
      .eq('student_id', profile.id)
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .limit(10);
    if (subError) throw new Error(subError.message);
    const submissions = (submissionRows || []).map((s) => {
      const p = Array.isArray(s.problems) ? s.problems[0] : s.problems;
      return {
        id: s.id,
        problem_title: (p && p.title) || null,
        score: s.score,
        status: s.status,
        created_at: s.created_at,
      };
    });

    const { data: enrollRows, error: enrError } = await admin
      .from('enrollments')
      .select('problem_id, milestone, problems(title, total_milestones)')
      .eq('student_id', profile.id)
      .neq('status', 'completed')
      .limit(10);
    if (enrError) throw new Error(enrError.message);
    const enrollments = (enrollRows || []).map((e) => {
      const p = Array.isArray(e.problems) ? e.problems[0] : e.problems;
      return {
        problem_id: e.problem_id,
        problem_title: (p && p.title) || null,
        milestone: e.milestone,
        total_milestones: (p && p.total_milestones) || 1,
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
