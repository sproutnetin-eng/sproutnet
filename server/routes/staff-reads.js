const express = require('express');
const { authRequired, loadProfile, requireRole } = require('../middleware/auth');
const { getAdmin } = require('../supabase');

const router = express.Router();

const posterOnly = [authRequired, loadProfile, requireRole('poster', 'admin')];
const mentorOnly = [authRequired, loadProfile, requireRole('mentor', 'admin')];
const adminOnly = [authRequired, loadProfile, requireRole('admin')];

// Team-entry resolution (mirrors lib/team-entries.ts): a submission counts as
// a TEAM entry when the student is a member of a team on that problem.
async function getTeamEntryKeys(admin, userIds) {
  if (!userIds.length) return new Set();
  const { data } = await admin
    .from('team_members')
    .select('user_id, teams!inner(problem_id)')
    .in('user_id', userIds);
  const keys = new Set();
  for (const row of data || []) {
    if (row.teams && row.teams.problem_id) keys.add(`${row.user_id}:${row.teams.problem_id}`);
  }
  return keys;
}

function resolveParticipantType(storedType, userId, problemId, teamKeys) {
  if (teamKeys.has(`${userId}:${problemId}`)) return 'team';
  return storedType === 'team' ? 'team' : 'individual';
}

function fail(res, e, fallback) {
  return res.status(500).json({ error: (e && e.message) || fallback || 'Failed to load data' });
}

// ---------------------------------------------------------------------------
// Poster reads (was: app/(student)/poster/** server components, admin client)
// ---------------------------------------------------------------------------

// GET /api/poster/problems — problems posted by the logged-in poster.
router.get('/api/poster/problems', ...posterOnly, async (req, res) => {
  try {
    const admin = getAdmin();
    const { data, error } = await admin
      .from('problems')
      .select('id, title, domain, problem_type, status, reward_amount, milestones, deadline, submission_count, created_at')
      .eq('poster_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ problems: data || [] });
  } catch (e) { fail(res, e); }
});

// GET /api/poster/problems/:id — one owned problem for the edit form.
router.get('/api/poster/problems/:id', ...posterOnly, async (req, res) => {
  try {
    const admin = getAdmin();
    const full = 'id, title, domain, problem_type, thumbnail_url, reward_amount, milestones, deadline, judging_deadline, context, problem_stmt, scope, constraints, deliverables, status, team_mode, min_team_size, max_team_size';
    let { data, error } = await admin
      .from('problems')
      .select(full)
      .eq('id', req.params.id)
      .eq('poster_id', req.user.id)
      .single();
    if (error && /thumbnail_url/i.test(error.message || '')) {
      const retry = await admin
        .from('problems')
        .select(full.replace(', thumbnail_url', ''))
        .eq('id', req.params.id)
        .eq('poster_id', req.user.id)
        .single();
      error = retry.error;
      data = retry.data ? { ...retry.data, thumbnail_url: null } : null;
    }
    if (error || !data) return res.status(404).json({ error: 'Problem not found' });
    res.json({ problem: data });
  } catch (e) { fail(res, e); }
});

// GET /api/poster/problems/:id/enrollments — active enrollments + problem title.
router.get('/api/poster/problems/:id/enrollments', ...posterOnly, async (req, res) => {
  try {
    const admin = getAdmin();
    const { data: problem } = await admin
      .from('problems')
      .select('id, title, status, poster_id')
      .eq('id', req.params.id)
      .single();
    if (!problem || problem.poster_id !== req.user.id) {
      return res.status(404).json({ error: 'Problem not found' });
    }
    const { data, error } = await admin
      .from('enrollments')
      .select('id, created_at, student_id, status, users(name, dept, year)')
      .eq('problem_id', req.params.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ problem, enrollments: data || [] });
  } catch (e) { fail(res, e); }
});

// GET /api/poster/submissions — submissions across all my problems.
router.get('/api/poster/submissions', ...posterOnly, async (req, res) => {
  try {
    const admin = getAdmin();
    const { data: problems } = await admin
      .from('problems')
      .select('id, title, domain')
      .eq('poster_id', req.user.id);
    const problemIds = (problems || []).map((p) => p.id);
    if (!problemIds.length) return res.json({ problems: [], submissions: [] });
    const { data, error } = await admin
      .from('submissions')
      .select('id, stage, milestone, status, score, submitted_at, problem_id, student_id, problems(title, domain), users:student_id(name, dept, year)')
      .in('problem_id', problemIds)
      .order('submitted_at', { ascending: false });
    if (error) throw error;
    // Client reads `created_at`; real column is `submitted_at` — alias it.
    const submissions = (data || []).map((s) => ({ ...s, created_at: s.submitted_at }));
    res.json({ problems: problems || [], submissions });
  } catch (e) { fail(res, e); }
});

