'use strict';

/**
 * src/api/epaper-transaction/content-types/epaper-transaction/lifecycles.js
 *
 * The ONE place that translates the aggregator's vocabulary
 * (aggregator_status) into what the frontend polling endpoint shows
 * (frontend_status) — identical reasoning to VisionShop's
 * transaction-processing lifecycle: nothing else should set
 * frontend_status directly, so the mapping can never drift out of sync
 * between initialize/callback/any future reconciliation job.
 *
 * Same cross-version reasoning as the VisionShop original: content-type
 * lifecycle hooks (this exact file, beforeCreate/beforeUpdate receiving
 * event.params.data) work the same way on Strapi 4 and 5, unlike v5-only
 * Document Service middleware.
 */

const STATUS_MAP = {
	not_sent: 'pending',
	initiated: 'processing',
	processing: 'processing',
	successful: 'success',
	failed: 'failed',
	timeout: 'timeout',
	unknown: 'processing' // safe default: keep the frontend polling rather than falsely reporting failure
};

function deriveFieldsFromAggregatorStatus(data) {
	if (!data || !data.aggregator_status) return;

	const aggregatorStatus = data.aggregator_status;
	const frontendStatus = STATUS_MAP[aggregatorStatus] || 'processing';

	data.frontend_status = frontendStatus;
	data.payment_success = aggregatorStatus === 'successful';

	// callback_received is deliberately NOT derived here — same reasoning as
	// VisionShop: only the `callback` controller action actually knows a
	// callback was received, so it sets that (and callback_received_at)
	// explicitly itself.
}

module.exports = {
	beforeCreate(event) {
		deriveFieldsFromAggregatorStatus(event.params.data);
	},
	beforeUpdate(event) {
		deriveFieldsFromAggregatorStatus(event.params.data);
	}
};
