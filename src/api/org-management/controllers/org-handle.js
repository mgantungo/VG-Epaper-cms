'use strict';

/**
 * apps/cms/src/api/org-management/controllers/org-handle.js
 * NEW FILE — Phase 2
 *
 * Thin HTTP layer over services/org-store.js. Every route is
 * authenticated (no auth:false; see routes/org-management-routes.js), so
 * only the middleware, holding STRAPI_API_TOKEN, reaches these. The
 * middleware has already verified the handle admin's JWT and their
 * canManageOrganizations right before forwarding, and passes the admin's
 * id in x-actor-admin-id for attribution in the audit log.
 *
 * File is deliberately NOT named org-management.js: the controller,
 * service and route files would otherwise share a name, which caused the
 * Phase 1 download mix-up.
 */

const SERVICE = 'api::org-management.org-store';

function actorAdminId(ctx) {
  const n = Number(ctx.request.headers['x-actor-admin-id']);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = ({ strapi }) => {
  const svc = () => strapi.service(SERVICE);

  // Maps OrgError (has .status) to that status; anything else is a real
  // fault, so it's logged and returned as a plain 500.
  const handle = (label, fn) => async (ctx) => {
    try {
      ctx.body = await fn(ctx);
    } catch (err) {
      if (err && err.status && err.status < 500) {
        ctx.status = err.status;
        ctx.body = { error: err.message };
        return;
      }
      strapi.log.error(`[org-management.${label}]`, err);
      ctx.status = 500;
      ctx.body = { error: 'Organisation service error' };
    }
  };

  return {
    handleAdminRights: handle('handleAdminRights', (ctx) => svc().handleAdminRights(ctx.params.adminId)),

    listOrgs: handle('listOrgs', (ctx) => svc().listOrgs(ctx.query || {})),
    getOrg: handle('getOrg', (ctx) => svc().getOrg(ctx.params.id)),
    createOrg: handle('createOrg', async (ctx) => {
      ctx.status = 201;
      return svc().createOrg(ctx.request.body || {}, actorAdminId(ctx));
    }),
    updateOrg: handle('updateOrg', (ctx) => svc().updateOrg(ctx.params.id, ctx.request.body || {}, actorAdminId(ctx))),
    setOrgStatus: handle('setOrgStatus', (ctx) => svc().setOrgStatus(ctx.params.id, ctx.request.body || {}, actorAdminId(ctx))),

    addContract: handle('addContract', (ctx) => svc().addContract(ctx.params.id, ctx.request.body || {}, actorAdminId(ctx))),
    updateContract: handle('updateContract', (ctx) =>
      svc().updateContract(ctx.params.id, ctx.params.contractId, ctx.request.body || {}, actorAdminId(ctx))),
    revokeContract: handle('revokeContract', (ctx) =>
      svc().revokeContract(ctx.params.id, ctx.params.contractId, ctx.request.body || {}, actorAdminId(ctx))),

    assignAdmin: handle('assignAdmin', (ctx) => svc().assignAdmin(ctx.params.id, ctx.request.body || {}, actorAdminId(ctx))),
    removeAdmin: handle('removeAdmin', (ctx) => svc().removeAdmin(ctx.params.id, ctx.params.seatId, actorAdminId(ctx))),

    listMembers: handle('listMembers', (ctx) => svc().listMembers(ctx.params.id, ctx.query || {})),
    setMemberStatus: handle('setMemberStatus', (ctx) =>
      svc().setMemberStatus(ctx.params.id, ctx.params.seatId, ctx.request.body || {}, actorAdminId(ctx))),

    listAudit: handle('listAudit', (ctx) => svc().listAudit(ctx.params.id, ctx.query || {}))
  };
};