// ---------------------------------------------------------------------------
// Mentor reads (was: app/mentor/** server components, admin client)
// ---------------------------------------------------------------------------

// GET /api/mentor/dashboard — profile, assignments, team + connect requests.
router.get('/api/mentor/dashboard', ...mentorOnly, async (req, res) => {
  try {
    const admin = getAdmin();
    const [{ data: profile }, { data: mentorProfile }, { data: assignments },
      { data: pendingRequests }, { data: connectReqs }] = await Promise.all([
      admin.from('users').select('*').eq('id', req.user.id).single(),
      admin.from('mentor_profiles').select('*').eq('user_id', req.user.id).maybeSingle(),
      admin.from('mentor_assignments')
        .select('team_id, assigned_at, teams(id, name, status, problem_id, problems(id, title, domain))')
        .eq('mentor_id', req.user.id),
      admin.from('mentor_requests')
        .select('id, team_id, message, created_at, requested_by, users:requested_by(name, email), teams(id, name, problems(title, domain))')
        .eq('mentor_id', req.user.id)
        .eq('status', 'pending')
        .order('created_at', { ascending: false }),
      admin.from('notifications')
        .select('id, created_at, metadata, is_read')
        .eq('user_id', req.user.id)
        .eq('event_type', 'MENTOR_CONNECT_REQUEST')
        .order('created_at', { ascending: false }),
    ]);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json({
      profile,
      mentorProfile: mentorProfile || null,
      assignments: assignments || [],
      requests: pendingRequests || [],
      connections: connectReqs || [],
    });
  } catch (e) { fail(res, e); }
});

// GET /api/mentor/profile-data — mentor profile form prefill.
router.get('/api/mentor/profile-data', ...mentorOnly, async (req, res) => {
  try {
    const admin = getAdmin();
    const [{ data: profile }, { data: mentorProfile }] = await Promise.all([
      admin.from('users').select('id, name, role').eq('id', req.user.id).single(),
      admin.from('mentor_profiles').select('*').eq('user_id', req.user.id).maybeSingle(),
    ]);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json({ profile, mentorProfile: mentorProfile || null });
  } catch (e) { fail(res, e); }
});

// GET /api/mentor/connect/:notificationId — connect request + student detail.
router.get('/api/mentor/connect/:notificationId', ...mentorOnly, async (req, res) => {
  try {
    const admin = getAdmin();
    const { data: notif } = await admin
      .from('notifications')
      .select('id, metadata, is_read, created_at')
      .eq('id', req.params.notificationId)
      .eq('user_id', req.user.id)
      .single();
    if (!notif) return res.status(404).json({ error: 'Request not found' });
    if (!notif.is_read) {
      await admin.from('notifications').update({ is_read: true }).eq('id', req.params.notificationId);
      notif.is_read = true;
    }
    const studentId = notif.metadata && notif.metadata.student_id;
    if (!studentId) return res.status(404).json({ error: 'Request not found' });
    const { data: student } = await admin
      .from('users')
      .select('id, name, dept, year, role, bio, github, linkedin, twitter, avatar_url, builder_score, profile_slug')
      .eq('id', studentId)
      .single();
    if (!student) return res.status(404).json({ error: 'Student not found' });
    res.json({
      notification: notif,
      student,
      message: (notif.metadata && notif.metadata.message) || null,
      conversationId: (notif.metadata && notif.metadata.conversation_id) || null,
      isPending: !(notif.metadata && notif.metadata.response),
    });
  } catch (e) { fail(res, e); }
});

// ---------------------------------------------------------------------------
// Admin reads (was: app/admin/** server components, admin client)
// ---------------------------------------------------------------------------

