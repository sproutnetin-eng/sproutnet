'use strict';

const {
  getWorkspaceRole,
  checkWorkspacePermission,
  requireWorkspaceAccess,
  requireWorkspacePermission,
} = require('./permissions');

const {
  logWorkspaceActivity,
  logAuditEvent,
} = require('./activity');

const {
  addMember,
  removeMember,
  changeMemberRole,
  getWorkspaceMembers,
  getWorkspaceMemberCount,
} = require('./members');

const {
  getWorkspaceProgress,
  upsertWorkspaceProgress,
  calculateProgressFromMilestones,
} = require('./progress');

const {
  sendWorkspaceNotification,
  notifyWorkspaceMembers,
} = require('./notifications');

module.exports = {
  getWorkspaceRole,
  checkWorkspacePermission,
  requireWorkspaceAccess,
  requireWorkspacePermission,
  logWorkspaceActivity,
  logAuditEvent,
  addMember,
  removeMember,
  changeMemberRole,
  getWorkspaceMembers,
  getWorkspaceMemberCount,
  getWorkspaceProgress,
  upsertWorkspaceProgress,
  calculateProgressFromMilestones,
  sendWorkspaceNotification,
  notifyWorkspaceMembers,
};
