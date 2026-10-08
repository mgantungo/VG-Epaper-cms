'use strict';

/**
 * apps/cms/src/api/epaper-organization/content-types/epaper-organization/lifecycles.js
 * NEW FILE
 *
 * `status` (active | suspended | archived) is the source of truth from now
 * on. `active` is kept in sync because existing middleware code
 * (getActiveOrgSeat / getOrgEntitlement in strapiClient.js) may still read it.
 *
 * Either field can be written:
 *   - new code writes `status`, and `active` follows
 *   - old code, or someone toggling the switch in Strapi admin, writes
 *     `active`, and `status` follows (false -> suspended, true -> active)
 * When both are sent, `status` wins.
 *
 * These are db-layer lifecycles, so they fire for strapi.db.query(...),
 * which is how this project does all its writes.
 */

const VALID = ['active', 'suspended', 'archived'];

function sync(data, { isCreate }) {
  if (!data) return;

  if (data.status !== undefined && data.status !== null) {
    if (!VALID.includes(data.status)) {
      throw new Error(`epaper-organization: invalid status "${data.status}"`);
    }
    data.active = data.status === 'active';
  } else if (data.active !== undefined && data.active !== null) {
    data.status = data.active ? 'active' : 'suspended';
  } else if (isCreate) {
    data.status = 'active';
    data.active = true;
  }

  if (data.status === 'suspended' || data.status === 'archived') {
    if (!data.suspendedAt) data.suspendedAt = new Date();
  } else if (data.status === 'active') {
    // Reactivation clears the suspension marker. The reason is kept in
    // epaper-org-audit, not on the record.
    data.suspendedAt = null;
    data.suspendedReason = null;
  }

  if (data.seatLimit !== undefined && data.seatLimit !== null && Number(data.seatLimit) < 0) {
    throw new Error('epaper-organization: seatLimit cannot be negative');
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