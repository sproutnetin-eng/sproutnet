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

router.post('/api/submissions/judge', authRequired, loadProfile, requireRole('admin'), async (req, res) => {
  const { submission_id, score, feedback, decision } = (req.body || {});

  if (!submission_id || score == null || score < 0 || score > 10) {
    return res.status(400).json({ error: 'Invalid input. score must be 0-10.' });
  }

  const finalStatus = decision === 'reject' ? 'rejected' : 'approved';

  const admin = getAdmin();

  const { data: sub } = await admin
    .from('submissions')
    .select('id, student_id, status')
    .eq('id', submission_id)
    .single();

  if (!sub) {
    return res.status(404).json({ error: 'Submission not found' });
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

  return res.status(200).json({ ok: true, score, student_id: sub.student_id });
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
