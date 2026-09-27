'use strict';

/**
 * handle-admin service — bare factory. All the real logic lives in the
 * controller (requestToken/verifyToken) since it's tightly coupled to
 * HTTP request/response shaping; nothing here needs its own service-layer
 * method yet.
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::handle-admin.handle-admin');