// GET /api/admin/analytics — live counts + open-problem domain breakdown.
router.get('/api/admin/analytics', ...adminOnly, async (req, res) => {
  try {
    const admin = getAdmin();
    const [totalProblems, openProblems, pendingProblems, totalUsers,
      students, posters, adminsCount, enrollments, submissions, openDomains] = await Promise.all([
      admin.from('problems').select('id', { count: 'exact', head: true }),
      admin.from('problems').select('id', { count: 'exact', head: true }).eq('status', 'open'),
      admin.from('problems').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      admin.from('users').select('id', { count: 'exact', head: true }),
      admin.from('users').select('id', { count: 'exact', head: true }).eq('role', 'student'),
      admin.from('users').select('id', { count: 'exact', head: true }).eq('role', 'poster'),
      admin.from('users').select('id', { count: 'exact', head: true }).eq('role', 'admin'),
      admin.from('enrollments').select('id', { count: 'exact', head: true }),
      admin.from('submissions').select('id', { count: 'exact', head: true }),
      admin.from('problems').select('domain').eq('status', 'open'),
    ]);
    const counts = {};
    for (const row of openDomains.data || []) {
      const d = row.domain || 'Unknown';
      counts[d] = (counts[d] || 0) + 1;
    }
    const domains = Object.entries(counts)
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count);
    res.json({
      totalProblems: totalProblems.count || 0,
      openProblems: openProblems.count || 0,
      pendingProblems: pendingProblems.count || 0,
      totalUsers: totalUsers.count || 0,
      students: students.count || 0,
      posters: posters.count || 0,
      admins: adminsCount.count || 0,
      totalEnrollments: enrollments.count || 0,
      totalSubmissions: submissions.count || 0,
      domains,
    });
  } catch (e) { fail(res, e); }
});

