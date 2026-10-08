const express = require('express');
const router = express.Router();

const { authRequired, loadProfile, requireRole } = require('../middleware/auth');
const { getAdmin } = require('../supabase');
const upload = require('../middleware/upload');

// Shared progress-upload helpers (same named exports as lib/problem-progress.ts).
// Falls back to an inlined port when server/lib/problem-progress.js is absent.
let ProgressLib;
try {
  ProgressLib = require('../lib/problem-progress');
} catch (e) {
  ProgressLib = {
    PROBLEM_PROGRESS_BUCKET: 'submission-progress',
    PROBLEM_PROGRESS_MAX_BYTES: 15 * 1024 * 1024,
    PROBLEM_PROGRESS_ALLOWED_TYPES: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/msword',
      'application/vnd.ms-powerpoint',
      'application/vnd.ms-excel',
      'text/csv',
      'application/zip',
      'application/x-zip-compressed',
      'image/jpeg',
      'image/png',
      'image/webp',
    ],
    getProblemProgressUploadError(file) {
      if (!ProgressLib.PROBLEM_PROGRESS_ALLOWED_TYPES.includes(file.type)) {
        return 'Use PDF, Office, CSV, ZIP, JPG, PNG, or WebP files for progress uploads.';
      }
      if (file.size > ProgressLib.PROBLEM_PROGRESS_MAX_BYTES) {
        return 'Each progress upload must be 15 MB or smaller.';
      }
      return null;
    },
    sanitizeProblemProgressFileName(name) {
      const lastDot = name.lastIndexOf('.');
      const base = (lastDot >= 0 ? name.slice(0, lastDot) : name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'progress-file';
      const extension = (lastDot >= 0 ? name.slice(lastDot + 1) : 'bin')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 10) || 'bin';
      return `${base}.${extension}`;
    },
  };
}

const {
  PROBLEM_PROGRESS_BUCKET,
  PROBLEM_PROGRESS_MAX_BYTES,
  PROBLEM_PROGRESS_ALLOWED_TYPES,
  getProblemProgressUploadError,
  sanitizeProblemProgressFileName,
} = ProgressLib;

// ---- Deliverable helpers (port of lib/deliverables.ts) ----

const DELIVERABLES_BUCKET = 'deliverables';
const DELIVERABLE_MAX_BYTES = 25 * 1024 * 1024;

function sanitizeDeliverableFileName(name) {
  const lastDot = name.lastIndexOf('.');
  const base = (lastDot >= 0 ? name.slice(0, lastDot) : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'file';
  const extension = (lastDot >= 0 ? name.slice(lastDot + 1) : 'bin')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12) || 'bin';

  return `${base}.${extension}`;
}

// ---- Leaderboard sync (port of lib/leaderboard-sync.ts) ----

async function syncStudentToLeaderboard(studentId) {
  const admin = getAdmin();

  const { data: student } = await admin
    .from('users')
    .select('id, name, dept, year, profile_slug')
    .eq('id', studentId)
    .single();

  if (!student) return;

  const { data: allSubs } = await admin
    .from('submissions')
    .select('problem_id, milestone, score')
    .eq('status', 'approved')
    .eq('student_id', studentId);

  const { data: problems } = await admin
    .from('problems')
    .select('id, leaderboard_weight');

  const weightMap = new Map();
  for (const p of (problems ?? [])) {
    weightMap.set(p.id, p.leaderboard_weight ?? 1.0);
  }

  let attempted = 0;
  let milestonesDone = 0;
  let totalScore = 0;
  let scoredCount = 0;
  let totalWeight = 0;

  for (const sub of (allSubs ?? [])) {
    if (sub.milestone === 1) attempted++;
    milestonesDone++;
    totalWeight += weightMap.get(sub.problem_id) ?? 1.0;
    if (sub.score != null) {
      totalScore += sub.score;
      scoredCount++;
    }
  }

  const avgScore = scoredCount > 0 ? Math.round((totalScore / scoredCount) * 10) / 10 : 0;
  const avgWeight = milestonesDone > 0 ? Math.round((totalWeight / milestonesDone) * 100) / 100 : 1.0;
  const depth = Math.max(1, milestonesDone);
  const solved = Math.max(1, attempted);
  const builderScore = Math.round(avgScore * depth * solved * avgWeight * 10) / 10;

  await admin.from('users').update({
    builder_score: builderScore,
    attempted,
    avg_score: avgScore,
    milestones_done: milestonesDone,
  }).eq('id', studentId);

  const badges = [];
  if (attempted >= 3) badges.push('Multi-Problem');
  if (avgScore >= 8) badges.push('Expert Solver');
  if (milestonesDone >= 5) badges.push('Deep Thinker');

  const existing = await admin
    .from('leaderboard')
    .select('id')
    .eq('profile_slug', student.profile_slug ?? studentId)
    .maybeSingle();

  const payload = {
    builder_score: builderScore,
    name: student.name,
    dept: student.dept,
    year: student.year,
    profile_slug: student.profile_slug ?? studentId,
    attempted,
    avg_score: avgScore,
    milestones_done: milestonesDone,
    badges,
  };

  if (existing?.data) {
    await admin.from('leaderboard').update(payload).eq('id', existing.data.id);
  } else {
    await admin.from('leaderboard').insert(payload);
  }

  const { data: all } = await admin
    .from('leaderboard')
    .select('id')
    .order('builder_score', { ascending: false });

  if (all) {
    for (let i = 0; i < all.length; i++) {
      await admin.from('leaderboard').update({ rank: i + 1 }).eq('id', all[i].id);
    }
  }
}

