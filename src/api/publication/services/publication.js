'use strict';

/**
 * publication service — core service only. Catalogue rules (plans,
 * versions, revenue split, storefront) live in src/api/catalogue.
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::publication.publication');
