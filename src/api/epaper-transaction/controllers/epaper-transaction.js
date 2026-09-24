'use strict';

/**
 * src/api/epaper-transaction/controllers/epaper-transaction.js
 *
 * Same three-action shape as VisionShop's transaction-processing, plus a
 * fourth (receipt) it already had too:
 *   - initialize: create the pending transaction + request payment from the integrator
 *   - callback:   the integrator's webhook — on success, this is also where
 *                 the actual Entitlement gets created (VisionShop's callback
 *                 has no equivalent step, since it doesn't grant "access,"
 *                 just marks an order paid)
 *   - status:     polled by the frontend while waiting on the customer's PIN
 *   - receipt:    full detail, once, for the confirmation page
 *
 * Same rule as VisionShop: this controller only ever sets aggregator_status
 * — never frontend_status directly. content-types/epaper-transaction/
 * lifecycles.js derives frontend_status every time, so that mapping lives
 * in exactly one place.
 *
 * All DB access via strapi.db.query(...), not entityService/Documents API —
 * identical behavior on Strapi 4 and 5.
 *
 * This does NOT receive Strapi user-auth context (routes are auth:false,
 * same reasoning as VisionShop: the caller here is the middleware, already
 * having verified the reader's identity itself, passing userId explicitly —
 * not a browser calling Strapi directly).
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
	//         archiveDate? }       // required if the plan's kind is 'single_archive'
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
		if (plan.kind === 'single_archive' && !body.archiveDate) {
			ctx.status = 400;
			ctx.body = { error: 'archiveDate is required for this plan' };
			return;
		}
		const isOrgPurchase = purchaseKind !== 'personal';
		if (isOrgPurchase && !plan.allowsOrgPurchase) {
			ctx.status = 400;
			ctx.body = { error: `Plan "${planKey}" cannot be purchased for an organization` };
			return;
		}

		// Amount is computed here from the plan's own price — NEVER trusted
		// from the client. A client-submitted amount would let anyone request
		// a real payment prompt for a self-chosen (e.g. tiny) figure; only the
		// seat count varies the total, and even that is clamped to a sane
		// minimum of 1.
		const seatCount = isOrgPurchase ? Math.max(1, parseInt(body.seatCount, 10) || 1) : 1;
		const amount = plan.price * seatCount;

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
						archiveDate: body.archiveDate || null,
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

			// Same reasoning as VisionShop: never return the raw sequential id —
			// receipt_token is the only thing the caller needs from here on.
			ctx.body = {
				success: 1,
				receipt_token: updated.receipt_token,
				invoice_number: updated.invoice_number,
				status: updated.frontend_status,
				amount,
				currency: updated.currency
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

			// The one real addition over VisionShop's callback: actually grant
			// what was paid for. Fire-and-forget after the response is already
			// sent, same reasoning as VisionShop's tracking-record creation —
			// a hiccup here shouldn't hold up acknowledging the aggregator's
			// webhook (they'll retry if we don't 200 promptly).
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
	// Only returns data once payment has actually succeeded — same reasoning
	// as VisionShop: prevents viewing another customer's purchase detail even
	// if someone somehow had the token for a still-pending transaction.
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

			const entitlement = await strapi.db.query('api::epaper-entitlement.epaper-entitlement').findOne({
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
				coverage: entitlement ? { start: entitlement.coverageStart, end: entitlement.coverageEnd } : null
			};
		} catch (error) {
			strapi.log.error('[epaper-transaction.receipt]', error);
			ctx.status = 500;
			ctx.body = { success: 0, error: 'Error fetching receipt' };
		}
	}
}));
