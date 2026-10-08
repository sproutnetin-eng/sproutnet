const express = require('express');
const router = express.Router();

const { authRequired, optionalAuth, loadProfile, requireRole } = require('../middleware/auth');
const { getAdmin } = require('../supabase');

let MAX_ACTIVE_ENROLLMENTS = 2;
try {
  const lib = require('../lib/enrollment-progress');
  if (lib && lib.MAX_ACTIVE_ENROLLMENTS) MAX_ACTIVE_ENROLLMENTS = lib.MAX_ACTIVE_ENROLLMENTS;
} catch (e) { /* default to 2 */ }

// Team participation counts as an enrollment so the problem shows in the
// student dashboard and unlocks the solution submit page.
async function ensureEnrollment(admin, userId, problemId) {
  const { data: existing } = await admin
    .from('enrollments')
    .select('id, status')
    .eq('problem_id', problemId)
    .eq('student_id', userId)
    .maybeSingle();

  if (existing) {
    if (existing.status !== 'active') {
      const { error } = await admin.from('enrollments').update({ status: 'active' }).eq('id', existing.id);
      return { error: (error && error.message) || null };
    }
    return { error: null };
  }

  const { count } = await admin
    .from('enrollments')
    .select('id', { count: 'exact', head: true })
    .eq('student_id', userId)
    .eq('status', 'active');

  if ((count || 0) >= MAX_ACTIVE_ENROLLMENTS) {
    return { error: `You can only work on ${MAX_ACTIVE_ENROLLMENTS} problems at a time.` };
  }

  const { error } = await admin
    .from('enrollments')
    .insert({ problem_id: problemId, student_id: userId, status: 'active' });
  return { error: (error && error.message) || null };
}

