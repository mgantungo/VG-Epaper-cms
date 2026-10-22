'use strict';

/**
 * epaper-plan router — read-only (find, findOne).            MODIFIED (Phase 0)
 *
 * Plans are created and re-priced only through /api/catalogue/admin/plans
 * (handle > Publications > Plans and prices), which keeps every sold price
 * as its own version. Writing plans through these core routes would bypass
 * that, so create/update/delete are not exposed.
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::epaper-plan.epaper-plan', {
  only: ['find', 'findOne']
});
