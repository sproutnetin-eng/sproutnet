const express = require('express');
const router = express.Router();

const { authRequired, loadProfile, requireRole } = require('../middleware/auth');
const { getAdmin } = require('../supabase');

// ---- Enrollment progress helpers (port of lib/enrollment-progress.ts) ----

const MAX_ACTIVE_ENROLLMENTS = 2;

function getProblemMilestones(problem) {
  if (!problem) return null;
  return Array.isArray(problem) ? (problem[0]?.milestones ?? null) : (problem.milestones ?? null);
}

function getCompletedProblemIds(rows) {
  const completed = new Set();

  for (const row of rows) {
    const problemId = row.problem_id;
    const totalMilestones = getProblemMilestones(row.problems);

    if (!problemId || !row.milestone || !totalMilestones) continue;
    if (row.milestone >= totalMilestones) {
      completed.add(problemId);
    }
  }

  return Array.from(completed);
}

async function syncCompletedEnrollments(admin, studentId) {
  const { data, error } = await admin
    .from('submissions')
    .select('problem_id, milestone, problems(milestones)')
    .eq('student_id', studentId)
    .neq('status', 'draft');

  if (error || !data) {
    return [];
  }

  const completedProblemIds = getCompletedProblemIds(data);

  if (completedProblemIds.length > 0) {
    await admin
      .from('enrollments')
      .update({ status: 'completed' })
      .eq('student_id', studentId)
      .eq('status', 'active')
      .in('problem_id', completedProblemIds);
  }

  return completedProblemIds;
}

// ---- POST /api/enrollments/create (port of app/api/enrollments/create/route.ts) ----

router.post('/api/enrollments/create', authRequired, loadProfile, requireRole('student'), async (req, res) => {
  const user = req.user;
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const problemId = payload.problem_id;
  if (!problemId) {
    return res.status(400).json({ error: 'Missing problem_id' });
  }

  const admin = getAdmin();
  const completedProblemIds = await syncCompletedEnrollments(admin, user.id);

  if (completedProblemIds.includes(problemId)) {
    return res.status(403).json({ error: 'You already completed this problem.' });
  }

  const { data: existing } = await admin
    .from('enrollments')
    .select('id, status')
    .eq('problem_id', problemId)
    .eq('student_id', user.id)
    .limit(1);

  if (existing && existing.length > 0) {
    const status = existing[0]?.status;
    if (status === 'removed') {
      return res.status(403).json({ error: 'Enrollment removed by poster.' });
    }
    if (status === 'completed') {
      return res.status(403).json({ error: 'You already completed this problem.' });
    }
    if (status === 'active') {
      return res.status(200).json({ ok: true });
    }
  }

  const { count: activeEnrollmentCount, error: countError } = await admin
    .from('enrollments')
    .select('id', { count: 'exact', head: true })
    .eq('student_id', user.id)
    .eq('status', 'active');

  if (countError) {
    return res.status(400).json({ error: countError.message });
  }

  if ((activeEnrollmentCount ?? 0) >= MAX_ACTIVE_ENROLLMENTS) {
    return res.status(403).json(
      { error: `You can only work on ${MAX_ACTIVE_ENROLLMENTS} problems at a time. Finish one fully before enrolling in another.` }
    );
  }

  if (existing && existing.length > 0) {
    const status = existing[0]?.status;
    if (status === 'cancelled') {
      const { error: reactivateError } = await admin
        .from('enrollments')
        .update({ status: 'active' })
        .eq('id', existing[0].id)
        .eq('problem_id', problemId)
        .eq('student_id', user.id);

      if (reactivateError) {
        return res.status(400).json({ error: reactivateError.message });
      }

      return res.status(200).json({ ok: true });
    }
  }

  const { error } = await admin
    .from('enrollments')
    .insert({ problem_id: problemId, student_id: user.id, status: 'active' });

  if (error) {
    return res.status(400).json(
      { error: error.message, code: error.code, details: error.details, hint: error.hint }
    );
  }

  return res.status(200).json({ ok: true });
});

// ---- POST /api/enrollments/cancel (port of app/api/enrollments/cancel/route.ts) ----

