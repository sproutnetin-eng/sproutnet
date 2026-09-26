'use strict';

function createAdminClient() {
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase admin credentials are not configured');
  return createClient(url, key);
}

const { logWorkspaceActivity } = require('./activity');

async function addMember(workspaceId, teamId, userId, role, admin) {
  if (role === undefined) role = 'member';
  const db = admin || createAdminClient();

  const { data, error } = await db
    .from('team_members')
    .insert({
      team_id: teamId,
      workspace_id: workspaceId,
      user_id: userId,
      role,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  return data;
}

async function removeMember(workspaceId, userId, actorId, admin) {
  const db = admin || createAdminClient();

  const { error } = await db
    .from('team_members')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId);

  if (error) throw new Error(error.message);

  await logWorkspaceActivity(workspaceId, actorId, 'MEMBER_REMOVED', `Member ${userId} was removed from workspace.`, { removed_user_id: userId });

  return true;
}

async function changeMemberRole(workspaceId, userId, newRole, actorId, admin) {
  const db = admin || createAdminClient();

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
}

async function getWorkspaceMembers(workspaceId, admin) {
  const db = admin || createAdminClient();

  const { data, error } = await db
    .from('team_members')
    .select('id, role, joined_at, user_id, users(id, name, email, profile_slug)')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(error.message);

  return data || [];
}

async function getWorkspaceMemberCount(workspaceId, admin) {
  const db = admin || createAdminClient();

  const { count } = await db
    .from('team_members')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId);

  return count || 0;
}

module.exports = {
  addMember,
  removeMember,
  changeMemberRole,
  getWorkspaceMembers,
  getWorkspaceMemberCount,
};