// ---- POST /api/submissions/deliverable-upload (port of app/api/submissions/deliverable-upload/route.ts) ----

router.post('/api/submissions/deliverable-upload', authRequired, loadProfile, requireRole('student'), upload.single('file'), async (req, res) => {
  const user = req.user;

  if (!req.file) {
    return res.status(400).json({ error: 'Missing file.' });
  }

  const problemId = req.body?.problem_id;

  if (typeof problemId !== 'string' || !problemId.trim()) {
    return res.status(400).json({ error: 'Missing problem_id.' });
  }

  if (req.file.size > DELIVERABLE_MAX_BYTES) {
    return res.status(422).json({ error: 'Files must be 25 MB or smaller.' });
  }
  if (req.file.size === 0) {
    return res.status(422).json({ error: 'File is empty.' });
  }

  const admin = getAdmin();
  const { data: enrollment } = await admin
    .from('enrollments')
    .select('id')
    .eq('problem_id', problemId)
    .eq('student_id', user.id)
    .eq('status', 'active')
    .limit(1);

  if (!enrollment || enrollment.length === 0) {
    return res.status(403).json({ error: 'You must enroll before uploading deliverables.' });
  }

  await admin.storage.createBucket(DELIVERABLES_BUCKET, {
    public: true,
    fileSizeLimit: DELIVERABLE_MAX_BYTES,
  }).catch(() => null);

  // Relax restrictions in case the bucket pre-existed with tighter limits.
  await admin.storage.updateBucket(DELIVERABLES_BUCKET, {
    public: true,
    fileSizeLimit: DELIVERABLE_MAX_BYTES,
  }).catch(() => null);

  const filePath = `${user.id}/${problemId}/${Date.now()}-${crypto.randomUUID()}-${sanitizeDeliverableFileName(req.file.originalname)}`;

  const { error: uploadError } = await admin.storage
    .from(DELIVERABLES_BUCKET)
    .upload(filePath, req.file.buffer, {
      contentType: req.file.mimetype || 'application/octet-stream',
      upsert: false,
    });

  if (uploadError) {
    return res.status(400).json({ error: uploadError.message });
  }

  const { data } = admin.storage
    .from(DELIVERABLES_BUCKET)
    .getPublicUrl(filePath);

  return res.status(200).json({
    name: req.file.originalname,
    path: filePath,
    url: data.publicUrl,
  });
});

// ---- POST /api/submissions/judge (port of app/api/submissions/judge/route.ts) ----

router.post('/api/submissions/judge', authRequired, loadProfile, requireRole('poster', 'admin'), async (req, res) => {
  const { submission_id, score, feedback, decision } = (req.body || {});

  if (!submission_id || score == null || score < 0 || score > 10) {
    return res.status(400).json({ error: 'Invalid input. score must be 0-10.' });
  }

  const finalStatus = decision === 'reject' ? 'rejected' : 'approved';

  const admin = getAdmin();

  const { data: sub } = await admin
    .from('submissions')
    .select('id, student_id, status, problem_id')
    .eq('id', submission_id)
    .single();

  if (!sub) {
    return res.status(404).json({ error: 'Submission not found' });
  }

  // Posters may only judge submissions on problems they posted.
  // Admins (or master users) may judge anything.
  const isPrivileged = req.profile?.role === 'admin' || req.profile?.is_master;
  if (!isPrivileged) {
    const { data: problem } = await admin
      .from('problems')
      .select('poster_id')
      .eq('id', sub.problem_id)
      .single();
    if (!problem || problem.poster_id !== req.user.id) {
      return res.status(404).json({ error: 'Submission not found' });
    }
  }

  if (sub.status === 'judged' || sub.status === 'approved' || sub.status === 'rejected') {
    return res.status(409).json({ error: 'Already judged' });
  }

  const { error: updateError } = await admin
    .from('submissions')
    .update({
      status: finalStatus,
      score,
      judge_feedback: feedback ?? null,
    })
    .eq('id', submission_id);

  if (updateError) {
    return res.status(500).json({ error: updateError.message });
  }

  await syncStudentToLeaderboard(sub.student_id);

  // Tell the student the verdict so an approval unlocks their final PDF
  // upload and a rejection sends them back to revise.
  try {
    const { data: judgedProblem } = await admin
      .from('problems')
      .select('title')
      .eq('id', sub.problem_id)
      .maybeSingle();
    const pTitle = judgedProblem?.title || 'your problem';
    await admin.from('notifications').insert({
      user_id: sub.student_id,
      event_type: finalStatus === 'approved' ? 'SUBMISSION_APPROVED' : 'SUBMISSION_REJECTED',
      title: finalStatus === 'approved' ? 'Solution approved!' : 'Solution needs revision',
      body: finalStatus === 'approved'
        ? `Your solution for "${pTitle}" was approved with ${score}/10. You can now upload your final PDF and deliverables.`
        : `Your solution for "${pTitle}" was not approved. Check the feedback and resubmit.`,
      link_url: finalStatus === 'approved'
        ? `/problems/${sub.problem_id}/final-upload`
        : `/problems/${sub.problem_id}/submit`,
      metadata: { problem_id: sub.problem_id, submission_id, score },
    });
  } catch (e) { console.error('judge notify failed:', e.message); }

  return res.status(200).json({ ok: true, score, student_id: sub.student_id });
});

