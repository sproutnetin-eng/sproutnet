const express = require('express');
const router = express.Router();
const { authRequired, optionalAuth, loadProfile, requireRole } = require('../middleware/auth');
const { getAdmin } = require('../supabase');
const upload = require('../middleware/upload');

// POST /api/messages/react — toggle an emoji reaction on a message
router.post('/api/messages/react', authRequired, async (req, res) => {
  const user = req.user;
  const admin = getAdmin();

  const { messageId, emoji } = req.body || {};
  if (!messageId || !emoji) {
    return res.status(422).json({ error: 'messageId and emoji are required' });
  }

  // Check if user already reacted with this emoji
  const { data: existing } = await admin
    .from('message_reactions')
    .select('id')
    .eq('message_id', messageId)
    .eq('user_id', user.id)
    .eq('emoji', emoji)
    .maybeSingle();

  if (existing) {
    // Remove reaction (toggle off)
    await admin
      .from('message_reactions')
      .delete()
      .eq('id', existing.id);

    return res.status(200).json({ reacted: false, emoji });
  } else {
    // Add reaction
    await admin
      .from('message_reactions')
      .insert({
        message_id: messageId,
        user_id: user.id,
        emoji,
      });

    return res.status(200).json({ reacted: true, emoji });
  }
});

// GET /api/discussion — list comments for a problem (public)
router.get('/api/discussion', optionalAuth, async (req, res) => {
  const problemId = req.query.problem_id;
  if (!problemId) {
    return res.status(400).json({ error: 'Problem ID is required' });
  }

  const admin = getAdmin();
  const { data: comments, error } = await admin
    .from('discussion')
    .select('id, body, created_at, author_id, parent_id, likes_count, users(name, role)')
    .eq('problem_id', problemId)
    .order('created_at', { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ comments: comments ?? [] });
});

// POST /api/discussion — post a comment on a problem
router.post('/api/discussion', authRequired, async (req, res) => {
  const user = req.user;

  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const problemId = payload.problem_id?.trim();
  const body = payload.body?.trim();
  const parentId = payload.parent_id?.trim() || null;

  if (!problemId) {
    return res.status(400).json({ error: 'Problem ID is required' });
  }
  if (!body) {
    return res.status(400).json({ error: 'Comment body is required' });
  }

  const admin = getAdmin();
  const { data, error } = await admin
    .from('discussion')
    .insert({
      problem_id: problemId,
      author_id: user.id,
      body,
      parent_id: parentId,
    })
    .select('id, body, created_at, author_id, parent_id, likes_count, users(name, role)')
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ comment: data });
});