router.post('/api/teams/create', authRequired, async (req, res) => {
  const admin = getAdmin();
  const user = req.user;

  const body = req.body || {};
  const problemId = body.problemId;
  const teamName = body.teamName;

  if (!problemId || !teamName || typeof teamName !== 'string' || !teamName.trim()) {
    return res.status(422).json({ error: 'Problem ID and team name are required' });
  }

  // Check if problem exists
  const { data: problem } = await admin
    .from('problems')
    .select('id, title, max_team_size, team_mode, deadline')
    .eq('id', problemId)
    .single();

  if (!problem) {
    return res.status(404).json({ error: 'Problem not found' });
  }

  if (problem.deadline && new Date(problem.deadline).getTime() < Date.now()) {
    return res.status(403).json({ error: 'Enrollment closed. The submission deadline for this problem has passed.' });
  }

  if (problem.team_mode === 'solo') {
    return res.status(400).json({ error: 'This problem only allows solo participation.' });
  }

  const enrollment = await ensureEnrollment(admin, user.id, problemId);
  if (enrollment.error) {
    return res.status(403).json({ error: enrollment.error });
  }

  // Generate unique invite code (e.g. SPROUT-8CHAR)
  const inviteCode = `SPROUT-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

  // Insert Team
  const { data: team, error: teamErr } = await admin
    .from('teams')
    .insert({
      problem_id: problemId,
      leader_id: user.id,
      name: teamName.trim(),
      invite_code: inviteCode,
    })
    .select()
    .single();

  if (teamErr || !team) {
    return res.status(400).json({ error: (teamErr && teamErr.message) || 'Failed to create team' });
  }

  // Insert Leader into team_members
  await admin.from('team_members').insert({
    team_id: team.id,
    user_id: user.id,
    role: 'leader',
  });

  // Create Workspace for Team
  const { data: workspace } = await admin
    .from('workspaces')
    .insert({ team_id: team.id })
    .select()
    .single();

  if (workspace) {
    // Create General Chat Channel
    const { data: channel } = await admin
      .from('conversations')
      .insert({
        workspace_id: workspace.id,
        type: 'channel',
        name: 'general',
        description: 'General workspace discussion',
        created_by: user.id,
      })
      .select()
      .single();

    if (channel) {
      await admin.from('conversation_members').insert({
        conversation_id: channel.id,
        user_id: user.id,
      });
    }

    // Log Activity
    await admin.from('activity_logs').insert({
      workspace_id: workspace.id,
      actor_id: user.id,
      action_type: 'TEAM_CREATED',
      description: `Team "${team.name}" created by leader.`,
      metadata: { leader_id: user.id },
    });
  }

  return res.json({ ok: true, teamId: team.id, inviteCode });
});

router.post('/api/teams/join', authRequired, async (req, res) => {
  const admin = getAdmin();
  const user = req.user;

  const body = req.body || {};
  const inviteCode = body.inviteCode;
  if (!inviteCode || typeof inviteCode !== 'string' || !inviteCode.trim()) {
    return res.status(422).json({ error: 'Invite code is required' });
  }

  const code = inviteCode.trim().toUpperCase();

  // Find team by invite code
  const { data: team } = await admin
    .from('teams')
    .select('id, name, leader_id, problem_id, problems(max_team_size, deadline)')
    .eq('invite_code', code)
    .single();

  if (!team) {
    return res.status(404).json({ error: 'Invalid or expired invite code' });
  }

  if (team.problems?.deadline && new Date(team.problems.deadline).getTime() < Date.now()) {
    return res.status(403).json({ error: 'Enrollment closed. The submission deadline for this problem has passed.' });
  }

  // Check current team size
  const { count: memberCount } = await admin
    .from('team_members')
    .select('id', { count: 'exact', head: true })
    .eq('team_id', team.id);

  const maxLimit = team.problems ? team.problems.max_team_size : 4;

  if ((memberCount || 0) >= maxLimit) {
    return res.status(400).json({ error: `Team capacity limit (${maxLimit} members) reached.` });
  }

  // Joining a team enrolls the member in the team's problem so it shows in
  // their dashboard and unlocks the solution submit page.
  const { data: existingEnrollment } = await admin
    .from('enrollments')
    .select('id, status')
    .eq('problem_id', team.problem_id)
    .eq('student_id', user.id)
    .maybeSingle();

  if (!existingEnrollment) {
    const { count: activeCount } = await admin
      .from('enrollments')
      .select('id', { count: 'exact', head: true })
      .eq('student_id', user.id)
      .eq('status', 'active');

    if ((activeCount || 0) >= MAX_ACTIVE_ENROLLMENTS) {
      return res.status(403).json(
        { error: `You can only work on ${MAX_ACTIVE_ENROLLMENTS} problems at a time. Finish one before joining this team.` }
      );
    }

    const { error: enrollErr } = await admin
      .from('enrollments')
      .insert({ problem_id: team.problem_id, student_id: user.id, status: 'active' });
    if (enrollErr) {
      return res.status(400).json({ error: enrollErr.message });
    }
  } else if (existingEnrollment.status !== 'active') {
    await admin.from('enrollments').update({ status: 'active' }).eq('id', existingEnrollment.id);
  }

  // Insert into team_members
  const { error: joinErr } = await admin
    .from('team_members')
    .insert({
      team_id: team.id,
      user_id: user.id,
      role: 'member',
    });

  if (joinErr) {
    if (joinErr.code === '23505') {
      return res.status(400).json({ error: 'You are already a member of this team.' });
    }
    return res.status(400).json({ error: joinErr.message });
  }

  // Add to workspace channel members
  const { data: workspace } = await admin
    .from('workspaces')
    .select('id')
    .eq('team_id', team.id)
    .maybeSingle();

  if (workspace) {
    const { data: channel } = await admin
      .from('conversations')
      .select('id')
      .eq('workspace_id', workspace.id)
      .eq('type', 'channel')
      .maybeSingle();

    if (channel) {
      await admin.from('conversation_members').upsert({
        conversation_id: channel.id,
        user_id: user.id,
      }, { onConflict: 'conversation_id, user_id' });
    }

    // Log Activity
    const { data: userProfile } = await admin.from('users').select('name').eq('id', user.id).single();
    const userName = (userProfile && userProfile.name) || 'A student';

    await admin.from('activity_logs').insert({
      workspace_id: workspace.id,
      actor_id: user.id,
      action_type: 'MEMBER_JOINED',
      description: `${userName} joined the team using invite code.`,
      metadata: { user_id: user.id },
    });

    // Send Notification to Team Leader
    if (team.leader_id !== user.id) {
      await admin.from('notifications').insert({
        user_id: team.leader_id,
        event_type: 'TEAM_MEMBER_JOINED',
        title: 'New Team Member Joined!',
        body: `${userName} joined your team "${team.name}".`,
        link_url: `/teams/${team.id}`,
        metadata: { team_id: team.id, member_id: user.id },
      });
    }
  }

  return res.json({ ok: true, teamId: team.id, teamName: team.name });
});

router.post('/api/teams/request-mentor', authRequired, async (req, res) => {
  const admin = getAdmin();
  const user = req.user;

  const body = req.body || {};
  const teamId = body.teamId;
  const mentorId = body.mentorId;
  const message = body.message;

  if (!teamId || !mentorId) {
    return res.status(422).json({ error: 'Team ID and Mentor ID are required' });
  }

  // Verify user is member of team
  const { data: membership } = await admin
    .from('team_members')
    .select('id, role')
    .eq('team_id', teamId)
    .eq('user_id', user.id)
    .single();

  if (!membership) {
    return res.status(403).json({ error: 'Forbidden. You are not a member of this team.' });
  }

  // Check mentor profile & availability
  const { data: mentorProf } = await admin
    .from('mentor_profiles')
    .select('*')
    .eq('user_id', mentorId)
    .single();

  if (!mentorProf || mentorProf.availability_status === 'unavailable') {
    return res.status(400).json({ error: 'This mentor is currently unavailable.' });
  }

  // Check active assignments count
  const { count: currentAssignments } = await admin
    .from('mentor_assignments')
    .select('id', { count: 'exact', head: true })
    .eq('mentor_id', mentorId);

  if ((currentAssignments || 0) >= mentorProf.max_active_teams) {
    return res.status(400).json({ error: 'This mentor has reached their maximum active team capacity.' });
  }

  // Create Mentor Request
  const { data: mentorReq, error: reqErr } = await admin
    .from('mentor_requests')
    .insert({
      team_id: teamId,
      mentor_id: mentorId,
      requested_by: user.id,
      message: message ? message.trim() : null,
    })
    .select()
    .single();

  if (reqErr) {
    if (reqErr.code === '23505') {
      return res.status(400).json({ error: 'A mentorship request has already been sent to this mentor.' });
    }
    return res.status(400).json({ error: reqErr.message });
  }

  // Notify Mentor
  const { data: team } = await admin.from('teams').select('name').eq('id', teamId).single();
  await admin.from('notifications').insert({
    user_id: mentorId,
    event_type: 'MENTOR_REQUEST_RECEIVED',
    title: 'New Mentorship Request',
    body: `Team "${(team && team.name) || 'A team'}" requested your guidance.`,
    link_url: '/mentor/dashboard',
    metadata: { team_id: teamId, request_id: mentorReq.id },
  });

  return res.json({ ok: true, requestId: mentorReq.id });
});

module.exports = router;
