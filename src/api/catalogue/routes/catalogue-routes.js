'use strict';

/**
 * src/api/catalogue/routes/catalogue-routes.js                 NEW FILE
 *
 * No content type behind this API. None of these routes is auth:false:
 * they need STRAPI_API_TOKEN, which only the middleware holds. The
 * middleware decides who may call what (handle admins with
 * canManageOrganizations for the /catalogue/admin routes; signed-in or
 * anonymous readers for the rest).
 */

const H = 'catalogue-handle';
const P = 'catalogue-public';

module.exports = {
  routes: [
    { method: 'GET', path: '/catalogue/admin/publications', handler: `${H}.listPublications` },
    { method: 'POST', path: '/catalogue/admin/publications', handler: `${H}.createPublication` },
    { method: 'PATCH', path: '/catalogue/admin/publications/:id', handler: `${H}.updatePublication` },

    { method: 'GET', path: '/catalogue/admin/plans', handler: `${H}.listPlans` },
    { method: 'POST', path: '/catalogue/admin/plans', handler: `${H}.createPlan` },
    { method: 'POST', path: '/catalogue/admin/plans/split-suggestion', handler: `${H}.suggestSplit` },
    { method: 'PATCH', path: '/catalogue/admin/plans/:key', handler: `${H}.updatePlanDisplay` },
    { method: 'POST', path: '/catalogue/admin/plans/:key/versions', handler: `${H}.newPlanVersion` },
    { method: 'POST', path: '/catalogue/admin/plans/:key/stop', handler: `${H}.stopPlan` },
    { method: 'POST', path: '/catalogue/admin/plans/:key/resume', handler: `${H}.resumePlan` },

    { method: 'GET', path: '/catalogue/storefront', handler: `${P}.storefront` },
    { method: 'GET', path: '/catalogue/plans', handler: `${P}.currentPlans` },
    { method: 'GET', path: '/catalogue/access/:userId', handler: `${P}.accessProfile` }
  ]
};
