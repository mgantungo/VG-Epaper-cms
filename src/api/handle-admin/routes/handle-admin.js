'use strict';

/**
 * apps/cms/src/api/handle-admin/routes/handle-admin.js
 *
 * Deliberately NOT createCoreRouter(UID) — that would expose default
 * find/findOne/create/update/delete on api::handle-admin publicly, which
 * would let anyone list every admin's email or (worse) attempt writes
 * against a collection holding token hashes. Only the two actual login
 * actions are public; provisioning a new admin happens through Strapi's
 * own admin panel (an authenticated Strapi-admin session), never this
 * REST API.
 */

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/handle-admins/request-token',
      handler: 'handle-admin.requestToken',
      config: { auth: false }
    },
    {
      method: 'POST',
      path: '/handle-admins/verify-token',
      handler: 'handle-admin.verifyToken',
      config: { auth: false }
    }
  ]
};