'use strict';

/**
 * src/api/epaper-transaction/routes/epaper-transaction.js
 *
 * Deliberately NOT createCoreRouter's default output — same reasoning as
 * VisionShop: a payment ledger shouldn't have a public GET (list every
 * transaction) or POST (create arbitrary records bypassing the integrator
 * flow) endpoint. Only these four specific actions are exposed. The admin
 * panel's Content Manager still works fine for viewing/managing records,
 * since it uses its own internal admin API regardless of what's
 * registered here.
 */

module.exports = {
	routes: [
		{
			method: 'POST',
			path: '/epaper-transactions/initialize',
			handler: 'epaper-transaction.initialize',
			config: { auth: false }
		},
		{
			method: 'POST',
			path: '/epaper-transactions/callback',
			handler: 'epaper-transaction.callback',
			config: { auth: false }
		},
		{
			method: 'GET',
			path: '/epaper-transactions/status/:token',
			handler: 'epaper-transaction.status',
			config: { auth: false }
		},
		{
			method: 'GET',
			path: '/epaper-transactions/receipt/:token',
			handler: 'epaper-transaction.receipt',
			config: { auth: false }
		}
	]
};
