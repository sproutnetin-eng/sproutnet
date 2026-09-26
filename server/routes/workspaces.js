const express = require('express');
const router = express.Router();

const { authRequired, optionalAuth, loadProfile, requireRole } = require('../middleware/auth');
const { getAdmin } = require('../supabase');

function tryRequire(path) {
  try {
    return require(path);
  } catch (e) {
    return null;
  }
}

const permissionsLib = tryRequire('../lib/workspace/permissions') || {};
const activityLib = tryRequire('../lib/workspace/activity') || {};
const membersLib = tryRequire('../lib/workspace/members') || {};
const progressLib = tryRequire('../lib/workspace/progress') || {};

const getWorkspaceRole = permissionsLib.getWorkspaceRole || (async (userId, workspaceId, admin) => {
  const db = admin || getAdmin();
  const { data: member } = await db
    .from('team_members')
    .select('role')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (member) return member.role;
  const { data: mentor } = await db
    .from('mentor_assignments')
    .select('mentor_id, teams!inner(id, workspaces!inner(id))')
    .eq('mentor_id', userId)
    .eq('assignment_status', 'active')
    .eq('teams.workspaces.id', workspaceId)
    .maybeSingle();
  if (mentor) return 'mentor';
  const { data: user } = await db
    .from('users')
    .select('role, is_master')
    .eq('id', userId)
    .single();
  if ((user && user.role === 'admin') || (user && user.is_master)) return 'admin';
  return null;
});

const checkWorkspacePermission = permissionsLib.checkWorkspacePermission || (async (userId, workspaceId, permission, admin) => {
  const db = admin || getAdmin();
  const role = await getWorkspaceRole(userId, workspaceId, db);
  if (!role) return false;
  const { data: user } = await db
    .from('users')
    .select('role, is_master')
    .eq('id', userId)
    .single();
  if ((user && user.role === 'admin') || (user && user.is_master)) return true;
  const { data: roleRow } = await db
    .from('workspace_roles')
    .select('id')
    .eq('name', role)
    .single();
  if (!roleRow) return false;
  const { data: permRows } = await db
    .from('workspace_role_permissions')
    .select('permission')
    .eq('role_id', roleRow.id);
  if (!permRows) return false;
  return permRows.some((p) => p.permission === '*' || p.permission === permission);
});

const logWorkspaceActivity = activityLib.logWorkspaceActivity || (async (workspaceId, actorId, actionType, description, metadata, admin) => {
  const db = admin || getAdmin();
  const { error } = await db.from('activity_logs').insert({
    workspace_id: workspaceId,
    actor_id: actorId,
    action_type: actionType,
    description,
    metadata: metadata || {},
  });
  if (error) {
    console.error('Failed to log workspace activity:', error.message);
  }
  await db.from('workspaces').update({ last_activity_at: new Date().toISOString() }).eq('id', workspaceId);
});

const logAuditEvent = activityLib.logAuditEvent || (async (actorId, actionType, entityType, entityId, description, metadata, admin) => {
  const db = admin || getAdmin();
  await db.from('audit_logs').insert({
    actor_id: actorId,
    action_type: actionType,
    entity_type: entityType,
    entity_id: entityId,
    description,
    metadata: metadata || {},
  });
});

const getWorkspaceMembers = membersLib.getWorkspaceMembers || (async (workspaceId, admin) => {
  const db = admin || getAdmin();
  const { data, error } = await db
    .from('team_members')
    .select('id, role, joined_at, user_id, users(id, name, email, profile_slug)')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
});

const removeMember = membersLib.removeMember || (async (workspaceId, userId, actorId, admin) => {
  const db = admin || getAdmin();
  const { error } = await db
    .from('team_members')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  await logWorkspaceActivity(workspaceId, actorId, 'MEMBER_REMOVED', `Member ${userId} was removed from workspace.`, { removed_user_id: userId });
  return true;
});

const changeMemberRole = membersLib.changeMemberRole || (async (workspaceId, userId, newRole, actorId, admin) => {
  const db = admin || getAdmin();
  const { data, error } = await db
    .from('team_members')
    .update({ role: newRole })
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw new Error(error.message);
  await logWorkspaceActivity(workspaceId, actorId, 'MEMBER_ROLE_CHANGED', `Member ${userId} role changed to ${newRole}.`, { target_user_id: userId, new_role: newRole });
  return data;
});

const getWorkspaceProgress = progressLib.getWorkspaceProgress || (async (workspaceId, admin) => {
  const db = admin || getAdmin();
  const { data, error } = await db
    .from('workspace_progress')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
});

