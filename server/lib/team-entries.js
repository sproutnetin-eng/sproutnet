'use strict';

// Team-entry resolution: a submission counts as a TEAM entry when the student
// is a member of a team working on that problem — regardless of what the
// participant_type toggle said at submit time.

async function getTeamEntryKeys(admin, userIds) {
  if (userIds.length === 0) return new Set();

  const { data } = await admin
    .from('team_members')
    .select('user_id, teams!inner(problem_id)')
    .in('user_id', userIds);

  const keys = new Set();
  for (const row of (data ?? [])) {
    if (row.teams?.problem_id) keys.add(`${row.user_id}:${row.teams.problem_id}`);
  }
  return keys;
}

function resolveParticipantType(storedType, userId, problemId, teamKeys) {
  if (teamKeys.has(`${userId}:${problemId}`)) return 'team';
  return storedType === 'team' ? 'team' : 'individual';
}

module.exports = {
  getTeamEntryKeys,
  resolveParticipantType,
};
