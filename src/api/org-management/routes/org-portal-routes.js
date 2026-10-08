'use strict';

/**
 * apps/cms/src/api/org-management/routes/org-portal-routes.js
 * NEW FILE — Phase 3. UPDATED: members/export.
 *
 * Org Admin dashboard + invite acceptance. Like org-management-routes.js,
 * none of these is auth:false: only the middleware (STRAPI_API_TOKEN)
 * can call them.
 */

const C = 'org-portal';

module.exports = {
  routes: [
    { method: 'GET', path: '/org-management/portal/summary', handler: `${C}.summary` },
    { method: 'GET', path: '/org-management/portal/members', handler: `${C}.listMembers` },
    { method: 'GET', path: '/org-management/portal/members/export', handler: `${C}.exportMembers` },
    { method: 'POST', path: '/org-management/portal/members', handler: `${C}.addMember` },
    { method: 'POST', path: '/org-management/portal/members/:seatId/access', handler: `${C}.grantAccess` },
    { method: 'POST', path: '/org-management/portal/members/:seatId/status', handler: `${C}.setStatus` },
    { method: 'POST', path: '/org-management/portal/members/:seatId/role', handler: `${C}.setRole` },
    { method: 'POST', path: '/org-management/portal/members/:seatId/remove', handler: `${C}.removeMember` },
    { method: 'POST', path: '/org-management/portal/members/:seatId/resend-invite', handler: `${C}.resendInvite` },
    { method: 'POST', path: '/org-management/portal/imports', handler: `${C}.previewImport` },
    { method: 'POST', path: '/org-management/portal/imports/:importId/commit', handler: `${C}.commitImport` },
    { method: 'GET', path: '/org-management/portal/audit', handler: `${C}.listAudit` },

    { method: 'POST', path: '/org-management/invites/inspect', handler: `${C}.inspectInvite` },
    { method: 'POST', path: '/org-management/invites/accept', handler: `${C}.acceptInvite` }
  ]
};
