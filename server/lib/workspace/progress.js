'use strict';

function createAdminClient() {
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase admin credentials are not configured');
  return createClient(url, key);
}

async function getWorkspaceProgress(workspaceId, admin) {
  const db = admin || createAdminClient();

  const { data, error } = await db
    .from('workspace_progress')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  return data || null;
}

async function upsertWorkspaceProgress(workspaceId, updates, admin) {
  const db = admin || createAdminClient();

  const payload = { ...updates, updated_at: new Date().toISOString() };

  const { data, error } = await db
    .from('workspace_progress')
    .upsert(
      { workspace_id: workspaceId, ...payload },
      { onConflict: 'workspace_id' }
    )
    .select()
    .single();

  if (error) throw new Error(error.message);

  return data;
}

async function calculateProgressFromMilestones(workspaceId, admin) {
  const db = admin || createAdminClient();

  const { data: milestones, error } = await db
    .from('workspace_milestones')
    .select('status')
    .eq('workspace_id', workspaceId);

  if (error) throw new Error(error.message);

  if (!milestones || milestones.length === 0) return 0;

  const completed = milestones.filter((m) => m.status === 'completed').length;
  return Math.round((completed / milestones.length) * 100);
}

module.exports = {
  getWorkspaceProgress,
  upsertWorkspaceProgress,
  calculateProgressFromMilestones,
};