const upsertWorkspaceProgress = progressLib.upsertWorkspaceProgress || (async (workspaceId, updates, admin) => {
  const db = admin || getAdmin();
  const payload = Object.assign({}, updates, { updated_at: new Date().toISOString() });
  const { data, error } = await db
    .from('workspace_progress')
    .upsert(
      Object.assign({ workspace_id: workspaceId }, payload),
      { onConflict: 'workspace_id' }
    )
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
});

const calculateProgressFromMilestones = progressLib.calculateProgressFromMilestones || (async (workspaceId, admin) => {
  const db = admin || getAdmin();
  const { data: milestones, error } = await db
    .from('workspace_milestones')
    .select('status')
    .eq('workspace_id', workspaceId);
  if (error) throw new Error(error.message);
  if (!milestones || milestones.length === 0) return 0;
  const completed = milestones.filter((m) => m.status === 'completed').length;
  return Math.round((completed / milestones.length) * 100);
});

// GET /api/workspaces
router.get('/api/workspaces', authRequired, async (req, res) => {
  const admin = getAdmin();
  const user = req.user;

  const { data: profile } = await admin
    .from('users')
    .select('role, is_master')
    .eq('id', user.id)
    .single();

  const isAdmin = (profile && profile.role === 'admin') || (profile && profile.is_master);

  let workspaceIds = [];

  if (isAdmin) {
    const { data } = await admin
      .from('workspaces')
      .select('id')
      .order('last_activity_at', { ascending: false });

    workspaceIds = (data || []).map((r) => r.id).filter(Boolean);
  } else {
    const { data: memberRows } = await admin
      .from('team_members')
      .select('workspace_id')
      .eq('user_id', user.id)
      .not('workspace_id', 'is', null);

    workspaceIds = [...new Set((memberRows || []).map((r) => r.workspace_id).filter(Boolean))];

    const { data: mentorRows } = await admin
      .from('mentor_assignments')
      .select('teams!inner(id, workspaces!inner(id))')
      .eq('mentor_id', user.id)
      .eq('assignment_status', 'active');

    for (const row of mentorRows || []) {
      const wsId = row && row.teams && row.teams.workspaces && row.teams.workspaces.id;
      if (wsId) workspaceIds.push(wsId);
    }
  }

  const workspaceRows = [];
  if (workspaceIds.length > 0) {
    const { data } = await admin
      .from('workspaces')
      .select('*, teams(id, name, problem_id, problems(title, domain)), team_members(count)')
      .in('id', workspaceIds)
      .order('last_activity_at', { ascending: false });

    workspaceRows.push(...(data || []));
  }

  const enriched = await Promise.all(workspaceRows.map(async (ws) => {
    const { count: memberCount } = await admin
      .from('team_members')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', ws.id);

    return Object.assign({}, ws, {
      member_count: memberCount || 0,
    });
  }));

  return res.json({ workspaces: enriched });
});

// POST /api/workspaces/invites/accept
router.post('/api/workspaces/invites/accept', authRequired, async (req, res) => {
  const admin = getAdmin();
  const user = req.user;

  const { data: profile } = await req.supabase
    .from('users')
    .select('email')
    .eq('id', user.id)
    .single();

  if (!profile) return res.status(404).json({ error: 'User not found' });

  const payload = req.body || {};
  if (typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  let query = admin
    .from('workspace_invites')
    .select('*, workspaces(id, team_id, name)')
    .eq('status', 'pending')
    .eq('email', profile.email);

  if (payload.invite_code) {
    query = query.eq('id', payload.invite_code);
  } else if (payload.workspace_id) {
    query = query.eq('workspace_id', payload.workspace_id);
  } else {
    return res.status(422).json({ error: 'Provide invite_code or workspace_id' });
  }

  const { data: invites } = await query;

  if (!invites || invites.length === 0) {
    return res.status(404).json({ error: 'No pending invite found for your email.' });
  }

  const invite = invites[0];

  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    await admin.from('workspace_invites').update({ status: 'expired' }).eq('id', invite.id);
    return res.status(400).json({ error: 'Invite has expired.' });
  }

  const ws = invite.workspaces;
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  const { error: memberErr } = await admin
    .from('team_members')
    .insert({
      team_id: ws.team_id,
      workspace_id: ws.id,
      user_id: user.id,
      role: invite.role,
    });

  if (memberErr) {
    if (memberErr.code === '23505') {
      return res.status(400).json({ error: 'You are already a member of this workspace.' });
    }
    return res.status(400).json({ error: memberErr.message });
  }

  await admin.from('workspace_invites').update({ status: 'accepted' }).eq('id', invite.id);

  const { data: channel } = await admin
    .from('conversations')
    .select('id')
    .eq('workspace_id', ws.id)
    .eq('type', 'channel')
    .maybeSingle();

  if (channel) {
    await admin.from('conversation_members').upsert({
      conversation_id: channel.id,
      user_id: user.id,
    }, { onConflict: 'conversation_id, user_id' });
  }

  await logWorkspaceActivity(ws.id, user.id, 'MEMBER_JOINED', 'Member joined via workspace invite.', { invited_user_id: user.id });

  return res.json({ ok: true, workspace_id: ws.id, workspace_name: ws.name });
});

