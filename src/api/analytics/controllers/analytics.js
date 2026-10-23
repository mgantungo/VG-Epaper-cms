'use strict';

/**
 * src/api/analytics/controllers/analytics.js               NEW FILE (Phases 1–4)
 *
 * Reachable only with STRAPI_API_TOKEN, i.e. from the middleware:
 *  - ingest: the middleware's event batches
 *  - admin*: handle admins; the middleware has checked canManageOrganizations
 *  - portalUsage: an Org Admin; the middleware passes the signed-in reader in
 *    x-actor-user-id and the organisation is resolved from their own admin
 *    seat (never accepted from outside). Days and publications only.
 */

const SERVICE = 'api::analytics.analytics-store';

function actorUserId(ctx) {
  const n = Number(ctx.request.headers['x-actor-user-id']);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = ({ strapi }) => {
  const svc = () => strapi.service(SERVICE);

  const handle = (label, fn) => async (ctx) => {
    try {
      ctx.body = await fn(ctx);
    } catch (err) {
      if (err && err.status && err.status < 500) {
        ctx.status = err.status;
        ctx.body = { error: err.message };
        return;
      }
      strapi.log.error(`[analytics.${label}]`, err);
      ctx.status = 500;
      ctx.body = { error: 'Analytics service error' };
    }
  };

  return {
    ingest: handle('ingest', (ctx) => svc().ingest((ctx.request.body || {}).events)),
    rebuild: handle('rebuild', (ctx) => svc().rebuild({ ...(ctx.request.body || {}) })),

    overview: handle('overview', (ctx) => svc().overview(ctx.query || {})),
    curve: handle('curve', (ctx) => svc().curve(ctx.query || {})),
    sections: handle('sections', (ctx) => svc().sections(ctx.query || {})),
    readers: handle('readers', (ctx) => svc().readers(ctx.query || {})),
    reader: handle('reader', (ctx) => svc().reader(ctx.params.userId, ctx.query || {})),
    revenue: handle('revenue', (ctx) => svc().revenue(ctx.query || {})),

    orgUsage: handle('orgUsage', async (ctx) => {
      const id = Number(ctx.params.orgId);
      const org = Number.isInteger(id) && id > 0
        ? await strapi.db.query('api::epaper-organization.epaper-organization').findOne({ where: { id }, select: ['id', 'name'] })
        : null;
      if (!org) {
        ctx.status = 404;
        return { error: 'Organisation not found' };
      }
      return svc().orgUsage(org, ctx.query?.month, { withUserIds: true });
    }),

    portalUsage: handle('portalUsage', async (ctx) => {
      const userId = actorUserId(ctx);
      if (!userId) {
        ctx.status = 401;
        return { error: 'Sign in required' };
      }
      // Same gate as every other Org Admin screen: own admin seat, active, organisation active.
      const c = await strapi.service('api::org-management.org-members').context(userId);
      return svc().orgUsage({ id: c.orgId, name: c.org.name }, ctx.query?.month, { withUserIds: false });
    })
  };
};