// GET /api/admin/judging — stage-2 (full) pending submissions with joins.
router.get('/api/admin/judging', ...adminOnly, async (req, res) => {
  try {
    const admin = getAdmin();
    const { data, error } = await admin
      .from('submissions')
      .select('id, milestone, status, participant_type, final_deliverables, f_understanding, f_solution, f_impact, f_rootcause, f_feasibility, f_risks, f_implementation, submitted_at, problem_id, student_id')
      .eq('stage', 'full')
      .eq('status', 'pending')
      .order('submitted_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    const rows = data || [];
    const problemIds = Array.from(new Set(rows.map((r) => r.problem_id).filter(Boolean)));
    const studentIds = Array.from(new Set(rows.map((r) => r.student_id).filter(Boolean)));
    const teamKeys = await getTeamEntryKeys(admin, studentIds);
    const problemMap = new Map();
    const studentMap = new Map();
    if (problemIds.length) {
      const { data: probs } = await admin.from('problems').select('id, title, domain').in('id', problemIds);
      for (const p of probs || []) problemMap.set(p.id, p);
    }
    if (studentIds.length) {
      const { data: users } = await admin.from('users').select('id, name, dept, year').in('id', studentIds);
      for (const u of users || []) studentMap.set(u.id, u);
    }
    const queue = rows.map((r) => {
      const p = problemMap.get(r.problem_id) || {};
      const s = studentMap.get(r.student_id) || {};
      return {
        id: r.id,
        status: r.status,
        participantType: resolveParticipantType(r.participant_type, r.student_id, r.problem_id, teamKeys),
        deliverables: Array.isArray(r.final_deliverables) ? r.final_deliverables : [],
        fields: {
          f_understanding: r.f_understanding || '',
          f_solution: r.f_solution || '',
          f_impact: r.f_impact || '',
          f_rootcause: r.f_rootcause || '',
          f_feasibility: r.f_feasibility || '',
          f_risks: r.f_risks || '',
          f_implementation: r.f_implementation || '',
        },
        submittedAt: r.submitted_at,
        problemTitle: p.title || 'Unknown problem',
        problemDomain: p.domain || null,
        problemId: r.problem_id,
        studentName: s.name || 'Unknown student',
        studentDept: s.dept || null,
        studentYear: s.year || null,
      };
    });
    res.json({ rows: queue });
  } catch (e) { fail(res, e); }
});

// GET /api/admin/problems — all problems with poster names.
router.get('/api/admin/problems', ...adminOnly, async (req, res) => {
  try {
    const admin = getAdmin();
    const { data, error } = await admin
      .from('problems')
      .select('id, title, domain, problem_type, status, reward_amount, milestones, deadline, submission_count, created_at, poster_id')
      .order('created_at', { ascending: false });
    if (error) throw error;
    const rows = data || [];
    const posterIds = Array.from(new Set(rows.map((r) => r.poster_id).filter(Boolean)));
    const names = new Map();
    if (posterIds.length) {
      const { data: posters } = await admin.from('users').select('id, name').in('id', posterIds);
      for (const u of posters || []) names.set(u.id, u.name);
    }
    res.json({
      problems: rows.map((p) => ({
        id: p.id, title: p.title, domain: p.domain, problem_type: p.problem_type,
        status: p.status, reward_amount: p.reward_amount ?? null, milestones: p.milestones,
        deadline: p.deadline, submission_count: p.submission_count ?? 0, created_at: p.created_at,
        poster_id: p.poster_id, poster_name: names.get(p.poster_id) || null,
      })),
    });
  } catch (e) { fail(res, e); }
});

// GET /api/admin/problems/:id — one problem for the admin edit form.
router.get('/api/admin/problems/:id', ...adminOnly, async (req, res) => {
  try {
    const admin = getAdmin();
    const { data, error } = await admin
      .from('problems')
      .select('id, title, domain, problem_type, reward_amount, milestones, deadline, judging_deadline, context, problem_stmt, scope, constraints, deliverables, status, team_mode')
      .eq('id', req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Problem not found' });
    res.json({ problem: data });
  } catch (e) { fail(res, e); }
});

// GET /api/admin/problems/:id/enrollments — active enrollments with names.
router.get('/api/admin/problems/:id/enrollments', ...adminOnly, async (req, res) => {
  try {
    const admin = getAdmin();
    const { data: problem } = await admin
      .from('problems')
      .select('id, title')
      .eq('id', req.params.id)
      .single();
    if (!problem) return res.status(404).json({ error: 'Problem not found' });
    const { data, error } = await admin
      .from('enrollments')
      .select('id, created_at, student_id, status')
      .eq('problem_id', req.params.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false });
    if (error) throw error;
    const rows = data || [];
    const studentIds = Array.from(new Set(rows.map((r) => r.student_id).filter(Boolean)));
    const byId = new Map();
    if (studentIds.length) {
      const { data: users } = await admin.from('users').select('id, name, dept, year').in('id', studentIds);
      for (const u of users || []) byId.set(u.id, u);
    }
    res.json({
      problem,
      enrollments: rows.map((r) => {
        const s = byId.get(r.student_id) || {};
        return {
          id: r.id, created_at: r.created_at, student_id: r.student_id, status: r.status,
          student_name: s.name || null, student_dept: s.dept || null, student_year: s.year || null,
        };
      }),
    });
  } catch (e) { fail(res, e); }
});

// GET /api/admin/solutions — latest 200 full submissions with joins.
router.get('/api/admin/solutions', ...adminOnly, async (req, res) => {
  try {
    const admin = getAdmin();
    const { data, error } = await admin
      .from('submissions')
      .select('id, stage, milestone, status, score, participant_type, final_deliverables, f_understanding, f_solution, f_impact, f_rootcause, f_feasibility, f_risks, f_implementation, submitted_at, problem_id, student_id')
      .eq('stage', 'full')
      .order('submitted_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    const rows = data || [];
    const problemIds = Array.from(new Set(rows.map((r) => r.problem_id).filter(Boolean)));
    const studentIds = Array.from(new Set(rows.map((r) => r.student_id).filter(Boolean)));
    const teamKeys = await getTeamEntryKeys(admin, studentIds);
    const problemMap = new Map();
    const studentMap = new Map();
    if (problemIds.length) {
      const { data: probs } = await admin.from('problems').select('id, title, domain, team_mode').in('id', problemIds);
      for (const p of probs || []) problemMap.set(p.id, p);
    }
    if (studentIds.length) {
      const { data: users } = await admin.from('users').select('id, name, dept, year').in('id', studentIds);
      for (const u of users || []) studentMap.set(u.id, u);
    }
    res.json({
      solutions: rows.map((r) => {
        const p = problemMap.get(r.problem_id) || {};
        const s = studentMap.get(r.student_id) || {};
        return {
          id: r.id, status: r.status, score: r.score ?? null,
          participantType: resolveParticipantType(r.participant_type, r.student_id, r.problem_id, teamKeys),
          deliverables: Array.isArray(r.final_deliverables) ? r.final_deliverables : [],
          fields: {
            f_understanding: r.f_understanding || '', f_solution: r.f_solution || '',
            f_impact: r.f_impact || '', f_rootcause: r.f_rootcause || '',
            f_feasibility: r.f_feasibility || '', f_risks: r.f_risks || '',
            f_implementation: r.f_implementation || '',
          },
          createdAt: r.submitted_at,
          problemTitle: p.title || 'Unknown problem', problemDomain: p.domain || null,
          problemId: r.problem_id, studentName: s.name || 'Unknown student',
          studentDept: s.dept || null, studentYear: s.year || null,
        };
      }),
    });
  } catch (e) { fail(res, e); }
});

module.exports = router;