// ---- POST /api/submissions/notify-poster ----
// Called by the student right after submitting all 7 fields. Routes the
// submission to the poster who posted the problem for review. (Submits are
// written straight to Supabase from the browser, so the server only learns
// about them through this call.)
router.post('/api/submissions/notify-poster', authRequired, loadProfile, requireRole('student'), async (req, res) => {
  const { problem_id } = req.body || {};
  if (!problem_id) return res.status(400).json({ error: 'Missing problem_id' });

  const admin = getAdmin();
  const { data: submission } = await admin
    .from('submissions')
    .select('id, status, stage')
    .eq('problem_id', problem_id)
    .eq('student_id', req.user.id)
    .neq('status', 'draft')
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!submission) return res.status(404).json({ error: 'No submitted solution found' });

  const { data: problem } = await admin
    .from('problems')
    .select('id, title, poster_id')
    .eq('id', problem_id)
    .single();
  if (!problem) return res.status(404).json({ error: 'Problem not found' });
  if (problem.poster_id === req.user.id) return res.status(200).json({ ok: true });

  const { data: student } = await admin
    .from('users')
    .select('name')
    .eq('id', req.user.id)
    .single();

  // One unread nudge per student+problem — re-submits don't spam the poster.
  const { data: existing } = await admin
    .from('notifications')
    .select('id')
    .eq('user_id', problem.poster_id)
    .eq('event_type', 'SUBMISSION_SUBMITTED')
    .eq('is_read', false)
    .filter('metadata->>problem_id', 'eq', problem_id)
    .filter('metadata->>student_id', 'eq', req.user.id)
    .limit(1);
  if (existing && existing.length) return res.status(200).json({ ok: true });

  const { error } = await admin.from('notifications').insert({
    user_id: problem.poster_id,
    event_type: 'SUBMISSION_SUBMITTED',
    title: 'New solution submitted',
    body: `${student?.name || 'A student'} submitted a 7-field solution for "${problem.title}". Review it to approve or reject.`,
    link_url: `/poster/solutions?problem=${problem_id}`,
    metadata: { problem_id, student_id: req.user.id, submission_id: submission.id },
  });
  if (error) return res.status(400).json({ error: error.message });
  return res.status(200).json({ ok: true });
});

// ---- POST /api/submissions/progress-upload (port of app/api/submissions/progress-upload/route.ts) ----

router.post('/api/submissions/progress-upload', authRequired, loadProfile, requireRole('student'), upload.single('file'), async (req, res) => {
  const user = req.user;

  if (!req.file) {
    return res.status(400).json({ error: 'Missing progress file.' });
  }

  const problemId = req.body?.problem_id;

  if (typeof problemId !== 'string' || !problemId.trim()) {
    return res.status(400).json({ error: 'Missing problem_id.' });
  }

  const shim = { name: req.file.originalname, size: req.file.size, type: req.file.mimetype };
  const validationError = getProblemProgressUploadError(shim);
  if (validationError) {
    return res.status(422).json({ error: validationError });
  }

  const admin = getAdmin();
  const { data: enrollment } = await admin
    .from('enrollments')
    .select('id')
    .eq('problem_id', problemId)
    .eq('student_id', user.id)
    .eq('status', 'active')
    .limit(1);

  if (!enrollment || enrollment.length === 0) {
    return res.status(403).json({ error: 'You must enroll before uploading progress.' });
  }

  await admin.storage.createBucket(PROBLEM_PROGRESS_BUCKET, {
    public: true,
    fileSizeLimit: PROBLEM_PROGRESS_MAX_BYTES,
    allowedMimeTypes: PROBLEM_PROGRESS_ALLOWED_TYPES,
  }).catch(() => null);

  const filePath = `${user.id}/${problemId}/${Date.now()}-${crypto.randomUUID()}-${sanitizeProblemProgressFileName(req.file.originalname)}`;

  const { error: uploadError } = await admin.storage
    .from(PROBLEM_PROGRESS_BUCKET)
    .upload(filePath, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    });

  if (uploadError) {
    return res.status(400).json({ error: uploadError.message });
  }

  const { data } = admin.storage
    .from(PROBLEM_PROGRESS_BUCKET)
    .getPublicUrl(filePath);

  return res.status(200).json({
    name: req.file.originalname,
    path: filePath,
    url: data.publicUrl,
  });
});

module.exports = router;
