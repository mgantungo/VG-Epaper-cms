'use strict';

/**
 * src/api/epaper-user/controllers/epaper-user.js
 *
 * Four actions, all meant to be called by the middleware (using its
 * STRAPI_API_TOKEN), never by a browser directly — see routes/epaper-user.js
 * for why these are NOT auth:false, unlike epaper-transaction's routes.
 *
 *   - register:          create a new identity, hashed password never returned
 *   - verifyCredentials: the ONLY place a login attempt is checked — returns
 *                         a yes/no + public profile + tokenVersion, never the hash
 *   - getProfile:        re-fetch current state by id (used during token
 *                         refresh, to check the account's still active and
 *                         the token hasn't been revoked)
 *   - bumpTokenVersion:  invalidates every outstanding refresh token for a
 *                         user at once — real logout, and logout-everywhere
 *
 * All DB access via strapi.db.query(...), consistent with the rest of this
 * project's Strapi-version-independence rule.
 */

const { createCoreController } = require('@strapi/strapi').factories;

const UID = 'api::epaper-user.epaper-user';

module.exports = createCoreController(UID, ({ strapi }) => ({
	// POST /api/epaper-users/register
	// Body: { email, password, displayName?, phone? }
	async register(ctx) {
		const { email, password, displayName, phone } = ctx.request.body || {};
		if (!email || !password) {
			ctx.status = 400;
			ctx.body = { error: 'email and password are required' };
			return;
		}
		if (String(password).length < 8) {
			ctx.status = 400;
			ctx.body = { error: 'Password must be at least 8 characters' };
			return;
		}

		const service = strapi.service(UID);
		const normalizedEmail = String(email).trim().toLowerCase();

		try {
			const existing = await strapi.db.query(UID).findOne({ where: { email: normalizedEmail } });
			if (existing) {
				ctx.status = 409;
				ctx.body = { error: 'An account with this email already exists' };
				return;
			}

			const passwordHash = await service.hashPassword(password);
			const user = await strapi.db.query(UID).create({
				data: {
					email: normalizedEmail,
					passwordHash,
					displayName: displayName || '',
					phone: phone || '',
					active: true,
					tokenVersion: 0
				}
			});

			ctx.body = { success: true, user: service.toPublicProfile(user), tokenVersion: user.tokenVersion };
		} catch (error) {
			strapi.log.error('[epaper-user.register]', error);
			ctx.status = 500;
			ctx.body = { success: false, error: 'Failed to register' };
		}
	},

	// POST /api/epaper-users/verify-credentials
	// Body: { email, password }
	// This is the ONLY endpoint that ever checks a password. It returns a
	// plain yes/no — never the hash, not even to the middleware.
	async verifyCredentials(ctx) {
		const { email, password } = ctx.request.body || {};
		if (!email || !password) {
			ctx.status = 400;
			ctx.body = { success: false, error: 'email and password are required' };
			return;
		}

		const service = strapi.service(UID);
		const normalizedEmail = String(email).trim().toLowerCase();

		try {
			const user = await strapi.db.query(UID).findOne({ where: { email: normalizedEmail } });

			// Deliberately run the (expensive) compare even when no user was
			// found, against a dummy hash — comparing only when a user exists
			// would make "email not found" measurably faster than "wrong
			// password", letting an attacker enumerate valid emails purely by
			// timing the response.
			const hashToCheck = user?.passwordHash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
			const passwordOk = await service.verifyPassword(password, hashToCheck);

			if (!user || !user.active || !passwordOk) {
				ctx.body = { success: false };
				return;
			}

			ctx.body = { success: true, user: service.toPublicProfile(user), tokenVersion: user.tokenVersion };
		} catch (error) {
			strapi.log.error('[epaper-user.verifyCredentials]', error);
			ctx.status = 500;
			ctx.body = { success: false, error: 'Failed to verify credentials' };
		}
	},

	// GET /api/epaper-users/:id/profile
	// Used during token refresh to confirm the account is still active and
	// read the CURRENT tokenVersion — a refresh token minted before a
	// bumpTokenVersion (logout-everywhere, or a future password change) must
	// stop working, and this is the check that enforces that.
	async getProfile(ctx) {
		const { id } = ctx.params;
		try {
			const user = await strapi.db.query(UID).findOne({ where: { id } });
			if (!user) {
				ctx.status = 404;
				ctx.body = { error: 'Not found' };
				return;
			}
			ctx.body = {
				user: strapi.service(UID).toPublicProfile(user),
				active: user.active,
				tokenVersion: user.tokenVersion
			};
		} catch (error) {
			strapi.log.error('[epaper-user.getProfile]', error);
			ctx.status = 500;
			ctx.body = { error: 'Failed to fetch profile' };
		}
	},

	// POST /api/epaper-users/:id/bump-token-version
	// Real logout: increments tokenVersion, which invalidates every
	// outstanding refresh token for this user at once (they all carry the
	// OLD version number, checked against the current one on every refresh).
	async bumpTokenVersion(ctx) {
		const { id } = ctx.params;
		try {
			const user = await strapi.db.query(UID).findOne({ where: { id } });
			if (!user) {
				ctx.status = 404;
				ctx.body = { error: 'Not found' };
				return;
			}
			const updated = await strapi.db.query(UID).update({
				where: { id },
				data: { tokenVersion: (user.tokenVersion || 0) + 1 }
			});
			ctx.body = { success: true, tokenVersion: updated.tokenVersion };
		} catch (error) {
			strapi.log.error('[epaper-user.bumpTokenVersion]', error);
			ctx.status = 500;
			ctx.body = { success: false, error: 'Failed to log out' };
		}
	}
}));
