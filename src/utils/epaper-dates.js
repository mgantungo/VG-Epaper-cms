'use strict';

/**
 * src/utils/epaper-dates.js                                   NEW FILE
 *
 * Date rules shared by the catalogue, payments and organisation code.
 * Everything works on 'YYYY-MM-DD' strings in UTC arithmetic, so a date
 * never shifts with the server's time zone.
 *
 * "Today" is the Kampala calendar day (UTC+3, no daylight saving), which
 * is the day printed on the paper. The old todayIso() helpers used the
 * server's UTC date, so between 00:00 and 03:00 Kampala time they still
 * returned yesterday.
 */

const KAMPALA_OFFSET_MS = 3 * 60 * 60 * 1000;

function kampalaToday(now = Date.now()) {
  return new Date(now + KAMPALA_OFFSET_MS).toISOString().slice(0, 10);
}

function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

function toUtc(iso) {
  return new Date(`${iso}T00:00:00Z`);
}

function addDays(iso, n) {
  const d = toUtc(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** iso + n calendar months, clamped to the end of the target month
 * (31 Jan + 1 month = 28/29 Feb, not 2/3 Mar). */
function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * The inclusive [start, end] a period plan covers when bought on `start`.
 * 1 month from 23 Oct = 23 Oct – 22 Nov; 1 week from Mon = Mon – Sun.
 */
function periodRange(start, unit, count) {
  const n = Math.max(1, Number(count) || 1);
  let next;
  if (unit === 'day') next = addDays(start, n);
  else if (unit === 'week') next = addDays(start, 7 * n);
  else if (unit === 'year') next = addMonths(start, 12 * n);
  else next = addMonths(start, n); // month (default)
  return { start, end: addDays(next, -1) };
}

/** Approximate length in days, used only to compare prices per day. */
function approxDays(unit, count) {
  const n = Math.max(1, Number(count) || 1);
  if (unit === 'day') return n;
  if (unit === 'week') return 7 * n;
  if (unit === 'year') return 365 * n;
  return 30 * n;
}

/** The days an edition dated `date` covers for a publication with `coverDays`. */
function editionCover(date, coverDays) {
  const days = Math.max(1, Number(coverDays) || 1);
  return { coversFrom: date, coversTo: addDays(date, days - 1) };
}

/** Do the inclusive ranges [aStart, aEnd] and [bStart, bEnd] share a day? */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

module.exports = {
  kampalaToday,
  isIsoDate,
  addDays,
  addMonths,
  periodRange,
  approxDays,
  editionCover,
  overlaps
};
