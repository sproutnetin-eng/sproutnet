const express = require('express');
const router = express.Router();
const { authRequired, optionalAuth, loadProfile, requireRole } = require('../middleware/auth');
const { getAdmin } = require('../supabase');

// POST /api/mentors/connect — student requests a mentorship connection with a mentor
router.post('/api/mentors/connect', authRequired, async (req, res) => {
  const user = req.user;
  const admin = getAdmin();

  const { mentorId, message } = req.body || {};
  if (!mentorId) {
    return res.status(422).json({ error: 'Mentor ID is required' });
  }

  // Verify user is a student
  const { data: profile } = await admin
    .from('users')
    .select('id, name, role')
    .eq('id', user.id)
    .single();

  if (!profile || profile.role !== 'student') {
    return res.status(403).json({ error: 'Only students can connect with mentors' });
  }

  // Check if mentor exists and is available
  const { data: mentorProf } = await admin
    .from('mentor_profiles')
    .select('user_id, availability_status')
    .eq('user_id', mentorId)
    .single();

  if (!mentorProf) {
    return res.status(404).json({ error: 'Mentor not found' });
  }

  if (mentorProf.availability_status === 'unavailable') {
    return res.status(400).json({ error: 'This mentor is currently unavailable.' });
  }

  // Check for existing pending connection
  const { data: existing } = await admin
    .from('notifications')
    .select('id')
    .eq('user_id', mentorId)
    .eq('event_type', 'MENTOR_CONNECT_REQUEST')
    .eq('metadata->>student_id', user.id)
    .maybeSingle();

  if (existing) {
    return res.status(400).json({ error: 'You already have a pending connection request with this mentor.' });
  }

  // Get student name
  const studentName = profile.name || 'A student';

  // Create or find DM conversation between student and mentor
  const { data: studentConvs } = await admin
    .from('conversation_members')
    .select('conversation_id')
    .eq('user_id', user.id);
  const studentConvIds = (studentConvs || []).map(c => c.conversation_id);

  const { data: mentorConvs } = await admin
    .from('conversation_members')
    .select('conversation_id')
    .eq('user_id', mentorId);
  const mentorConvIds = new Set((mentorConvs || []).map(c => c.conversation_id));

  const sharedConvId = studentConvIds.find(id => mentorConvIds.has(id));

  let conversationId = sharedConvId || null;

  if (!conversationId) {
    const { data: conv } = await admin
      .from('conversations')
      .insert({
        type: 'dm',
        created_by: user.id
      })
      .select()
      .single();

    if (conv) {
      conversationId = conv.id;
      await admin.from('conversation_members').insert([
        { conversation_id: conv.id, user_id: user.id },
        { conversation_id: conv.id, user_id: mentorId }
      ]);
    }
  }

  // Send notification to mentor
  const { data: notifRow } = await admin.from('notifications').insert({
    user_id: mentorId,
    event_type: 'MENTOR_CONNECT_REQUEST',
    title: 'New Mentorship Connection',
    body: message
      ? `${studentName} wants to connect: "${message}"`
      : `${studentName} wants to connect with you for mentorship.`,
    link_url: '/mentor/dashboard',
    metadata: {
      student_id: user.id,
      student_name: studentName,
      message: message || null,
      conversation_id: conversationId,
    }
  }).select('id').single();

  // Update link_url to point to the dedicated profile page
  if (notifRow) {
    await admin.from('notifications').update({
      link_url: `/mentor/connect/${notifRow.id}`
    }).eq('id', notifRow.id);
  }

  // Log activity
  await admin.from('activity_logs').insert({
    actor_id: user.id,
    action_type: 'MENTOR_CONNECT_REQUEST',
    description: `${studentName} sent a mentorship connection request.`,
    metadata: { mentor_id: mentorId }
  });

  return res.status(200).json({ ok: true, conversationId });
});

// POST /api/mentors/profile — mentor upserts their public profile (HTML form post)
router.post('/api/mentors/profile', optionalAuth, async (req, res) => {
  const user = req.user;
  if (!user) {
    return res.redirect(307, '/login/mentor');
  }
  const supabase = req.supabase;
  const admin = getAdmin();

  const { data: profile } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || (profile.role !== 'mentor' && profile.role !== 'admin')) {
    return res.redirect(307, '/dashboard');
  }

  const body = req.body || {};
  const bio = body.bio || '';
  const skillsRaw = body.skills || '';
  const techRaw = body.technologies || '';
  const availabilityStatus = body.availability_status || 'available';
  const maxActiveTeams = parseInt(body.max_active_teams || '3', 10);
  const linkedinUrl = body.linkedin_url || '';
  const githubUrl = body.github_url || '';
  const portfolioUrl = body.portfolio_url || '';

  const skills = skillsRaw.split(',').map(s => s.trim()).filter(Boolean);
  const technologies = techRaw.split(',').map(t => t.trim()).filter(Boolean);

  const { error } = await admin
    .from('mentor_profiles')
    .upsert({
      user_id: user.id,
      bio,
      skills,
      technologies,
      availability_status: availabilityStatus,
      max_active_teams: maxActiveTeams,
      linkedin_url: linkedinUrl,
      github_url: githubUrl,
      portfolio_url: portfolioUrl,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });

  if (error) {
    console.error('Error updating mentor profile:', error);
  }

  return res.redirect(307, '/mentor/dashboard');
});

