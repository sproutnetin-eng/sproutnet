'use strict';

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

module.exports = {
  MAX_ACTIVE_ENROLLMENTS,
  getCompletedProblemIds,
  syncCompletedEnrollments,
};
