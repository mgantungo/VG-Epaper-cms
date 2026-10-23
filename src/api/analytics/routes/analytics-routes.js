'use strict';

/**
 * src/api/analytics/routes/analytics-routes.js             NEW FILE (Phases 1–4)
 *
 * No content type behind this API (tables are created by the service).
 * None of these is auth:false: they need STRAPI_API_TOKEN, which only the
 * middleware holds. The middleware decides who may call what.
 */

const C = 'analytics';

module.exports = {
  routes: [
    { method: 'POST', path: '/analytics/ingest', handler: `${C}.ingest` },
    { method: 'POST', path: '/analytics/admin/rebuild', handler: `${C}.rebuild` },

    { method: 'GET', path: '/analytics/admin/overview', handler: `${C}.overview` },
    { method: 'GET', path: '/analytics/admin/curve', handler: `${C}.curve` },
    { method: 'GET', path: '/analytics/admin/sections', handler: `${C}.sections` },
    { method: 'GET', path: '/analytics/admin/readers', handler: `${C}.readers` },
    { method: 'GET', path: '/analytics/admin/readers/:userId', handler: `${C}.reader` },
    { method: 'GET', path: '/analytics/admin/revenue', handler: `${C}.revenue` },
    { method: 'GET', path: '/analytics/admin/orgs/:orgId/usage', handler: `${C}.orgUsage` },

    { method: 'GET', path: '/analytics/portal/usage', handler: `${C}.portalUsage` }
  ]
};
