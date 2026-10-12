'use strict';

/**
 * Custom route. The `01-` prefix makes Strapi load it before the core router,
 * so /stories/search is not captured by /stories/:id.
 */

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/stories/search',
      handler: 'story-search.search',
      config: {
        auth:false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};