'use strict';

/**
 * src/api/epaper-transaction/services/epaper-transaction.js
 *
 * normalizePhoneNumber / generateInvoiceNumber / generateReceiptToken /
 * callIntegrator are carried over directly from VisionShop's
 * transaction-processing service — same reasoning, same integrator, no
 * changes needed there. What's new below is specific to epaper: computing
 * how much coverage a plan grants, and turning a successful transaction
 * into the actual Entitlement record that hasAccess() checks against.
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
const ORGANIZATION_UID = 'api::epaper-organization.epaper-organization';
const ORG_SEAT_UID = 'api::epaper-org-seat.epaper-org-seat';
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

// Same reasoning as VisionShop: every customer-facing lookup (status
// polling, the receipt page) uses this instead of the raw sequential id,
// which is trivially enumerable.
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
		productDescription: `New Vision E-Paper, REF: epaper_${record.id}`,
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
 * Turns a Plan's `kind` into a concrete [coverageStart, coverageEnd] date
 * pair, anchored at `fromDate` (a JS Date — the moment the transaction
 * succeeded, or the requested archive date for single_archive purchases).
 * This is the one place that interprets plan.kind, same reasoning as the
 * lifecycle hook below being the one place that interprets
 * aggregator_status — a single source of truth so the mapping can't drift.
 */
function computeCoverage(plan, { fromDate, archiveDate }) {
	const iso = (d) => d.toISOString().slice(0, 10);

	if (plan.kind === 'single_archive') {
		if (!archiveDate) throw new Error('archiveDate is required for a single_archive plan');
		return { coverageStart: archiveDate, coverageEnd: archiveDate };
	}
	if (plan.kind === 'daily') {
		const day = iso(fromDate);
		return { coverageStart: day, coverageEnd: day };
	}
	if (plan.kind === 'period_subscription') {
		const start = new Date(fromDate);
		const end = new Date(fromDate);
		end.setDate(end.getDate() + (plan.durationDays || 30));
		return { coverageStart: iso(start), coverageEnd: iso(end) };
	}
	if (plan.kind === 'all_archive_access') {
		return { coverageStart: iso(fromDate), coverageEnd: '9999-12-31' };
	}
	throw new Error(`Unknown plan.kind: ${plan.kind}`);
}

/**
 * Called once, from the callback handler, only after payment is confirmed
 * successful. Creates the Organization (for a brand-new org purchase),
 * then the Entitlement itself, linked back to the transaction that paid
 * for it.
 */
async function grantEntitlement(strapi, record) {
	const plan = await strapi.db.query('api::epaper-plan.epaper-plan').findOne({ where: { id: record.plan } });
	if (!plan) throw new Error(`Transaction ${record.id} references a missing plan`);

	const data = record.transaction_data || {};
	const { coverageStart, coverageEnd } = computeCoverage(plan, {
		fromDate: new Date(),
		archiveDate: data.archiveDate
	});

	let organizationId = null;

	if (record.purchase_kind === 'organization_new') {
		const org = await strapi.db.query(ORGANIZATION_UID).create({
			data: { name: data.organizationName, owner: record.user, active: true }
		});
		organizationId = org.id;
		// The buyer themselves gets a seat too — an org owner who paid for
		// this shouldn't have to separately assign themselves a seat to read.
		await strapi.db.query(ORG_SEAT_UID).create({
			data: { organization: org.id, user: record.user, active: true, assignedAt: new Date() }
		});
	} else if (record.purchase_kind === 'organization_topup') {
		organizationId = record.organization;
	}

	return strapi.db.query(ENTITLEMENT_UID).create({
		data: {
			user: organizationId ? null : record.user,
			organization: organizationId,
			plan: plan.id,
			coverageStart,
			coverageEnd,
			amountPaid: record.amount,
			currency: record.currency,
			transaction: record.id
		}
	});
}

module.exports = createCoreService(UID, () => ({
	normalizePhoneNumber,
	generateInvoiceNumber,
	generateReceiptToken,
	callIntegrator,
	computeCoverage,
	grantEntitlement
}));