// POST /api/discussion/like — toggle a like on a discussion comment
router.post('/api/discussion/like', authRequired, async (req, res) => {
  const user = req.user;
  const admin = getAdmin();

  const { commentId } = req.body || {};
  if (!commentId) {
    return res.status(422).json({ error: 'Comment ID is required' });
  }

  // Check if user already liked this comment
  const { data: existingLike } = await admin
    .from('discussion_likes')
    .select('id')
    .eq('discussion_id', commentId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (existingLike) {
    // Unlike: remove like and decrement count
    const { data: comment } = await admin
      .from('discussion')
      .select('likes_count')
      .eq('id', commentId)
      .single();

    const newCount = Math.max(0, (comment?.likes_count || 1) - 1);

    await admin
      .from('discussion')
      .update({ likes_count: newCount })
      .eq('id', commentId);

    await admin
      .from('discussion_likes')
      .delete()
      .eq('id', existingLike.id);

    return res.status(200).json({ liked: false, likes_count: newCount });
  } else {
    // Like: add like and increment count
    const { data: comment } = await admin
      .from('discussion')
      .select('likes_count')
      .eq('id', commentId)
      .single();

    const newCount = (comment?.likes_count || 0) + 1;

    await admin
      .from('discussion')
      .update({ likes_count: newCount })
      .eq('id', commentId);

    await admin
      .from('discussion_likes')
      .insert({ discussion_id: commentId, user_id: user.id });

    return res.status(200).json({ liked: true, likes_count: newCount });
  }
});

// POST /api/leaderboard/recalculate — recompute builder scores for all students (admin)
router.post('/api/leaderboard/recalculate', authRequired, loadProfile, requireRole('admin'), async (req, res) => {
  const admin = getAdmin();

  const { data: students } = await admin
    .from('users')
    .select('id, name, dept, year, profile_slug, builder_score, attempted, avg_score, milestones_done')
    .eq('role', 'student');

  if (!students || students.length === 0) {
    return res.status(200).json({ ok: true, message: 'No students found', recalculated: [] });
  }

  const { data: submissions } = await admin
    .from('submissions')
    .select('student_id, problem_id, milestone, status')
    .eq('status', 'approved');

  const { data: problems } = await admin
    .from('problems')
    .select('id, difficulty_score, leaderboard_weight');

  const weightMap = new Map();
  for (const p of (problems ?? [])) {
    weightMap.set(p.id, p.leaderboard_weight ?? 1.0);
  }

  const submissionCounts = new Map();
  for (const sub of (submissions ?? [])) {
    const entry = submissionCounts.get(sub.student_id) ?? { attempted: 0, milestones_done: 0, totalWeight: 0 };
    if (sub.milestone === 1) entry.attempted += 1;
    entry.milestones_done += 1;
    entry.totalWeight += weightMap.get(sub.problem_id) ?? 1.0;
    submissionCounts.set(sub.student_id, entry);
  }

  const recalculated = [];

  for (const student of students) {
    const counts = submissionCounts.get(student.id);
    const attempted = counts?.attempted ?? 0;
    const milestonesDone = counts?.milestones_done ?? 0;
    const totalWeight = counts?.totalWeight ?? 0;
    const avgWeight = milestonesDone > 0 ? Math.round((totalWeight / milestonesDone) * 100) / 100 : 1.0;
    const avgScore = student.avg_score ?? 5.0;

    const depth = Math.max(1, milestonesDone);
    const solutionsCompleted = Math.max(1, attempted);
    const newScore = Math.round(avgScore * depth * solutionsCompleted * avgWeight * 10) / 10;

    const formula = `${avgScore} (avg) × ${depth} (depth) × ${solutionsCompleted} (solved) × ${avgWeight} (avg weight) = ${newScore}`;

    recalculated.push({
      name: student.name,
      dept: student.dept,
      year: student.year,
      profile_slug: student.profile_slug,
      old_score: student.builder_score,
      new_score: newScore,
      attempted,
      milestones_done: milestonesDone,
      avg_weight: avgWeight,
      formula,
    });
  }

  recalculated.sort((a, b) => b.new_score - a.new_score);

  return res.status(200).json({
    ok: true,
    message: `Recalculated ${recalculated.length} student(s)`,
    formula: 'Builder Score = avg score × depth × solutions completed × average leaderboard weight',
    recalculated: recalculated.slice(0, 20),
  });
});

const FAKE_STUDENTS = [
  { name: 'Aditya Sharma', dept: 'Computer Science', year: '3rd Year', baseScore: 9.2, attempted: 4, done: 8, badges: ['Expert Solver', 'Multi-Domain'], slug: 'aditya-sharma' },
  { name: 'Priya Patel', dept: 'Information Science', year: '4th Year', baseScore: 8.7, attempted: 4, done: 7, badges: ['Deep Thinker', 'Consistent'], slug: 'priya-patel' },
  { name: 'Rahul Verma', dept: 'Computer Science', year: '3rd Year', baseScore: 8.1, attempted: 3, done: 6, badges: ['Weighted Scorer'], slug: 'rahul-verma' },
  { name: 'Sneha Reddy', dept: 'Electronics', year: '4th Year', baseScore: 7.8, attempted: 3, done: 5, badges: ['First Submission'], slug: 'sneha-reddy' },
  { name: 'Arjun Nair', dept: 'Mechanical', year: '3rd Year', baseScore: 7.2, attempted: 3, done: 5, badges: ['Rising Star'], slug: 'arjun-nair' },
  { name: 'Kavya Iyer', dept: 'Computer Science', year: '2nd Year', baseScore: 6.8, attempted: 2, done: 4, badges: ['Consistent'], slug: 'kavya-iyer' },
  { name: 'Vikram Joshi', dept: 'Information Science', year: '3rd Year', baseScore: 6.3, attempted: 2, done: 3, badges: [], slug: 'vikram-joshi' },
  { name: 'Ananya Gupta', dept: 'Civil Engineering', year: '4th Year', baseScore: 5.7, attempted: 2, done: 3, badges: ['First Submission'], slug: 'ananya-gupta' },
  { name: 'Rohit Singh', dept: 'Electronics', year: '2nd Year', baseScore: 4.9, attempted: 1, done: 2, badges: [], slug: 'rohit-singh' },
  { name: 'Meera Krishnan', dept: 'Mechanical', year: '1st Year', baseScore: 3.8, attempted: 1, done: 1, badges: [], slug: 'meera-krishnan' },
];

// POST /api/leaderboard/seed — seed the leaderboard with demo entries (admin)
router.post('/api/leaderboard/seed', authRequired, loadProfile, requireRole('admin'), async (req, res) => {
  const user = req.user;
  const admin = getAdmin();

  const { data: problems } = await admin
    .from('problems')
    .select('id, difficulty_score, leaderboard_weight')
    .limit(10);

  const avgWeight = problems && problems.length > 0
    ? Math.round(problems.reduce((s, p) => s + (p.leaderboard_weight ?? 1.0), 0) / problems.length * 100) / 100
    : 1.0;

  const leaderboardEntries = FAKE_STUDENTS.map((s, i) => {
    const depth = Math.max(1, s.done);
    const solved = Math.max(1, s.attempted);
    const builderScore = Math.round(s.baseScore * depth * solved * avgWeight * 10) / 10;
    return {
      rank: i + 1,
      builder_score: builderScore,
      name: s.name,
      dept: s.dept,
      year: s.year,
      profile_slug: s.slug,
      attempted: s.attempted,
      avg_score: s.baseScore,
      milestones_done: s.done,
      badges: s.badges,
    };
  });

  const { data: existingAdmin } = await admin
    .from('users')
    .select('id, name, dept, year, profile_slug, builder_score, attempted, avg_score, milestones_done')
    .eq('id', user.id)
    .single();

  if (existingAdmin) {
    const adminWeight = avgWeight;
    const adminDepth = Math.max(1, existingAdmin.milestones_done ?? 4);
    const adminSolved = Math.max(1, existingAdmin.attempted ?? 4);
    const adminAvg = existingAdmin.avg_score ?? 7.5;
    const adminScore = Math.round(adminAvg * adminDepth * adminSolved * adminWeight * 10) / 10;

    const adminEntry = {
      rank: -1,
      builder_score: adminScore,
      name: existingAdmin.name ?? 'Admin',
      dept: existingAdmin.dept ?? 'Admin',
      year: existingAdmin.year ?? '—',
      profile_slug: existingAdmin.profile_slug ?? user.id,
      attempted: existingAdmin.attempted ?? 4,
      avg_score: adminAvg,
      milestones_done: existingAdmin.milestones_done ?? 4,
      badges: ['Admin', 'Weighted Scorer'],
    };

    const insertIndex = leaderboardEntries.findIndex(e => adminScore > e.builder_score);
    if (insertIndex >= 0) {
      leaderboardEntries.splice(insertIndex, 0, adminEntry);
    } else {
      leaderboardEntries.push(adminEntry);
    }

    await admin.from('users').update({
      builder_score: adminScore,
      attempted: existingAdmin.attempted ?? 4,
      avg_score: adminAvg,
      milestones_done: existingAdmin.milestones_done ?? 4,
    }).eq('id', user.id);
  }

  await admin.from('leaderboard').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  const reindexed = leaderboardEntries.map((e, i) => ({ ...e, rank: i + 1 }));

  const { error: insertError } = await admin
    .from('leaderboard')
    .insert(reindexed);

  if (insertError) {
    return res.status(500).json({ ok: false, error: insertError.message });
  }

  return res.status(200).json({
    ok: true,
    summary: `Seeded ${reindexed.length} leaderboard entries`,
    formula: `Builder Score = avg score × depth × solved × avg weight (${avgWeight})`,
    entries: reindexed.map(e => ({ rank: e.rank, name: e.name, score: e.builder_score, formula: `${e.avg_score} × ${e.milestones_done} × ${e.attempted} × ${avgWeight} = ${e.builder_score}` })),
  });
});

const AVATAR_BUCKET = 'profile-avatars';
const AVATAR_ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

// Accepts the original 'avatar' field name as well as 'file'.
const avatarUpload = upload.fields([
  { name: 'avatar', maxCount: 1 },
  { name: 'file', maxCount: 1 },
]);

// POST /api/profile/avatar — upload a profile avatar image
router.post('/api/profile/avatar', authRequired, avatarUpload, async (req, res) => {
  const user = req.user;

  const files = req.files || {};
  const file = (files.avatar && files.avatar[0]) || (files.file && files.file[0]) || req.file || null;

  if (!file) {
    return res.status(400).json({ error: 'No file provided' });
  }

  if (!AVATAR_ALLOWED.includes(file.mimetype)) {
    return res.status(400).json({ error: 'File must be PNG, JPEG, WebP, or GIF' });
  }

  if (file.size > AVATAR_MAX_BYTES) {
    return res.status(400).json({ error: 'File must be under 5 MB' });
  }

  const ext = file.mimetype.split('/')[1] ?? 'png';
  const fileName = `${user.id}/${Date.now()}.${ext}`;

  const { error: uploadError } = await req.supabase.storage
    .from(AVATAR_BUCKET)
    .upload(fileName, file.buffer, { contentType: file.mimetype });

  if (uploadError) {
    return res.status(500).json({ error: uploadError.message });
  }

  const { data: publicUrl } = req.supabase.storage
    .from(AVATAR_BUCKET)
    .getPublicUrl(fileName);

  const admin = getAdmin();
  await admin.from('users').update({ avatar_url: publicUrl.publicUrl }).eq('id', user.id);

  return res.status(200).json({ ok: true, avatar_url: publicUrl.publicUrl });
});

// PUT /api/profile/update — update profile fields
router.put('/api/profile/update', authRequired, async (req, res) => {
  const user = req.user;

  const { name, dept, year, bio, github, linkedin, twitter, profile_slug } = req.body || {};

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (dept !== undefined) updates.dept = dept;
  if (year !== undefined) updates.year = year;
  if (bio !== undefined) updates.bio = bio;
  if (github !== undefined) updates.github = github;
  if (linkedin !== undefined) updates.linkedin = linkedin;
  if (twitter !== undefined) updates.twitter = twitter;
  if (profile_slug !== undefined) updates.profile_slug = profile_slug;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  const admin = getAdmin();

  if (profile_slug !== undefined) {
    const { data: existing } = await admin
      .from('users')
      .select('id')
      .eq('profile_slug', profile_slug)
      .neq('id', user.id)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'Profile slug already taken' });
    }
  }

  const { error } = await admin
    .from('users')
    .update(updates)
    .eq('id', user.id);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  if (profile_slug !== undefined) {
    await admin
      .from('leaderboard')
      .update({ profile_slug })
      .eq('profile_slug', user.id);
  }

  return res.status(200).json({ ok: true });
});

module.exports = router;
