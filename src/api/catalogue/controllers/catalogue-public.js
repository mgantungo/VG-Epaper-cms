'use strict';

/**
 * src/api/catalogue/controllers/catalogue-public.js            NEW FILE
 *
 * Read models for the reader web app, served through the middleware
 * (STRAPI_API_TOKEN; none of these routes is auth:false):
 *   storefront       landing page: publications, latest editions, featured plans
 *   currentPlans     plans on sale today, optionally for one publication (paywall)
 *   accessProfile    one reader's personal and organisation access, which the
 *                    middleware caches briefly and checks every page against
 */

const SERVICE = 'api::catalogue.catalogue-store';

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
      strapi.log.error(`[catalogue.${label}]`, err);
      ctx.status = 500;
      ctx.body = { error: 'Catalogue service error' };
    }
  };

  return {
    storefront: handle('storefront', () => svc().storefront()),
    currentPlans: handle('currentPlans', (ctx) => svc().currentPlans({ publication: ctx.query?.publication })),
    accessProfile: handle('accessProfile', (ctx) => svc().accessProfile(ctx.params.userId))
  };
};
