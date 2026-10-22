'use strict';

/**
 * src/api/catalogue/controllers/catalogue-handle.js            NEW FILE
 *
 * Publications and plans for handle admins. Reachable only with
 * STRAPI_API_TOKEN, i.e. from the middleware, which has already checked
 * the admin's session and canManageOrganizations right and passes the
 * admin's id in x-actor-admin-id (same arrangement as org-handle.js).
 */

const SERVICE = 'api::catalogue.catalogue-store';

function actorAdminId(ctx) {
  const n = Number(ctx.request.headers['x-actor-admin-id']);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = ({ strapi }) => {
  const svc = () => strapi.service(SERVICE);
  const body = (ctx) => ctx.request.body || {};

  const handle = (label, fn) => async (ctx) => {
    try {
      ctx.body = await fn(ctx);
    } catch (err) {
      if (err && err.status && err.status < 500) {
        ctx.status = err.status;
        ctx.body = { error: err.message };
        return;
      }
      strapi.log.error(`[catalogue.${label}]`, err);
      ctx.status = 500;
      ctx.body = { error: 'Catalogue service error' };
    }
  };

  return {
    listPublications: handle('listPublications', () => svc().listPublications({ includeInactive: true })),
    createPublication: handle('createPublication', async (ctx) => {
      const out = await svc().createPublication(body(ctx), actorAdminId(ctx));
      ctx.status = 201;
      return out;
    }),
    updatePublication: handle('updatePublication', (ctx) => svc().updatePublication(ctx.params.id, body(ctx), actorAdminId(ctx))),

    listPlans: handle('listPlans', () => svc().listPlans()),
    createPlan: handle('createPlan', async (ctx) => {
      const out = await svc().createPlan(body(ctx), actorAdminId(ctx));
      ctx.status = 201;
      return out;
    }),
    updatePlanDisplay: handle('updatePlanDisplay', (ctx) => svc().updatePlanDisplay(ctx.params.key, body(ctx), actorAdminId(ctx))),
    newPlanVersion: handle('newPlanVersion', (ctx) => svc().newPlanVersion(ctx.params.key, body(ctx), actorAdminId(ctx))),
    stopPlan: handle('stopPlan', (ctx) => svc().setPlanOnSale(ctx.params.key, false, actorAdminId(ctx))),
    resumePlan: handle('resumePlan', (ctx) => svc().setPlanOnSale(ctx.params.key, true, actorAdminId(ctx))),

    suggestSplit: handle('suggestSplit', async (ctx) => {
      const codes = Array.isArray(body(ctx).publications) ? body(ctx).publications : [];
      return { revenueSplit: await svc().suggestSplit(codes) };
    })
  };
};