// POST /api/mentors/availability — mentor flips their own availability status
router.post('/api/mentors/availability', authRequired, loadProfile, requireRole('mentor', 'admin'), async (req, res) => {
  const status = req.body?.availability_status;
  if (!['available', 'busy', 'unavailable'].includes(status)) {
    return res.status(400).json({ error: 'Invalid availability status.' });
  }
  const admin = getAdmin();
  const { error } = await admin
    .from('mentor_profiles')
    .upsert(
      { user_id: req.user.id, availability_status: status, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  return res.json({ ok: true, availability_status: status });
});

// POST /api/mentors/request — mentor accepts/rejects a team mentor request (HTML form post)
router.post('/api/mentors/request', optionalAuth, async (req, res) => {
  const user = req.user;
  if (!user) {
    return res.redirect(307, '/login/mentor');
  }
  const admin = getAdmin();

  const body = req.body || {};
  const requestId = body.requestId;
  const action = body.action;

  if (!requestId || !['accept', 'reject'].includes(action)) {
    return res.redirect(307, '/mentor/dashboard');
  }

  // Fetch the mentor request
  const { data: reqData } = await admin
    .from('mentor_requests')
    .select('*, teams(id, name, leader_id)')
    .eq('id', requestId)
    .eq('mentor_id', user.id)
    .single();

  if (!reqData) {
    return res.redirect(307, '/mentor/dashboard');
  }

  const newStatus = action === 'accept' ? 'accepted' : 'rejected';

  // Update request status
  await admin
    .from('mentor_requests')
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq('id', requestId);

  if (action === 'accept') {
    // Insert into mentor_assignments
    await admin
      .from('mentor_assignments')
      .upsert({
        team_id: reqData.team_id,
        mentor_id: user.id
      }, { onConflict: 'team_id, mentor_id' });

    // Ensure Workspace exists for team
    let { data: workspace } = await admin
      .from('workspaces')
      .select('id')
      .eq('team_id', reqData.team_id)
      .maybeSingle();

    if (!workspace) {
      const { data: newWs } = await admin
        .from('workspaces')
        .insert({ team_id: reqData.team_id })
        .select()
        .single();
      workspace = newWs;
    }

    if (workspace) {
      // Create default general channel if not existing
      let { data: channel } = await admin
        .from('conversations')
        .select('id')
        .eq('workspace_id', workspace.id)
        .eq('type', 'channel')
        .maybeSingle();

      if (!channel) {
        const { data: newChan } = await admin
          .from('conversations')
          .insert({
            workspace_id: workspace.id,
            type: 'channel',
            name: 'general',
            description: 'General team and mentor collaboration channel',
            created_by: user.id
          })
          .select()
          .single();
        channel = newChan;
      }

      // Add mentor to conversation members
      if (channel) {
        await admin
          .from('conversation_members')
          .upsert({
            conversation_id: channel.id,
            user_id: user.id
          }, { onConflict: 'conversation_id, user_id' });
      }
    }

    // Send Notification to Team Leader
    await admin
      .from('notifications')
      .insert({
        user_id: reqData.requested_by,
        event_type: 'MENTOR_ACCEPTED',
        title: 'Mentor Request Accepted!',
        body: `A mentor has accepted your request for team "${reqData.teams?.name}". You can now collaborate in your Team Workspace.`,
        link_url: `/teams/${reqData.team_id}`,
        metadata: { team_id: reqData.team_id, mentor_id: user.id }
      });
  } else {
    // Send Rejected Notification
    await admin
      .from('notifications')
      .insert({
        user_id: reqData.requested_by,
        event_type: 'MENTOR_REJECTED',
        title: 'Mentor Request Declined',
        body: `Your mentor request for team "${reqData.teams?.name}" was declined. You can request another mentor.`,
        link_url: `/teams/${reqData.team_id}`,
        metadata: { team_id: reqData.team_id, mentor_id: user.id }
      });
  }

  return res.redirect(307, '/mentor/dashboard');
});

// POST /api/mentors/respond-connect — mentor accepts/declines a student connection request
router.post('/api/mentors/respond-connect', authRequired, async (req, res) => {
  const user = req.user;
  const admin = getAdmin();

  const { notificationId, action } = req.body || {};
  if (!notificationId || !action || !['accept', 'decline'].includes(action)) {
    return res.status(422).json({ error: 'Invalid request' });
  }

  // Verify the notification belongs to this mentor
  const { data: notif } = await admin
    .from('notifications')
    .select('id, metadata')
    .eq('id', notificationId)
    .eq('user_id', user.id)
    .single();

  if (!notif) {
    return res.status(404).json({ error: 'Notification not found' });
  }

  // Get mentor name
  const { data: mentorUser } = await admin
    .from('users')
    .select('name')
    .eq('id', user.id)
    .single();

  const mentorName = mentorUser?.name || 'Your mentor';
  const studentId = notif.metadata?.student_id;

  if (action === 'accept') {
    await admin.from('notifications').update({
      is_read: true,
      metadata: { ...notif.metadata, response: 'accepted' }
    }).eq('id', notificationId);

    // Notify the student
    if (studentId) {
      await admin.from('notifications').insert({
        user_id: studentId,
        event_type: 'MENTOR_ACCEPTED',
        title: 'Mentor Connection Accepted!',
        body: `${mentorName} has accepted your mentorship request. You can now start chatting!`,
        link_url: '/messages',
        metadata: { mentor_id: user.id, conversation_id: notif.metadata?.conversation_id }
      });
    }
  } else {
    await admin.from('notifications').update({
      is_read: true,
      metadata: { ...notif.metadata, response: 'declined' }
    }).eq('id', notificationId);

    // Notify the student
    if (studentId) {
      await admin.from('notifications').insert({
        user_id: studentId,
        event_type: 'MENTOR_REJECTED',
        title: 'Mentor Request Declined',
        body: `${mentorName} has declined your mentorship request. You can connect with other mentors.`,
        link_url: '/mentors',
        metadata: { mentor_id: user.id }
      });
    }
  }

  return res.status(200).json({ ok: true });
});

module.exports = router;
