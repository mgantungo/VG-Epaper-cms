'use strict';

/**
 * src/api/edition/content-types/edition/lifecycles.js
 *
 * ONLY concern here is generating `sku` on create. This is deliberately
 * NOT where the PDF-ingest trigger lives — that logic was moved OUT of a
 * content-type lifecycle file and into Document Service Middleware
 * (src/index.js) a while back, specifically because content-type lifecycle
 * hooks fire unreliably around Strapi 5's draft/publish mechanics (a
 * create-like event can fire more than once for what looks like one
 * publish action). That instability matters when a hook has an EXTERNAL
 * side effect (the ingest webhook call did) — firing twice would mean
 * double-processing a PDF.
 *
 * SKU generation has no such risk: it's a pure, local, idempotent
 * transformation of the record being created — if this fires more than
 * once for the same create, the `if (!data.sku)` guard below means every
 * firing after the first is a harmless no-op, since event.params.data is
 * mutated in place (same pattern the old pipelineStatus-deriving hook
 * used). That's what makes a plain content-type lifecycle safe to use
 * here even given the same underlying draft/publish quirks.
 *
 * Format: YYYYMMDD-PUBLICATIONCODE-ISSUENUMBER-RANDOM4
 * e.g.    20260924-NV-258-A3XQ7
 */

function generateSku(data) {
	const datePart = String(data.date || '').replace(/-/g, ''); // "2026-09-24" -> "20260924"
	const pubPart = String(data.publicationCode || 'NV').toUpperCase();
	const issuePart = String(data.issueNumber || '000').toUpperCase().replace(/[^A-Z0-9]/g, '');
	const randomPart = Math.random().toString(36).slice(2, 6).toUpperCase();
	return `${datePart}-${pubPart}-${issuePart}-${randomPart}`;
}

module.exports = {
	beforeCreate(event) {
		const { data } = event.params;
		if (!data || data.sku) return; // already set (or a firing after the first, per the idempotency note above) — leave it alone
		if (!data.publicationCode) data.publicationCode = 'NV';
		data.sku = generateSku(data);
	}
};