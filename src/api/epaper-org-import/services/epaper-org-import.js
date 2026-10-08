'use strict';

/**
 * epaper-org-import service — bare factory.
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::epaper-org-import.epaper-org-import');