'use strict';

function createAdminClient() {
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase admin credentials are not configured');
  return createClient(url, key);
}

async function sendWorkspaceNotification(userId, eventType, title, body, linkUrl, metadata, admin) {
  if (metadata === undefined) metadata = {};
  const db = admin || createAdminClient();

  const { error } = await db.from('notifications').insert({
    user_id: userId,
    event_type: eventType,
    title,
    body,
    link_url: linkUrl || null,
    metadata,
  });

  if (error) {
    console.error('Failed to send notification:', error.message);
  }
}

async function notifyWorkspaceMembers(workspaceId, eventType, title, body, linkUrl, excludeUserId, metadata, admin) {
  if (metadata === undefined) metadata = {};
  const db = admin || createAdminClient();

  const { data: members } = await db
    .from('team_members')
    .select('user_id')
    .eq('workspace_id', workspaceId);

  if (!members) return;

  const notifications = members
    .filter((m) => m.user_id !== excludeUserId)
    .map((m) => ({
      user_id: m.user_id,
      event_type: eventType,
      title,
      body,
      link_url: linkUrl || null,
      metadata: { ...metadata, workspace_id: workspaceId },
    }));

  if (notifications.length > 0) {
    const { error } = await db.from('notifications').insert(notifications);
    if (error) {
      console.error('Failed to notify workspace members:', error.message);
    }
  }
}

module.exports = {
  sendWorkspaceNotification,
  notifyWorkspaceMembers,
};
