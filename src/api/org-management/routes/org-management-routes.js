'use strict';

/**
 * apps/cms/src/api/org-management/routes/org-management-routes.js
 * NEW FILE — Phase 2. UPDATED: members/export and imports.
 *
 * There is no content type behind this API, only a controller (org-handle)
 * and a service (org-store). None of these routes is auth:false. They need
 * a valid Strapi API token, which only the middleware holds, the same
 * arrangement as epaper-user's routes.
 */

const C = 'org-handle';

module.exports = {
  routes: [
    { method: 'GET', path: '/org-management/handle-admins/:adminId/rights', handler: `${C}.handleAdminRights` },

    { method: 'GET', path: '/org-management/orgs', handler: `${C}.listOrgs` },
    { method: 'POST', path: '/org-management/orgs', handler: `${C}.createOrg` },
    { method: 'GET', path: '/org-management/orgs/:id', handler: `${C}.getOrg` },
    { method: 'PATCH', path: '/org-management/orgs/:id', handler: `${C}.updateOrg` },
    { method: 'POST', path: '/org-management/orgs/:id/status', handler: `${C}.setOrgStatus` },

    { method: 'POST', path: '/org-management/orgs/:id/contracts', handler: `${C}.addContract` },
    { method: 'PATCH', path: '/org-management/orgs/:id/contracts/:contractId', handler: `${C}.updateContract` },
    { method: 'POST', path: '/org-management/orgs/:id/contracts/:contractId/revoke', handler: `${C}.revokeContract` },

    { method: 'POST', path: '/org-management/orgs/:id/admins', handler: `${C}.assignAdmin` },
    { method: 'DELETE', path: '/org-management/orgs/:id/admins/:seatId', handler: `${C}.removeAdmin` },

    { method: 'GET', path: '/org-management/orgs/:id/members', handler: `${C}.listMembers` },
    { method: 'POST', path: '/org-management/orgs/:id/members/:seatId/status', handler: `${C}.setMemberStatus` },
    { method: 'POST', path: '/org-management/orgs/:id/members/:seatId/publications', handler: `${C}.setMemberPublications` },

    { method: 'GET', path: '/org-management/orgs/:id/audit', handler: `${C}.listAudit` },

    { method: 'GET', path: '/org-management/orgs/:id/members/export', handler: `${C}.exportMembers` },
    { method: 'POST', path: '/org-management/orgs/:id/imports', handler: `${C}.previewImport` },
    { method: 'POST', path: '/org-management/orgs/:id/imports/:importId/commit', handler: `${C}.commitImport` }
  ]
};
