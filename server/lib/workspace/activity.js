'use strict';

function createAdminClient() {
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase admin credentials are not configured');
  return createClient(url, key);
}

async function logWorkspaceActivity(workspaceId, actorId, actionType, description, metadata, admin) {
  if (metadata === undefined) metadata = {};
  const db = admin || createAdminClient();

  const { error } = await db.from('activity_logs').insert({
    workspace_id: workspaceId,
    actor_id: actorId,
    action_type: actionType,
    description,
    metadata,
  });

  if (error) {
    console.error('Failed to log workspace activity:', error.message);
  }

  await db.from('workspaces').update({ last_activity_at: new Date().toISOString() }).eq('id', workspaceId);
}

async function logAuditEvent(actorId, actionType, entityType, entityId, description, metadata, admin) {
  if (metadata === undefined) metadata = {};
  const db = admin || createAdminClient();

  await db.from('audit_logs').insert({
    actor_id: actorId,
    action_type: actionType,
    entity_type: entityType,
    entity_id: entityId,
    description,
    metadata,
  });
}

module.exports = {
  logWorkspaceActivity,
  logAuditEvent,
};
