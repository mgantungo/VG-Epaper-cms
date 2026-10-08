'use strict';

/**
 * epaper-org-import router
 *
 * A restricted core router: no delete, since an import is audit history.
 * These routes are NOT public. Leave every permission for this type OFF
 * under Users & Permissions -> Public / Authenticated. Only the middleware
 * reaches them, using STRAPI_API_TOKEN, the same way it reaches everything
 * else in Strapi.
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::epaper-org-import.epaper-org-import', {
  only: ['find', 'findOne', 'create', 'update']
});