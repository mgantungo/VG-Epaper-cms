'use strict';

/**
 * apps/cms/src/api/org-management/controllers/org-portal.js
 * NEW FILE — Phase 3. UPDATED: exportMembers (spreadsheet download of current members).
 *
 * HTTP layer for the Org Admin dashboard (web app /organisation) and for
 * invite acceptance. Reachable only with STRAPI_API_TOKEN, i.e. from the
 * middleware, which passes the signed-in reader's id in x-actor-user-id.
 * services/org-members.js resolves the organisation from that user's own
 * admin seat on every call, so an org id is never accepted from outside.
 */

const SERVICE = 'api::org-management.org-members';

function actorUserId(ctx) {
  const n = Number(ctx.request.headers['x-actor-user-id']);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = ({ strapi }) => {
  const svc = () => strapi.service(SERVICE);

  const handle = (label, fn, { needsActor = true } = {}) => async (ctx) => {
    try {
      if (needsActor && !actorUserId(ctx)) {
        ctx.status = 401;
        ctx.body = { error: 'Sign in required' };
        return;
      }
      ctx.body = await fn(ctx);
    } catch (err) {
      if (err && err.status && err.status < 500) {
        ctx.status = err.status;
        ctx.body = { error: err.message };
        return;
      }
      strapi.log.error(`[org-portal.${label}]`, err);
      ctx.status = 500;
      ctx.body = { error: err?.status === 500 && err.message ? err.message : 'Organisation service error' };
    }
  };

  const body = (ctx) => ctx.request.body || {};

  return {
    summary: handle('summary', (ctx) => svc().summary(actorUserId(ctx))),
    listMembers: handle('listMembers', (ctx) => svc().listMembers(actorUserId(ctx), ctx.query || {})),
    exportMembers: handle('exportMembers', (ctx) => svc().exportMembers(actorUserId(ctx))),
    addMember: handle('addMember', async (ctx) => {
      const out = await svc().addMember(actorUserId(ctx), body(ctx));
      ctx.status = 201;
      return out;
    }),
    grantAccess: handle('grantAccess', (ctx) => svc().grantAccess(actorUserId(ctx), ctx.params.seatId, body(ctx))),
    setStatus: handle('setStatus', (ctx) => svc().setStatus(actorUserId(ctx), ctx.params.seatId, body(ctx))),
    setRole: handle('setRole', (ctx) => svc().setRole(actorUserId(ctx), ctx.params.seatId, body(ctx))),
    removeMember: handle('removeMember', (ctx) => svc().removeMember(actorUserId(ctx), ctx.params.seatId, body(ctx))),
    resendInvite: handle('resendInvite', (ctx) => svc().resendInvite(actorUserId(ctx), ctx.params.seatId)),
    previewImport: handle('previewImport', (ctx) => svc().previewImport(actorUserId(ctx), body(ctx))),
    commitImport: handle('commitImport', (ctx) => svc().commitImport(actorUserId(ctx), ctx.params.importId)),
    listAudit: handle('listAudit', (ctx) => svc().listAudit(actorUserId(ctx), ctx.query || {})),

    inspectInvite: handle('inspectInvite', (ctx) => svc().inspectInvite(body(ctx).token), { needsActor: false }),
    acceptInvite: handle('acceptInvite', (ctx) => {
      const b = body(ctx);
      return svc().acceptInvite(b.token, b.password, b.displayName);
    }, { needsActor: false })
  };
};
