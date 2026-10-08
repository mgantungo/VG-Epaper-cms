'use strict';

/**
 * epaper-org-import controller — bare factory. Only the middleware (STRAPI_API_TOKEN) calls
 * this; the org-management logic that writes these rows arrives in Phase 2.
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::epaper-org-import.epaper-org-import');