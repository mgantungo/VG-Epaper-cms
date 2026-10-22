'use strict';

/**
 * publication controller — core controller only. Publications are written
 * through the catalogue API (src/api/catalogue), which handle reaches via
 * the middleware; the core routes below are read-only.
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::publication.publication');