// GET /api/workspaces/:id
router.get('/api/workspaces/:id', authRequired, async (req, res) => {
  const id = req.params.id;
  const admin = getAdmin();
  const user = req.user;

  const role = await getWorkspaceRole(user.id, id, admin);
  if (!role) return res.status(403).json({ error: 'Forbidden' });

  const { data: workspace } = await admin
    .from('workspaces')
    .select('*, teams(id, name, problem_id, leader_id, status, invite_code, problems(id, title, domain, team_mode, milestones))')
    .eq('id', id)
    .single();

  if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

  const members = await getWorkspaceMembers(id, admin);
  const memberCount = members.length;

  const { data: mentors } = await admin
    .from('mentor_assignments')
    .select('assigned_at, assignment_status, mentor_id, users(id, name, email), mentor_profiles(*)')
    .eq('team_id', workspace.team_id)
    .eq('assignment_status', 'active');

  const { data: channels } = await admin
    .from('conversations')
    .select('id, name, type, description, is_private, created_at')
    .eq('workspace_id', id)
    .order('created_at', { ascending: true });

  const { data: milestones } = await admin
    .from('workspace_milestones')
    .select('*')
    .eq('workspace_id', id)
    .order('created_at', { ascending: true });

  const { data: announcements } = await admin
    .from('workspace_announcements')
    .select('*')
    .eq('workspace_id', id)
    .order('created_at', { ascending: false })
    .limit(10);

  const { data: recentActivity } = await admin
    .from('activity_logs')
    .select('*, users:actor_id(name)')
    .eq('workspace_id', id)
    .order('created_at', { ascending: false })
    .limit(10);

  const memberProgress = await admin
    .from('workspace_progress')
    .select('*')
    .eq('workspace_id', id)
    .maybeSingle()
    .then((r) => r.data);

  return res.json({
    workspace,
    members,
    member_count: memberCount,
    mentors: mentors || [],
    channels: channels || [],
    milestones: milestones || [],
    announcements: announcements || [],
    recent_activity: recentActivity || [],
    progress: memberProgress || null,
    current_user_role: role,
  });
});

