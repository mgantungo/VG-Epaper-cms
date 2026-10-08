'use strict';

/**
 * apps/cms/src/api/epaper-org-seat/content-types/epaper-org-seat/lifecycles.js
 * NEW FILE
 *
 * Same status <-> active sync as epaper-organization. Existing middleware
 * looks seats up by `active: true`, and that keeps working unchanged.
 */

const STATUSES = ['active', 'suspended'];
const ROLES = ['member', 'admin'];

function sync(data, { isCreate }) {
  if (!data) return;

  if (data.status !== undefined && data.status !== null) {
    if (!STATUSES.includes(data.status)) {
      throw new Error(`epaper-org-seat: invalid status "${data.status}"`);
    }
    data.active = data.status === 'active';
  } else if (data.active !== undefined && data.active !== null) {
    data.status = data.active ? 'active' : 'suspended';
  } else if (isCreate) {
    data.status = 'active';
    data.active = true;
  }

  if (data.role !== undefined && data.role !== null && !ROLES.includes(data.role)) {
    throw new Error(`epaper-org-seat: invalid role "${data.role}"`);
  }

  if (data.status === 'suspended') {
    if (!data.suspendedAt) data.suspendedAt = new Date();
  } else if (data.status === 'active') {
    data.suspendedAt = null;
    data.suspendedReason = null;
  }

  if (isCreate) {
    if (!data.assignedAt) data.assignedAt = new Date();
    if (!data.role) data.role = 'member';
    if (!data.source) data.source = 'manual';
  }
}

module.exports = {
  beforeCreate(event) {
    sync(event.params.data, { isCreate: true });
  },
  beforeUpdate(event) {
    sync(event.params.data, { isCreate: false });
  }
};