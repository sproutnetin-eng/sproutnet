'use strict';

function createAdminClient() {
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase admin credentials are not configured');
  return createClient(url, key);
}

function isSupabaseClient(value) {
  return !!value && typeof value === 'object' && typeof value.from === 'function';
}

// Accepts an already-created supabase (admin) client as a parameter:
//   syncStudentToLeaderboard(admin, studentId)
// For backwards compatibility, syncStudentToLeaderboard(studentId) and
// syncStudentToLeaderboard(studentId, admin) also work.
async function syncStudentToLeaderboard(adminOrStudentId, maybeStudentIdOrAdmin) {
  let admin;
  let studentId;
  if (isSupabaseClient(adminOrStudentId)) {
    admin = adminOrStudentId;
    studentId = maybeStudentIdOrAdmin;
  } else if (isSupabaseClient(maybeStudentIdOrAdmin)) {
    studentId = adminOrStudentId;
    admin = maybeStudentIdOrAdmin;
  } else {
    studentId = adminOrStudentId;
    admin = createAdminClient();
  }

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

module.exports = {
  syncStudentToLeaderboard,
};