// PATCH /api/workspaces/:id
router.patch('/api/workspaces/:id', authRequired, async (req, res) => {
  const id = req.params.id;
  const admin = getAdmin();
  const user = req.user;

  const hasPerm = await checkWorkspacePermission(user.id, id, 'workspace.update', admin);
  if (!hasPerm) return res.status(403).json({ error: 'Forbidden' });

  const payload = req.body || {};
  if (typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const allowed = ['name', 'description', 'status', 'visibility', 'max_members', 'max_mentors'];
  const updates = {};

  for (const key of allowed) {
    if (payload[key] !== undefined) {
      updates[key] = payload[key];
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  updates.updated_at = new Date().toISOString();

  const { data, error } = await admin
    .from('workspaces')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  await logWorkspaceActivity(id, user.id, 'WORKSPACE_UPDATED', 'Workspace settings were updated.', { updates });

  return res.json({ workspace: data });
});

// DELETE /api/workspaces/:id
router.delete('/api/workspaces/:id', authRequired, async (req, res) => {
  const id = req.params.id;
  const admin = getAdmin();
  const user = req.user;

  const hasPerm = await checkWorkspacePermission(user.id, id, 'workspace.delete', admin);
  if (!hasPerm) return res.status(403).json({ error: 'Forbidden' });

  await logAuditEvent(user.id, 'WORKSPACE_DISBANDED', 'workspace', id, 'Workspace was disbanded.', { workspace_id: id }, admin);

  const { error } = await admin
    .from('workspaces')
    .update({ status: 'disbanded', updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) return res.status(400).json({ error: error.message });

  return res.json({ ok: true });
});

// GET /api/workspaces/:id/activity
router.get('/api/workspaces/:id/activity', authRequired, async (req, res) => {
  const id = req.params.id;
  const admin = getAdmin();
  const user = req.user;

  const role = await getWorkspaceRole(user.id, id, admin);
  if (!role) return res.status(403).json({ error: 'Forbidden' });

  const limit = Math.min(parseInt(req.query.limit || '20', 10), 50);
  const offset = parseInt(req.query.offset || '0', 10);
  const actionType = req.query.action_type;

  let query = admin
    .from('activity_logs')
    .select('*, users:actor_id(name)', { count: 'exact' })
    .eq('workspace_id', id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (actionType) {
    query = query.eq('action_type', actionType);
  }

  const { data, error, count } = await query;

  if (error) return res.status(400).json({ error: error.message });

  return res.json({
    activity: data || [],
    total: count || 0,
    limit,
    offset,
  });
});

// GET /api/workspaces/:id/announcements
router.get('/api/workspaces/:id/announcements', authRequired, async (req, res) => {
  const id = req.params.id;
  const admin = getAdmin();
  const user = req.user;

  const canRead = await checkWorkspacePermission(user.id, id, 'workspace.read', admin);
  if (!canRead) return res.status(403).json({ error: 'Forbidden' });

  const { data, error } = await admin
    .from('workspace_announcements')
    .select('*, author:author_id(id, name, email)')
    .eq('workspace_id', id)
    .order('created_at', { ascending: false });

  if (error) return res.status(400).json({ error: error.message });

  const active = (data || []).filter((a) => !a.expires_at || new Date(a.expires_at) > new Date());

  return res.json({ announcements: active });
});

// POST /api/workspaces/:id/announcements
router.post('/api/workspaces/:id/announcements', authRequired, async (req, res) => {
  const id = req.params.id;
  const admin = getAdmin();
  const user = req.user;

  const canPost = await checkWorkspacePermission(user.id, id, 'workspace.post_announcement', admin);
  if (!canPost) return res.status(403).json({ error: 'Forbidden' });

  const payload = req.body || {};
  if (typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (!payload.title || !payload.title.trim() || !payload.content || !payload.content.trim()) {
    return res.status(422).json({ error: 'Title and content are required' });
  }

  const validTypes = ['general', 'poster', 'system', 'deadline'];
  const announcementType = payload.announcement_type && validTypes.includes(payload.announcement_type)
    ? payload.announcement_type
    : 'general';

  const { data, error } = await admin
    .from('workspace_announcements')
    .insert({
      workspace_id: id,
      author_id: user.id,
      title: payload.title.trim(),
      content: payload.content.trim(),
      announcement_type: announcementType,
      is_pinned: payload.is_pinned || false,
      expires_at: payload.expires_at || null,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  await logWorkspaceActivity(id, user.id, 'ANNOUNCEMENT_POSTED', `Announcement: "${data.title}"`, { announcement_id: data.id });

  return res.json({ announcement: data });
});

// DELETE /api/workspaces/:id/announcements/:announcementId
router.delete('/api/workspaces/:id/announcements/:announcementId', authRequired, async (req, res) => {
  const id = req.params.id;
  const announcementId = req.params.announcementId;
  const admin = getAdmin();
  const user = req.user;

  const canDelete = await checkWorkspacePermission(user.id, id, 'workspace.delete_announcement', admin);
  if (!canDelete) return res.status(403).json({ error: 'Forbidden' });

  const { data: announcement } = await admin
    .from('workspace_announcements')
    .select('title')
    .eq('id', announcementId)
    .eq('workspace_id', id)
    .single();

  if (!announcement) return res.status(404).json({ error: 'Announcement not found' });

  const { error } = await admin
    .from('workspace_announcements')
    .delete()
    .eq('id', announcementId);

  if (error) return res.status(400).json({ error: error.message });

  await logWorkspaceActivity(id, user.id, 'ANNOUNCEMENT_DELETED', `Announcement "${announcement.title}" removed.`, { announcement_id: announcementId });

  return res.json({ ok: true });
});

// GET /api/workspaces/:id/channels
router.get('/api/workspaces/:id/channels', authRequired, async (req, res) => {
  const id = req.params.id;
  const admin = getAdmin();
  const user = req.user;

  const canRead = await checkWorkspacePermission(user.id, id, 'workspace.read', admin);
  if (!canRead) return res.status(403).json({ error: 'Forbidden' });

  const { data, error } = await admin
    .from('conversations')
    .select('id, name, type, description, is_private, created_at')
    .eq('workspace_id', id)
    .order('created_at', { ascending: true });

  if (error) return res.status(400).json({ error: error.message });

  return res.json({ channels: data || [] });
});

// POST /api/workspaces/:id/channels
router.post('/api/workspaces/:id/channels', authRequired, async (req, res) => {
  const id = req.params.id;
  const admin = getAdmin();
  const user = req.user;

  const canCreate = await checkWorkspacePermission(user.id, id, 'workspace.create_channel', admin);
  if (!canCreate) return res.status(403).json({ error: 'Forbidden' });

  const payload = req.body || {};
  if (typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (!payload.name || !payload.name.trim()) {
    return res.status(422).json({ error: 'Channel name is required' });
  }

  const channelName = payload.name.trim().toLowerCase().replace(/\s+/g, '-');

  const { data, error } = await admin
    .from('conversations')
    .insert({
      workspace_id: id,
      type: 'channel',
      name: channelName,
      description: (payload.description && payload.description.trim()) || null,
      is_private: payload.is_private || false,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'A channel with this name already exists.' });
    }
    return res.status(400).json({ error: error.message });
  }

  const { data: workspace } = await admin
    .from('workspaces')
    .select('team_id')
    .eq('id', id)
    .single();

  if (workspace) {
    const { data: members } = await admin
      .from('team_members')
      .select('user_id')
      .eq('workspace_id', id);

    if (members) {
      const memberEntries = members.map((m) => ({
        conversation_id: data.id,
        user_id: m.user_id,
      }));

      try {
        await admin.from('conversation_members').insert(memberEntries);
      } catch (e) { /* Non-critical; members may already exist */ }
    }
  }

  await logWorkspaceActivity(id, user.id, 'CHANNEL_CREATED', `Channel "#${channelName}" created.`, { channel_id: data.id });

  return res.json({ channel: data });
});

// DELETE /api/workspaces/:id/channels/:channelId
router.delete('/api/workspaces/:id/channels/:channelId', authRequired, async (req, res) => {
  const id = req.params.id;
  const channelId = req.params.channelId;
  const admin = getAdmin();
  const user = req.user;

  const canDelete = await checkWorkspacePermission(user.id, id, 'workspace.delete_channel', admin);
  if (!canDelete) return res.status(403).json({ error: 'Forbidden' });

  const { data: channel } = await admin
    .from('conversations')
    .select('name')
    .eq('id', channelId)
    .eq('workspace_id', id)
    .single();

  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  if (channel.name === 'general') {
    return res.status(400).json({ error: 'The general channel cannot be deleted.' });
  }

  await logWorkspaceActivity(id, user.id, 'CHANNEL_DELETED', `Channel "#${channel.name}" deleted.`, { channel_id: channelId });

  const { error } = await admin
    .from('conversations')
    .delete()
    .eq('id', channelId)
    .eq('workspace_id', id);

  if (error) return res.status(400).json({ error: error.message });

  return res.json({ ok: true });
});

// GET /api/workspaces/:id/files
router.get('/api/workspaces/:id/files', authRequired, async (req, res) => {
  const id = req.params.id;
  const admin = getAdmin();
  const user = req.user;

  const role = await getWorkspaceRole(user.id, id, admin);
  if (!role) return res.status(403).json({ error: 'Forbidden' });

  const category = req.query.category;
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 50);
  const offset = parseInt(req.query.offset || '0', 10);

  let query = admin
    .from('workspace_files')
    .select('*, uploader:uploader_id(id, name, email)', { count: 'exact' })
    .eq('workspace_id', id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (category) {
    query = query.eq('category', category);
  }

  const { data, error, count } = await query;

  if (error) return res.status(400).json({ error: error.message });

  return res.json({
    files: data || [],
    total: count || 0,
    limit,
    offset,
  });
});

// POST /api/workspaces/:id/invites
router.post('/api/workspaces/:id/invites', authRequired, async (req, res) => {
  const id = req.params.id;
  const admin = getAdmin();
  const user = req.user;

  const canInvite = await checkWorkspacePermission(user.id, id, 'workspace.invite', admin);
  if (!canInvite) return res.status(403).json({ error: 'Forbidden' });

  const payload = req.body || {};
  if (typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (!payload.email || !payload.email.trim()) {
    return res.status(422).json({ error: 'Email is required' });
  }

  const inviteRole = payload.role === 'co_leader' ? 'co_leader' : 'member';

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  const { data, error } = await admin
    .from('workspace_invites')
    .insert({
      workspace_id: id,
      invited_by: user.id,
      email: payload.email.trim().toLowerCase(),
      role: inviteRole,
      expires_at: expiresAt.toISOString(),
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'An active invite already exists for this email.' });
    }
    return res.status(400).json({ error: error.message });
  }

  await logWorkspaceActivity(id, user.id, 'INVITE_SENT', `Invite sent to ${payload.email}.`, { invited_email: payload.email, role: inviteRole });

  return res.json({ invite: data });
});

// POST /api/workspaces/:id/leave
router.post('/api/workspaces/:id/leave', authRequired, async (req, res) => {
  const id = req.params.id;
  const admin = getAdmin();
  const user = req.user;

  const role = await getWorkspaceRole(user.id, id, admin);
  if (!role) return res.status(400).json({ error: 'Not a member of this workspace' });

  if (role === 'leader') {
    return res.status(400).json({ error: 'Leader cannot leave. Transfer leadership first.' });
  }

  try {
    await removeMember(id, user.id, user.id, admin);
    return res.json({ ok: true, message: 'You have left the workspace.' });
  } catch (err) {
    const message = (err instanceof Error) ? err.message : 'Failed to leave workspace';
    return res.status(400).json({ error: message });
  }
});

// GET /api/workspaces/:id/members
router.get('/api/workspaces/:id/members', authRequired, async (req, res) => {
  const id = req.params.id;
  const admin = getAdmin();
  const user = req.user;

  const role = await getWorkspaceRole(user.id, id, admin);
  if (!role) return res.status(403).json({ error: 'Forbidden' });

  const members = await getWorkspaceMembers(id, admin);

  return res.json({ members });
});

// PATCH /api/workspaces/:id/members/:userId
router.patch('/api/workspaces/:id/members/:userId', authRequired, async (req, res) => {
  const id = req.params.id;
  const userId = req.params.userId;
  const admin = getAdmin();
  const user = req.user;

  const hasPerm = await checkWorkspacePermission(user.id, id, 'workspace.manage_roles', admin);
  if (!hasPerm) return res.status(403).json({ error: 'Forbidden' });

  const payload = req.body || {};
  if (typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (!payload.role || !['leader', 'co_leader', 'member'].includes(payload.role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  try {
    const updated = await changeMemberRole(id, userId, payload.role, user.id, admin);
    return res.json({ member: updated });
  } catch (err) {
    const message = (err instanceof Error) ? err.message : 'Failed to update role';
    return res.status(400).json({ error: message });
  }
});

// DELETE /api/workspaces/:id/members/:userId
router.delete('/api/workspaces/:id/members/:userId', authRequired, async (req, res) => {
  const id = req.params.id;
  const userId = req.params.userId;
  const admin = getAdmin();
  const user = req.user;

  const isSelf = userId === user.id;
  const hasPerm = await checkWorkspacePermission(user.id, id, 'workspace.remove_member', admin);

  if (!isSelf && !hasPerm) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    await removeMember(id, userId, user.id, admin);
    return res.json({ ok: true });
  } catch (err) {
    const message = (err instanceof Error) ? err.message : 'Failed to remove member';
    return res.status(400).json({ error: message });
  }
});

// POST /api/workspaces/:id/mentors
router.post('/api/workspaces/:id/mentors', authRequired, async (req, res) => {
  const id = req.params.id;
  const admin = getAdmin();
  const user = req.user;

  const canAssign = await checkWorkspacePermission(user.id, id, 'workspace.assign_mentor', admin);
  if (!canAssign) return res.status(403).json({ error: 'Forbidden' });

  const payload = req.body || {};
  if (typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (!payload.mentor_id) {
    return res.status(422).json({ error: 'mentor_id is required' });
  }

  const { data: workspace } = await admin
    .from('workspaces')
    .select('*, teams(id, name)')
    .eq('id', id)
    .single();

  if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

  const { data: mentorProf } = await admin
    .from('mentor_profiles')
    .select('*')
    .eq('user_id', payload.mentor_id)
    .single();

  if (!mentorProf || mentorProf.availability_status === 'unavailable') {
    return res.status(400).json({ error: 'Mentor is not available.' });
  }

  const { count: currentAssignments } = await admin
    .from('mentor_assignments')
    .select('id', { count: 'exact', head: true })
    .eq('mentor_id', payload.mentor_id)
    .eq('assignment_status', 'active');

  if ((currentAssignments || 0) >= mentorProf.max_active_teams) {
    return res.status(400).json({ error: 'Mentor has reached maximum active team capacity.' });
  }

  const { data: assignment, error } = await admin
    .from('mentor_assignments')
    .upsert({
      team_id: workspace.team_id,
      mentor_id: payload.mentor_id,
      assigned_by: user.id,
    }, { onConflict: 'team_id, mentor_id' })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  const { data: channel } = await admin
    .from('conversations')
    .select('id')
    .eq('workspace_id', id)
    .eq('type', 'channel')
    .maybeSingle();

  if (channel) {
    await admin.from('conversation_members').upsert({
      conversation_id: channel.id,
      user_id: payload.mentor_id,
    }, { onConflict: 'conversation_id, user_id' });
  }

  await logWorkspaceActivity(id, user.id, 'MENTOR_ASSIGNED', `Mentor ${payload.mentor_id} assigned to workspace.`, { mentor_id: payload.mentor_id });

  await admin.from('notifications').insert({
    user_id: payload.mentor_id,
    event_type: 'MENTOR_ASSIGNED',
    title: 'Assigned to Workspace',
    body: `You have been assigned as mentor for "${workspace.name}".`,
    link_url: `/teams/${workspace.team_id}`,
    metadata: { workspace_id: id, team_id: workspace.team_id },
  });

  return res.json({ assignment });
});

// DELETE /api/workspaces/:id/mentors/:mentorId
router.delete('/api/workspaces/:id/mentors/:mentorId', authRequired, async (req, res) => {
  const id = req.params.id;
  const mentorId = req.params.mentorId;
  const admin = getAdmin();
  const user = req.user;

  const canRemove = await checkWorkspacePermission(user.id, id, 'workspace.remove_mentor', admin);
  if (!canRemove) return res.status(403).json({ error: 'Forbidden' });

  const { data: workspace } = await admin
    .from('workspaces')
    .select('team_id')
    .eq('id', id)
    .single();

  if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

  const { error: updateErr } = await admin
    .from('mentor_assignments')
    .update({
      assignment_status: 'ended',
      ended_at: new Date().toISOString(),
      ended_reason: 'removed_by_leader',
    })
    .eq('team_id', workspace.team_id)
    .eq('mentor_id', mentorId)
    .eq('assignment_status', 'active');

  if (updateErr) return res.status(400).json({ error: updateErr.message });

  await logWorkspaceActivity(id, user.id, 'MENTOR_REMOVED', `Mentor ${mentorId} removed from workspace.`, { mentor_id: mentorId });

  return res.json({ ok: true });
});

// GET /api/workspaces/:id/milestones
router.get('/api/workspaces/:id/milestones', authRequired, async (req, res) => {
  const id = req.params.id;
  const admin = getAdmin();
  const user = req.user;

  const canRead = await checkWorkspacePermission(user.id, id, 'workspace.read_milestones', admin);
  if (!canRead) return res.status(403).json({ error: 'Forbidden' });

  const { data, error } = await admin
    .from('workspace_milestones')
    .select('*, completed_by_user:completed_by(id, name, email), created_by_user:created_by(id, name, email)')
    .eq('workspace_id', id)
    .order('created_at', { ascending: true });

  if (error) return res.status(400).json({ error: error.message });

  return res.json({ milestones: data || [] });
});

// POST /api/workspaces/:id/milestones
router.post('/api/workspaces/:id/milestones', authRequired, async (req, res) => {
  const id = req.params.id;
  const admin = getAdmin();
  const user = req.user;

  const canCreate = await checkWorkspacePermission(user.id, id, 'workspace.create_milestone', admin);
  if (!canCreate) return res.status(403).json({ error: 'Forbidden' });

  const payload = req.body || {};
  if (typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (!payload.title || !payload.title.trim()) {
    return res.status(422).json({ error: 'Title is required' });
  }

  const { data, error } = await admin
    .from('workspace_milestones')
    .insert({
      workspace_id: id,
      title: payload.title.trim(),
      description: (payload.description && payload.description.trim()) || null,
      due_date: payload.due_date || null,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  await logWorkspaceActivity(id, user.id, 'MILESTONE_CREATED', `Milestone "${data.title}" created.`, { milestone_id: data.id });

  return res.json({ milestone: data });
});

// PATCH /api/workspaces/:id/milestones/:milestoneId
router.patch('/api/workspaces/:id/milestones/:milestoneId', authRequired, async (req, res) => {
  const id = req.params.id;
  const milestoneId = req.params.milestoneId;
  const admin = getAdmin();
  const user = req.user;

  const canUpdate = await checkWorkspacePermission(user.id, id, 'workspace.update_milestone', admin);
  if (!canUpdate) return res.status(403).json({ error: 'Forbidden' });

  const payload = req.body || {};
  if (typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const allowed = ['title', 'description', 'status', 'due_date'];
  const updates = {};

  for (const key of allowed) {
    if (payload[key] !== undefined) {
      updates[key] = payload[key];
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  if (updates.status === 'completed') {
    updates.completed_by = user.id;
    updates.completed_at = new Date().toISOString();
  }

  updates.updated_at = new Date().toISOString();

  const { data, error } = await admin
    .from('workspace_milestones')
    .update(updates)
    .eq('id', milestoneId)
    .eq('workspace_id', id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  await logWorkspaceActivity(id, user.id, 'MILESTONE_UPDATED', `Milestone "${data.title}" updated.`, { milestone_id: milestoneId, updates });

  const progress = await calculateProgressFromMilestones(id, admin);
  await upsertWorkspaceProgress(id, { progress_percentage: progress }, admin);

  return res.json({ milestone: data });
});

// DELETE /api/workspaces/:id/milestones/:milestoneId
router.delete('/api/workspaces/:id/milestones/:milestoneId', authRequired, async (req, res) => {
  const id = req.params.id;
  const milestoneId = req.params.milestoneId;
  const admin = getAdmin();
  const user = req.user;

  const canDelete = await checkWorkspacePermission(user.id, id, 'workspace.delete_milestone', admin);
  if (!canDelete) return res.status(403).json({ error: 'Forbidden' });

  const { data: milestone } = await admin
    .from('workspace_milestones')
    .select('title')
    .eq('id', milestoneId)
    .eq('workspace_id', id)
    .single();

  if (!milestone) return res.status(404).json({ error: 'Milestone not found' });

  const { error } = await admin
    .from('workspace_milestones')
    .delete()
    .eq('id', milestoneId)
    .eq('workspace_id', id);

  if (error) return res.status(400).json({ error: error.message });

  await logWorkspaceActivity(id, user.id, 'MILESTONE_DELETED', `Milestone "${milestone.title}" deleted.`, { milestone_id: milestoneId });

  const progress = await calculateProgressFromMilestones(id, admin);
  await upsertWorkspaceProgress(id, { progress_percentage: progress }, admin);

  return res.json({ ok: true });
});

// GET /api/workspaces/:id/progress
router.get('/api/workspaces/:id/progress', authRequired, async (req, res) => {
  const id = req.params.id;
  const admin = getAdmin();
  const user = req.user;

  const canRead = await checkWorkspacePermission(user.id, id, 'workspace.read', admin);
  if (!canRead) return res.status(403).json({ error: 'Forbidden' });

  try {
    const progress = await getWorkspaceProgress(id, admin);
    return res.json({ progress });
  } catch (err) {
    const message = (err instanceof Error) ? err.message : 'Failed to get progress';
    return res.status(400).json({ error: message });
  }
});

// PUT /api/workspaces/:id/progress
router.put('/api/workspaces/:id/progress', authRequired, async (req, res) => {
  const id = req.params.id;
  const admin = getAdmin();
  const user = req.user;

  const canManage = await checkWorkspacePermission(user.id, id, 'workspace.manage_progress', admin);
  if (!canManage) return res.status(403).json({ error: 'Forbidden' });

  const payload = req.body || {};
  if (typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const validStages = ['ideation', 'planning', 'development', 'testing', 'submission', 'reviewed'];
  if (payload.current_stage && !validStages.includes(payload.current_stage)) {
    return res.status(422).json({ error: `Invalid stage. Must be one of: ${validStages.join(', ')}` });
  }

  const updates = {};
  if (payload.current_stage) updates.current_stage = payload.current_stage;
  if (payload.reviewer_feedback !== undefined) updates.reviewer_feedback = payload.reviewer_feedback;
  if (payload.poster_feedback !== undefined) updates.poster_feedback = payload.poster_feedback;
  if (payload.progress_percentage !== undefined) updates.progress_percentage = payload.progress_percentage;

  try {
    const progress = await upsertWorkspaceProgress(id, updates, admin);
    await logWorkspaceActivity(id, user.id, 'PROGRESS_UPDATED', 'Workspace progress was updated.', { updates });
    return res.json({ progress });
  } catch (err) {
    const message = (err instanceof Error) ? err.message : 'Failed to update progress';
    return res.status(400).json({ error: message });
  }
});

// POST /api/workspaces/:id/transfer
router.post('/api/workspaces/:id/transfer', authRequired, async (req, res) => {
  const id = req.params.id;
  const admin = getAdmin();
  const user = req.user;

  const role = await getWorkspaceRole(user.id, id, admin);
  if (role !== 'leader') return res.status(403).json({ error: 'Only the leader can transfer ownership' });

  const payload = req.body || {};
  if (typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (!payload.new_leader_id) {
    return res.status(400).json({ error: 'new_leader_id is required' });
  }

  const targetRole = await getWorkspaceRole(payload.new_leader_id, id, admin);
  if (!targetRole) {
    return res.status(400).json({ error: 'Target user is not a member of this workspace' });
  }

  const { data: workspace } = await admin
    .from('workspaces')
    .select('team_id')
    .eq('id', id)
    .single();

  if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

  await admin.from('team_members')
    .update({ role: 'member' })
    .eq('workspace_id', id)
    .eq('user_id', user.id);

  await admin.from('team_members')
    .update({ role: 'leader' })
    .eq('workspace_id', id)
    .eq('user_id', payload.new_leader_id);

  await admin.from('teams')
    .update({ leader_id: payload.new_leader_id })
    .eq('id', workspace.team_id);

  await logWorkspaceActivity(id, user.id, 'LEADER_TRANSFERRED', `Leadership transferred to user ${payload.new_leader_id}.`, { new_leader_id: payload.new_leader_id, old_leader_id: user.id });

  return res.json({ ok: true, message: 'Leadership transferred successfully.' });
});

module.exports = router;
