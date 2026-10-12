'use strict';

/**
 * story-search controller  (uid: api::story.story-search)
 *
 * Thin HTTP layer: reads the JSON request body and delegates to the service.
 * Validation errors thrown by the service (ValidationError) are turned into 400 responses by Strapi.
 *
 * Expected body:
 * {
 *   "query": "president opens new hospital in Mbarara", // required, min 5 words
 *   "startDate": "2026-09-01",                        // optional, yyyy-mm-dd
 *   "endDate": "2026-09-30",                          // optional, yyyy-mm-dd (inclusive)
 *   "page": 1,                                        // optional
 *   "pageSize": 10                                    // optional, max 50
 * }
 */

const { errors } = require('@strapi/utils');

module.exports = ({ strapi }) => ({
  async search(ctx) {
    const body = ctx.request.body;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new errors.ValidationError('Request body must be a JSON object');
    }

    const { query, startDate, endDate, page, pageSize } = body;

    ctx.body = await strapi
      .service('api::story.story-search')
      .search({ query, startDate, endDate, page, pageSize });
  },
});