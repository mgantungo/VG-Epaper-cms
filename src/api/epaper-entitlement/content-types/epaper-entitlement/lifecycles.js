'use strict';

/**
 * apps/cms/src/api/epaper-entitlement/content-types/epaper-entitlement/lifecycles.js
 * Phase 1 file, UPDATED in Phase 2: anything paid through a transaction
 * that carries an organization counts as org_contract, even when it also
 * records the paying user.
 *
 * Derives `scope` when the caller doesn't send one, so every existing
 * creator (epaper-transaction's grantEntitlement) keeps working untouched:
 *   organization + transaction -> org_contract   (an org purchase; `user` is just the payer)
 *   organization + no user     -> org_contract
 *   organization + user        -> org_member
 *   anything else              -> personal
 * It also enforces coverageStart <= coverageEnd for every writer.
 *
 * Relations can arrive as a number, { id }, { connect: [...] } or
 * { set: [...] }; hasRelation() covers all of these.
 */

const SCOPES = ['personal', 'org_contract', 'org_member'];

function hasRelation(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'number' || typeof value === 'string') return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') {
    if (value.id || value.documentId) return true;
    if (Array.isArray(value.connect)) return value.connect.length > 0;
    if (Array.isArray(value.set)) return value.set.length > 0;
  }
  return false;
}

function checkDates(data) {
  if (data.coverageStart && data.coverageEnd) {
    if (String(data.coverageStart).slice(0, 10) > String(data.coverageEnd).slice(0, 10)) {
      throw new Error('epaper-entitlement: coverageStart must be on or before coverageEnd');
    }
  }
}

module.exports = {
  beforeCreate(event) {
    const data = event.params.data;
    if (!data) return;

    if (data.scope) {
      if (!SCOPES.includes(data.scope)) throw new Error(`epaper-entitlement: invalid scope "${data.scope}"`);
    } else {
      const hasOrg = hasRelation(data.organization);
      const hasUser = hasRelation(data.user);
      const hasTxn = hasRelation(data.transaction);
      data.scope = hasOrg ? (hasTxn || !hasUser ? 'org_contract' : 'org_member') : 'personal';
    }

    if (!data.grantSource && hasRelation(data.transaction)) data.grantSource = 'purchase';

    checkDates(data);
  },

  beforeUpdate(event) {
    const data = event.params.data;
    if (!data) return;
    if (data.scope && !SCOPES.includes(data.scope)) {
      throw new Error(`epaper-entitlement: invalid scope "${data.scope}"`);
    }
    // Only checked when both dates are in this update. Single-field
    // extensions are validated in the org-management service (Phase 2).
    checkDates(data);
  }
};