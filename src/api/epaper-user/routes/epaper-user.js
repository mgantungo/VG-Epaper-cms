'use strict';

/**
 * src/api/epaper-user/routes/epaper-user.js
 *
 * Unlike epaper-transaction's routes, these are NOT { auth: false }. The
 * epaper-transaction webhook needs to be reachable by an external payment
 * integrator with no Strapi credentials of its own — that's a legitimate
 * reason for auth:false. There's no equivalent reason here: the only
 * legitimate caller of "check this password" or "invalidate this user's
 * sessions" is this project's own middleware, which already authenticates
 * every other call to Strapi with STRAPI_API_TOKEN (see
 * apps/middleware/src/services/strapiClient.js). Leaving these public would
 * mean anyone on the internet could hit verify-credentials directly and use
 * it as a password-guessing oracle with no rate limiting or logging in
 * front of it at all.
 *
 * No default createCoreRouter output either, same reasoning as
 * transaction-processing: no public GET-all (would list every reader's
 * email) or POST (would let someone create raw records bypassing
 * register's validation).
 */

module.exports = {
	routes: [
		{
			method: 'POST',
			path: '/epaper-users/register',
			handler: 'epaper-user.register'
		},
		{
			method: 'POST',
			path: '/epaper-users/verify-credentials',
			handler: 'epaper-user.verifyCredentials'
		},
		{
			method: 'GET',
			path: '/epaper-users/:id/profile',
			handler: 'epaper-user.getProfile'
		},
		{
			method: 'POST',
			path: '/epaper-users/:id/bump-token-version',
			handler: 'epaper-user.bumpTokenVersion'
		}
	]
};
