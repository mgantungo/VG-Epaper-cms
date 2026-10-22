'use strict';

/**
 * publication router — read-only core routes (find, findOne). Writes go
 * through /api/catalogue/publications so they are validated and audited
 * in one place.
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::publication.publication', {
  only: ['find', 'findOne']
});
