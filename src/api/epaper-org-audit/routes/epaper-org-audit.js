'use strict';

/**
 * epaper-org-audit router
 *
 * Append-only: find, findOne and create only. There is no update or delete
 * route at all, so an Org Admin (or a compromised middleware token holder
 * going through REST) can't rewrite history. Same rule as epaper-org-import:
 * keep every Public / Authenticated permission for this type OFF.
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::epaper-org-audit.epaper-org-audit', {
  only: ['find', 'findOne', 'create']
});