router.post('/api/enrollments/cancel', authRequired, loadProfile, requireRole('student'), async (req, res) => {
  const user = req.user;
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const problemId = payload.problem_id;
  if (!problemId) {
    return res.status(400).json({ error: 'Missing problem_id' });
  }

  const admin = getAdmin();
  await syncCompletedEnrollments(admin, user.id);

  const { data: existing } = await admin
    .from('enrollments')
    .select('id, status')
    .eq('problem_id', problemId)
    .eq('student_id', user.id)
    .limit(1);

  if (!existing || existing.length === 0) {
    return res.status(404).json({ error: 'Enrollment not found.' });
  }

  const status = existing[0]?.status;
  if (status === 'removed') {
    return res.status(403).json({ error: 'Enrollment already removed by poster.' });
  }
  if (status === 'completed') {
    return res.status(400).json({ error: 'This problem is already completed.' });
  }

  if (status === 'cancelled') {
    return res.status(200).json({ ok: true });
  }

  const { data: submission } = await admin
    .from('submissions')
    .select('id')
    .eq('problem_id', problemId)
    .eq('student_id', user.id)
    .limit(1);

  if ((submission?.length ?? 0) > 0) {
    return res.status(403).json(
      { error: 'You already started this problem. Finish the full submission before moving to another one.' }
    );
  }

  const { error } = await admin
    .from('enrollments')
    .update({ status: 'cancelled' })
    .eq('id', existing[0].id)
    .eq('student_id', user.id)
    .eq('problem_id', problemId);

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.status(200).json({ ok: true });
});

// ---- POST /api/enrollments/remove (port of app/api/enrollments/remove/route.ts) ----

router.post('/api/enrollments/remove', authRequired, loadProfile, requireRole('poster', 'admin'), async (req, res) => {
  const user = req.user;
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const enrollmentId = payload.enrollment_id;
  const problemId = payload.problem_id;
  if (!enrollmentId || !problemId) {
    return res.status(400).json({ error: 'Missing enrollment_id or problem_id' });
  }

  const admin = getAdmin();
  const { data: problem } = await admin
    .from('problems')
    .select('poster_id')
    .eq('id', problemId)
    .single();

  if (!problem || (req.profile.role === 'poster' && problem.poster_id !== user.id)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const { error } = await admin
    .from('enrollments')
    .update({ status: 'removed' })
    .eq('id', enrollmentId)
    .eq('problem_id', problemId);

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.status(200).json({ ok: true });
});

// ---- POST /api/enrollments/status (port of app/api/enrollments/status/route.ts) ----

router.post('/api/enrollments/status', authRequired, loadProfile, requireRole('student'), async (req, res) => {
  const user = req.user;
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const problemId = payload.problem_id;
  if (!problemId) {
    return res.status(400).json({ error: 'Missing problem_id' });
  }

  const admin = getAdmin();
  await syncCompletedEnrollments(admin, user.id);

  const [{ data: enrollment }, { data: submission }, { count: activeEnrollmentCount }] = await Promise.all([
    admin
      .from('enrollments')
      .select('id, status')
      .eq('problem_id', problemId)
      .eq('student_id', user.id)
      .limit(1),
    admin
      .from('submissions')
      .select('id, problem_id, milestone, status, score, judge_feedback, problems(milestones)')
      .eq('problem_id', problemId)
      .eq('student_id', user.id),
    admin
      .from('enrollments')
      .select('id', { count: 'exact', head: true })
      .eq('student_id', user.id)
      .eq('status', 'active'),
  ]);

  const enrollmentStatus = enrollment?.[0]?.status ?? null;
  const completedProblemIds = getCompletedProblemIds(submission ?? []);
  const isCompleted = enrollmentStatus === 'completed' || completedProblemIds.includes(problemId);

  return res.status(200).json({
    enrolled: enrollmentStatus === 'active',
    hasSubmitted: (submission?.length ?? 0) > 0,
    completed: isCompleted,
    submissionStatus: submission?.[0]?.status ?? null,
    submissionScore: submission?.[0]?.score ?? null,
    judgeFeedback: submission?.[0]?.judge_feedback ?? null,
    activeEnrollmentCount: activeEnrollmentCount ?? 0,
    maxActiveEnrollments: MAX_ACTIVE_ENROLLMENTS,
  });
});

module.exports = router;
