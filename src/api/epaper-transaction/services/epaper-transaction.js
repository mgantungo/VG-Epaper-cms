'use strict';

/**
 * src/api/epaper-transaction/services/epaper-transaction.js
 *
 * normalizePhoneNumber / generateInvoiceNumber / generateReceiptToken /
 * callIntegrator are carried over directly from VisionShop's
 * transaction-processing service — same reasoning, same integrator, no
 * changes needed there.
 *
 * Same deliberate constraints as the VisionShop original:
 *   - strapi.db.query(...) for all reads/writes, not entityService/Documents
 *     API, so this behaves identically on Strapi 4 and 5.
 *   - Node's built-in fetch for the integrator call, no axios dependency.
 */

const { createCoreService } = require('@strapi/strapi').factories;
const crypto = require('crypto');

const UID = 'api::epaper-transaction.epaper-transaction';
const ENTITLEMENT_UID = 'api::epaper-entitlement.epaper-entitlement';
const EDITION_UID = 'api::edition.edition';
const { kampalaToday, periodRange } = require('../../../utils/epaper-dates');
const INTEGRATOR_URL = 'https://transactions-api-production.newvisionapp.com/V1/PaymentGateway';

// Mirrors VisionShop's request_payment_through_integrator.php normalization:
// strip a leading '+', or replace a leading '0' with '256'.
function normalizePhoneNumber(phoneNumber) {
	if (!phoneNumber) return phoneNumber;
	if (phoneNumber.startsWith('+')) {
		return phoneNumber.substring(1);
	}
	if (phoneNumber.startsWith('0')) {
		return '256' + phoneNumber.substring(1);
	}
	return phoneNumber;
}

function generateInvoiceNumber() {
	const date = new Date();
	const datePart = date.toISOString().slice(0, 10).replace(/-/g, '');
	const randomPart = Math.random().toString(36).slice(2, 8).toUpperCase();
	return `EP-${datePart}-${randomPart}`;
}

function generateReceiptToken() {
	return crypto.randomBytes(24).toString('base64url');
}

async function callIntegrator(record) {
	const payload = {
		customerFullName: record.customer_name || '',
		customerId: String(record.id),
		customerEmail: record.customer_email || '',
		customerMSISDN: record.customer_phone || '',
		productCode: `EPAPER/${record.id}`,
		productDescription: `Vision Group e-paper: ${record.transaction_data?.planLabel || 'subscription'}, REF: epaper_${record.id}`,
		amountToDeduct: record.amount,
		paymentMethod: record.payment_method,
		payWithMSISDN: normalizePhoneNumber(record.phone_number),
		currencyCode: record.currency || 'UGX',
		callbackURL: process.env.PAYMENT_CALLBACK_URL || '',
		metaData: `Epaper ref: ${record.id}, plan: ${record.transaction_data?.planKey || ''}`
	};

	try {
		const response = await fetch(INTEGRATOR_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});
		const body = await response.json().catch(() => ({}));
		return { ok: response.ok, status: response.status, body };
	} catch (error) {
		strapi.log.error('[epaper-transaction] integrator call failed', error);
		return { ok: false, status: 0, body: { error: error.message } };
	}
}

/**
 * REWRITTEN (Phase 0: publications, plans and paper-aware access).
 *
 * Called once, from the callback handler, only after payment is confirmed.
 * Creates one entitlement per publication the purchase opens:
 *
 *   period plan       one row per publication in the plan, all covering
 *                     [today, today + duration) in Kampala time. Each row's
 *                     amountAllocated is that publication's share of the
 *                     payment, from the plan's revenue split (frozen here,
 *                     so a later split change never rewrites past revenue).
 *   single_issue      one row per edition bought, covering exactly the days
 *                     that edition covers (a weekend edition: Sat–Sun), with
 *                     `edition` set and amountAllocated = the plan price.
 *
 * amountPaid stays on the FIRST row only (the whole payment), as before, so
 * summing amountPaid never double-counts; reports sum amountAllocated.
 *
 * Idempotent: if this transaction already has entitlements (the integrator
 * retried its callback), nothing is created again.
 */
async function grantEntitlement(strapi, record) {
	const relationId = (value) => (typeof value === 'object' && value !== null ? value.id : value);
	const planId = relationId(record.plan);
	const userId = relationId(record.user);

	const existing = await strapi.db.query(ENTITLEMENT_UID).count({ where: { transaction: { id: record.id } } });
	if (existing) {
		strapi.log.warn(`[epaper-transaction] transaction ${record.id} already has ${existing} entitlement(s); not granting again`);
		return [];
	}

	const plan = await strapi.db.query('api::epaper-plan.epaper-plan').findOne({
		where: { id: planId },
		populate: { publications: { select: ['id', 'code'] } }
	});
	if (!plan) throw new Error(`Transaction ${record.id} references a missing plan (record.plan was: ${JSON.stringify(record.plan)})`);
	if (!userId) throw new Error(`Transaction ${record.id} has no user`);

	const data = record.transaction_data || {};
	const catalogue = strapi.service('api::catalogue.catalogue-store');
	const today = kampalaToday();
	const base = {
		user: userId,
		organization: null,
		scope: 'personal',
		grantSource: 'purchase',
		plan: plan.id,
		currency: record.currency || plan.currency || 'UGX',
		transaction: record.id
	};
	const created = [];

	if (plan.kind === 'single_issue') {
		const ids = Array.isArray(data.editionIds) ? data.editionIds : [];
		if (!ids.length) throw new Error(`Transaction ${record.id} is a single-issue purchase with no editions recorded`);
		const editions = await strapi.db.query(EDITION_UID).findMany({
			where: { id: { $in: ids } },
			select: ['id', 'date', 'coversFrom', 'coversTo'],
			populate: { publication: { select: ['id', 'code'] } }
		});
		for (const e of editions) {
			created.push(await strapi.db.query(ENTITLEMENT_UID).create({
				data: {
					...base,
					publication: e.publication?.id || plan.publications?.[0]?.id || null,
					edition: e.id,
					coverageStart: e.coversFrom || e.date,
					coverageEnd: e.coversTo || e.date,
					amountPaid: created.length === 0 ? record.amount : 0,
					amountAllocated: Number(plan.price)
				}
			}));
		}
		return created;
	}

	const { start, end } = periodRange(today, plan.durationUnit, plan.durationCount);
	const split = await catalogue.splitForSale(plan, today);
	const shares = catalogue.allocate(record.amount, split);
	for (const pub of plan.publications || []) {
		created.push(await strapi.db.query(ENTITLEMENT_UID).create({
			data: {
				...base,
				publication: pub.id,
				coverageStart: start,
				coverageEnd: end,
				amountPaid: created.length === 0 ? record.amount : 0,
				amountAllocated: shares[pub.code] ?? 0,
				note: (plan.publications || []).length > 1 ? `bundle ${plan.key} v${plan.version}: ${split[pub.code]}% of ${record.amount}` : null
			}
		}));
	}
	return created;
}

module.exports = createCoreService(UID, () => ({
	normalizePhoneNumber,
	generateInvoiceNumber,
	generateReceiptToken,
	callIntegrator,
	grantEntitlement
}));