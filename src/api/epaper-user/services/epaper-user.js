'use strict';

/**
 * src/api/epaper-user/services/epaper-user.js
 *
 * This is deliberately the ONLY place in the entire system that handles a
 * plaintext password or a password hash. The controller calls into this
 * for register/verifyCredentials; nothing else — not the middleware, not
 * any other Strapi content-type — ever sees a hash. bcryptjs (pure JS, no
 * native compilation) rather than bcrypt, matching this project's earlier
 * experience with native-dependency install failures on this exact server.
 */

const { createCoreService } = require('@strapi/strapi').factories;
const bcrypt = require('bcryptjs');

const UID = 'api::epaper-user.epaper-user';
const SALT_ROUNDS = 12;

async function hashPassword(plaintext) {
	return bcrypt.hash(plaintext, SALT_ROUNDS);
}

async function verifyPassword(plaintext, hash) {
	return bcrypt.compare(plaintext, hash);
}

/** The only shape of a user that's ever allowed to leave this content-type
 * — no passwordHash, no tokenVersion (that's an internal revocation
 * counter, not something callers need to see). */
function toPublicProfile(user) {
	if (!user) return null;
	return {
		id: user.id,
		email: user.email,
		displayName: user.displayName || '',
		phone: user.phone || ''
	};
}

module.exports = createCoreService(UID, () => ({
	hashPassword,
	verifyPassword,
	toPublicProfile
}));
