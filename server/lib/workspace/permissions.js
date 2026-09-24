'use strict';

function createAdminClient() {
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase admin credentials are not configured');
  return createClient(url, key);
}

async function getWorkspaceRole(userId, workspaceId, admin) {
  const db = admin || createAdminClient();

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

  if (user?.role === 'admin' || user?.is_master) return 'admin';

  return null;
}

async function checkWorkspacePermission(userId, workspaceId, permission, admin) {
  const db = admin || createAdminClient();

  const role = await getWorkspaceRole(userId, workspaceId, db);
  if (!role) return false;

  const { data: user } = await db
    .from('users')
    .select('role, is_master')
    .eq('id', userId)
    .single();

  if (user?.role === 'admin' || user?.is_master) return true;

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
}

async function requireWorkspaceAccess(userId, workspaceId, admin) {
  const role = await getWorkspaceRole(userId, workspaceId, admin);
  return role;
}

async function requireWorkspacePermission(userId, workspaceId, permission, admin) {
  return checkWorkspacePermission(userId, workspaceId, permission, admin);
}

module.exports = {
  getWorkspaceRole,
  checkWorkspacePermission,
  requireWorkspaceAccess,
  requireWorkspacePermission,
};
