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
const CATALOGUE_UID = 'api::catalogue.catalogue-store';

function appendToLog(existingLog, entry) {
	const log = Array.isArray(existingLog) ? existingLog : [];
	return [...log, { ...entry, recordedAt: new Date().toISOString() }];
}

module.exports = createCoreController(UID, ({ strapi }) => ({
	// POST /api/epaper-transactions/initialize                 REWRITTEN (Phase 0)
	// Body: { userId, phoneNumber, paymentmethod, planKey,
	//         editionDates?,            // single_issue plans: one or more dates of the
	//                                   // plan's publication ("buy several back issues
	//                                   // at once"); archiveDates / archiveDate are
	//                                   // accepted as older names for the same thing
	//         customerName?, customerEmail?, customerPhone? }
	//
	// Individuals only, at the standard price on sale today (agreed 23 Oct
	// 2026: no negotiation for individuals). Organisations are not sold plans;
	// their contracts are priced by hand in handle (org-management). The
	// amount is computed here from the plan version, never taken from the client.
	async initialize(ctx) {
		const body = ctx.request.body || {};
		const { userId, phoneNumber, paymentmethod, planKey } = body;

		if (!userId || !phoneNumber || !paymentmethod || !planKey) {
			ctx.status = 400;
			ctx.body = { error: 'Missing required fields: userId, phoneNumber, paymentmethod, planKey' };
			return;
		}
		if (body.purchaseKind && body.purchaseKind !== 'personal') {
			ctx.status = 400;
			ctx.body = { error: 'Organisations are set up by New Vision, not bought online. Contact us for a contract.' };
			return;
		}

		if (!process.env.PAYMENT_CALLBACK_URL) {
			strapi.log.warn(
				'[epaper-transaction.initialize] PAYMENT_CALLBACK_URL is not set — the aggregator ' +
				'will be sent an empty callbackURL and will have nowhere to notify us of payment result.'
			);
		}

		const catalogue = strapi.service(CATALOGUE_UID);
		const plan = await catalogue.planForSale(planKey);
		if (!plan) {
			ctx.status = 404;
			ctx.body = { error: `"${planKey}" is not on sale today` };
			return;
		}
		const publicationCodes = (plan.publications || []).map((p) => p.code).sort();
		if (!publicationCodes.length) {
			ctx.status = 409;
			ctx.body = { error: `Plan "${planKey}" includes no publication` };
			return;
		}

		let editions = [];
		if (plan.kind === 'single_issue') {
			const raw = Array.isArray(body.editionDates) ? body.editionDates
				: Array.isArray(body.archiveDates) ? body.archiveDates
					: (body.editionDate || body.archiveDate) ? [body.editionDate || body.archiveDate] : [];
			const dates = [...new Set(raw.filter(Boolean).map(String))];
			if (!dates.length) {
				ctx.status = 400;
				ctx.body = { error: 'Choose the edition(s) to buy (editionDates)' };
				return;
			}
			if (dates.length > 60) {
				ctx.status = 400;
				ctx.body = { error: 'At most 60 editions in one purchase' };
				return;
			}
			try {
				editions = await catalogue.editionsFor(publicationCodes[0], dates);
			} catch (err) {
				ctx.status = err.status || 500;
				ctx.body = { error: err.message };
				return;
			}
		}

		const quantity = plan.kind === 'single_issue' ? editions.length : 1;
		const amount = Number(plan.price) * quantity;
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
					organization: null,
					plan: plan.id,
					purchase_kind: 'personal',
					customer_name: body.customerName || '',
					customer_email: body.customerEmail || '',
					customer_phone: body.customerPhone || phoneNumber,
					transaction_data: {
						planKey: plan.key,
						planVersion: plan.version,
						planLabel: plan.label,
						publicationCodes,
						quantity,
						editionIds: editions.map((e) => e.id),
						editionDates: editions.map((e) => e.date)
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
				planLabel: plan.label,
				publicationCodes,
				editionsCount: editions.length || undefined
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
				// update()'s own return value does NOT include relation fields
				// like plan/user/organization — confirmed directly: passing
				// `updated` straight into grantEntitlement() produced
				// "Undefined column(s): [t0.id]" from Knex, because
				// record.plan was genuinely undefined, not just a
				// differently-shaped value. Re-fetching with populate right
				// here, once, gives grantEntitlement() a record that
				// actually has these fields — populated objects, which its
				// own relationId() helper already knows how to read.
				const fullRecord = await strapi.db.query(UID).findOne({
					where: { id: updated.id },
					populate: { plan: { populate: { publications: { select: ['id', 'code'] } } }, user: true, organization: true }
				});
				strapi.service(UID).grantEntitlement(strapi, fullRecord).catch(error => {
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
			// access_ready: entitlements exist (they're granted just after the
			// callback), so the reader can open what they bought right now.
			const granted = record.payment_success
				? await strapi.db.query('api::epaper-entitlement.epaper-entitlement').count({ where: { transaction: { id: record.id } } })
				: 0;
			ctx.body = {
				success: 1,
				callback_received: record.callback_received,
				payment_success: record.payment_success,
				access_ready: granted > 0,
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
	// now an ARRAY, not a single {start,end} object — a bundle or a
	// multi-edition single-issue purchase grants several entitlements, one
	// per publication or edition, each with its publication code. (Was: a single_archive
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
				where: { transaction: record.id },
				populate: { publication: { select: ['code', 'name'] } }
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
				coverage: entitlements.map(e => ({
					start: e.coverageStart,
					end: e.coverageEnd,
					publication: e.publication?.code || null,
					publicationName: e.publication?.name || null
				}))
			};
		} catch (error) {
			strapi.log.error('[epaper-transaction.receipt]', error);
			ctx.status = 500;
			ctx.body = { success: 0, error: 'Error fetching receipt' };
		}
	}
}));