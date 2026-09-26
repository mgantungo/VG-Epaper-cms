'use strict';

/**
 * src/api/epaper-transaction/controllers/epaper-transaction.js
 *
 * Same three-action shape as VisionShop's transaction-processing, plus a
 * fourth (receipt) it already had too. This controller only ever sets
 * aggregator_status — never frontend_status directly; content-types/
 * epaper-transaction/lifecycles.js derives frontend_status every time.
 *
 * All DB access via strapi.db.query(...), not entityService/Documents API.
 *
 * This does NOT receive Strapi user-auth context (routes are auth:false) —
 * the caller here is the middleware, already having verified the reader's
 * identity itself, passing userId explicitly.
 */

const { createCoreController } = require('@strapi/strapi').factories;

const UID = 'api::epaper-transaction.epaper-transaction';
const PLAN_UID = 'api::epaper-plan.epaper-plan';

function appendToLog(existingLog, entry) {
	const log = Array.isArray(existingLog) ? existingLog : [];
	return [...log, { ...entry, recordedAt: new Date().toISOString() }];
}

module.exports = createCoreController(UID, ({ strapi }) => ({
	// POST /api/epaper-transactions/initialize
	// Body: { userId, phoneNumber, paymentmethod, planKey, purchaseKind,
	//         customerName?, customerEmail?, customerPhone?,
	//         organizationName?,   // required if purchaseKind === 'organization_new'
	//         organizationId?,     // required if purchaseKind === 'organization_topup'
	//         seatCount?,          // org purchases only, default 1
	//         archiveDate?,        // single_archive plans — one date (back-compat)
	//         archiveDates? }      // single_archive plans — "buy any number of
	//                              // archives in one purchase": an array of dates,
	//                              // price scales by how many are selected.
	//                              // archiveDate is still accepted as a single-
	//                              // element equivalent; if both are given,
	//                              // archiveDates wins.
	async initialize(ctx) {
		const body = ctx.request.body || {};
		const { userId, phoneNumber, paymentmethod, planKey, purchaseKind } = body;

		if (!userId || !phoneNumber || !paymentmethod || !planKey || !purchaseKind) {
			ctx.status = 400;
			ctx.body = { error: 'Missing required fields: userId, phoneNumber, paymentmethod, planKey, purchaseKind' };
			return;
		}
		if (!['personal', 'organization_new', 'organization_topup'].includes(purchaseKind)) {
			ctx.status = 400;
			ctx.body = { error: 'purchaseKind must be personal, organization_new, or organization_topup' };
			return;
		}
		if (purchaseKind === 'organization_new' && !body.organizationName) {
			ctx.status = 400;
			ctx.body = { error: 'organizationName is required for purchaseKind=organization_new' };
			return;
		}
		if (purchaseKind === 'organization_topup' && !body.organizationId) {
			ctx.status = 400;
			ctx.body = { error: 'organizationId is required for purchaseKind=organization_topup' };
			return;
		}

		if (!process.env.PAYMENT_CALLBACK_URL) {
			strapi.log.warn(
				'[epaper-transaction.initialize] PAYMENT_CALLBACK_URL is not set — the aggregator ' +
				'will be sent an empty callbackURL and will have nowhere to notify us of payment result.'
			);
		}

		const plan = await strapi.db.query(PLAN_UID).findOne({ where: { key: planKey, active: true } });
		if (!plan) {
			ctx.status = 404;
			ctx.body = { error: `No active plan with key "${planKey}"` };
			return;
		}

		// Normalize to an array regardless of which shape the caller sent —
		// archiveDates (plural, "any number of archives") is the primary
		// shape now; a single archiveDate is still accepted for back-compat,
		// treated as a one-element array. Duplicates are stripped, not
		// billed twice for the same date.
		let archiveDates = [];
		if (plan.kind === 'single_archive') {
			const raw = Array.isArray(body.archiveDates) ? body.archiveDates : (body.archiveDate ? [body.archiveDate] : []);
			archiveDates = [...new Set(raw.filter(Boolean))];
			if (archiveDates.length === 0) {
				ctx.status = 400;
				ctx.body = { error: 'archiveDate or archiveDates is required for this plan' };
				return;
			}
		}

		const isOrgPurchase = purchaseKind !== 'personal';
		if (isOrgPurchase && !plan.allowsOrgPurchase) {
			ctx.status = 400;
			ctx.body = { error: `Plan "${planKey}" cannot be purchased for an organization` };
			return;
		}

		// Amount is computed here from the plan's own price — NEVER trusted
		// from the client. Scales by seat count (org purchases) AND by how
		// many archive dates were selected — a client-submitted amount
		// would let anyone request a real payment prompt for a self-chosen
		// figure; only these two multipliers vary the total, and both are
		// derived server-side from what was actually validated above.
		const seatCount = isOrgPurchase ? Math.max(1, parseInt(body.seatCount, 10) || 1) : 1;
		const dateMultiplier = plan.kind === 'single_archive' ? archiveDates.length : 1;
		const amount = plan.price * seatCount * dateMultiplier;

		const service = strapi.service(UID);

		try {
			const record = await strapi.db.query(UID).create({
				data: {
					invoice_number: service.generateInvoiceNumber(),
					receipt_token: service.generateReceiptToken(),
					aggregator_status: 'not_sent',
					amount,
					currency: plan.currency || 'UGX',
					phone_number: phoneNumber,
					payment_method: paymentmethod,
					user: userId,
					organization: purchaseKind === 'organization_topup' ? body.organizationId : null,
					plan: plan.id,
					purchase_kind: purchaseKind,
					customer_name: body.customerName || '',
					customer_email: body.customerEmail || '',
					customer_phone: body.customerPhone || phoneNumber,
					transaction_data: {
						planKey,
						seatCount,
						archiveDates: plan.kind === 'single_archive' ? archiveDates : null,
						organizationName: body.organizationName || null
					},
					aggregator_response_log: []
				}
			});

			const integratorResult = await service.callIntegrator(record);
			const transactionRef = integratorResult.body && integratorResult.body.transactionReference;
			const aggregatorStatus = integratorResult.ok ? 'initiated' : 'failed';

			const updated = await strapi.db.query(UID).update({
				where: { id: record.id },
				data: {
					payment_request_sent: true,
					payment_request_sent_at: new Date(),
					integrator_transaction_ref: transactionRef || null,
					aggregator_status: aggregatorStatus,
					failure_reason: integratorResult.ok ? null : 'Integrator request failed',
					aggregator_response_log: appendToLog(record.aggregator_response_log, {
						source: 'initiate_response',
						httpStatus: integratorResult.status,
						body: integratorResult.body
					})
				}
			});

			ctx.body = {
				success: 1,
				receipt_token: updated.receipt_token,
				invoice_number: updated.invoice_number,
				status: updated.frontend_status,
				amount,
				currency: updated.currency,
				archiveDatesCount: archiveDates.length || undefined
			};
		} catch (error) {
			strapi.log.error('[epaper-transaction.initialize]', error);
			ctx.status = 500;
			ctx.body = { success: 0, error: 'Failed to initialize payment' };
		}
	},

	// POST /api/epaper-transactions/callback
	// Body (from the integrator): { transactionreference, customerid, message, ...rest }
	async callback(ctx) {
		const body = ctx.request.body || {};
		const { transactionreference, customerid, message } = body;

		const expectedSecret = process.env.PAYMENT_CALLBACK_SECRET;
		if (expectedSecret && ctx.request.headers['x-callback-secret'] !== expectedSecret) {
			ctx.status = 401;
			ctx.body = { error: 'Unauthorized' };
			return;
		}

		if (!transactionreference || !customerid || !message) {
			ctx.status = 400;
			ctx.body = { error: 'Missing required fields' };
			return;
		}

		try {
			const record = await strapi.db.query(UID).findOne({
				where: { integrator_transaction_ref: transactionreference, id: customerid }
			});
			if (!record) {
				ctx.status = 404;
				ctx.body = { error: 'Transaction not found' };
				return;
			}

			const isSuccess = String(message).toUpperCase() === 'PAYMENT SUCCESSFUL';
			const aggregatorStatus = isSuccess ? 'successful' : 'failed';

			const updated = await strapi.db.query(UID).update({
				where: { id: record.id },
				data: {
					aggregator_status: aggregatorStatus,
					failure_reason: isSuccess ? null : message,
					callback_received: true,
					callback_received_at: new Date(),
					aggregator_response_log: appendToLog(record.aggregator_response_log, { source: 'callback', body })
				}
			});

			ctx.body = { success: true };

			if (isSuccess) {
				strapi.service(UID).grantEntitlement(strapi, updated).catch(error => {
					strapi.log.error(`[epaper-transaction.callback] failed to grant entitlement for transaction ${updated.id}`, error);
				});
			}
		} catch (error) {
			strapi.log.error('[epaper-transaction.callback]', error);
			ctx.status = 500;
			ctx.body = { error: 'Failed to update transaction' };
		}
	},

	// GET /api/epaper-transactions/status/:token
	async status(ctx) {
		const { token } = ctx.params;
		try {
			const record = await strapi.db.query(UID).findOne({ where: { receipt_token: token } });
			if (!record) {
				ctx.status = 404;
				ctx.body = { success: 0, error: 'No records found' };
				return;
			}
			ctx.body = {
				success: 1,
				callback_received: record.callback_received,
				payment_success: record.payment_success,
				frontend_status: record.frontend_status,
				aggregator_status: record.aggregator_status,
				invoice_number: record.invoice_number,
				failure_reason: record.failure_reason
			};
		} catch (error) {
			strapi.log.error('[epaper-transaction.status]', error);
			ctx.status = 500;
			ctx.body = { success: 0, error: 'Error fetching transaction status' };
		}
	},

	// GET /api/epaper-transactions/receipt/:token
	// Only returns data once payment has actually succeeded. `coverage` is
	// now an ARRAY, not a single {start,end} object — a single_archive
	// purchase can grant more than one entitlement in one transaction
	// (see grantEntitlement's own comment), so this returns every date
	// range actually granted, not just the first one findOne would have
	// happened to return.
	async receipt(ctx) {
		const { token } = ctx.params;
		try {
			const record = await strapi.db.query(UID).findOne({
				where: { receipt_token: token },
				populate: ['plan']
			});
			if (!record) {
				ctx.status = 404;
				ctx.body = { success: 0, error: 'No records found' };
				return;
			}
			if (!record.payment_success) {
				ctx.status = 403;
				ctx.body = { success: 0, error: 'Receipt is only available for successfully paid transactions' };
				return;
			}

			const entitlements = await strapi.db.query('api::epaper-entitlement.epaper-entitlement').findMany({
				where: { transaction: record.id }
			});

			ctx.body = {
				success: 1,
				invoice_number: record.invoice_number,
				transaction_date: record.createdAt,
				amount: record.amount,
				currency: record.currency,
				payment_method: record.payment_method,
				plan_label: record.plan?.label,
				purchase_kind: record.purchase_kind,
				coverage: entitlements.map(e => ({ start: e.coverageStart, end: e.coverageEnd }))
			};
		} catch (error) {
			strapi.log.error('[epaper-transaction.receipt]', error);
			ctx.status = 500;
			ctx.body = { success: 0, error: 'Error fetching receipt' };
		}
	}
}));