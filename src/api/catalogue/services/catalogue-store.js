'use strict';

/**
 * src/api/catalogue/services/catalogue-store.js                NEW FILE
 *
 * Publications, plans and prices — everything readers can buy — plus the
 * read models the middleware needs to decide access and draw the landing
 * page. There is no content type behind this API; it works over
 * publication, epaper-plan, edition, epaper-entitlement and epaper-org-seat.
 *
 * Callers (all through the middleware, with STRAPI_API_TOKEN):
 *   controllers/catalogue-handle.js  handle admins with canManageOrganizations
 *   controllers/catalogue-public.js  the reader web app (storefront, plans,
 *                                    access profile)
 *
 * Plan versions. A plan is identified by `key`. Changing its price or its
 * revenue split never edits a sold row: it adds a row with the same key and
 * the next version, valid from a chosen date. The version on sale on a day
 * is the highest active version whose [validFrom, validTo] includes it.
 * What a plan includes (publications, kind, duration) never changes between
 * versions; a different bundle is a different plan.
 *
 * Revenue split (option A, agreed 23 Oct 2026). For a plan with several
 * publications, the suggested split is proportional to each publication's
 * own standard price per day, taken from its shortest single-publication
 * period plan on sale. handle pre-fills it; admins can edit it; it is
 * frozen onto each entitlement at sale.
 *
 * All DB access via strapi.db.query(...), per this project's convention.
 */

const {
  kampalaToday, isIsoDate, addDays, approxDays, overlaps
} = require('../../../utils/epaper-dates');

const PUB = 'api::publication.publication';
const PLAN = 'api::epaper-plan.epaper-plan';
const EDITION = 'api::edition.edition';
const ENT = 'api::epaper-entitlement.epaper-entitlement';
const SEAT = 'api::epaper-org-seat.epaper-org-seat';

const FREQUENCIES = ['daily', 'weekend', 'weekly', 'monthly', 'quarterly', 'yearly', 'irregular'];
const DEFAULT_COVER_DAYS = { daily: 1, weekend: 2, weekly: 7 };
const UNITS = ['day', 'week', 'month', 'year'];
const KINDS = ['period', 'single_issue'];

class CatalogueError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const toInt = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const isWhole = (n) => Number.isInteger(n);

function toId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new CatalogueError(400, 'Invalid id');
  return n;
}

function normCode(v) {
  return String(v || '').trim().toUpperCase();
}

function publicPublication(p) {
  return {
    id: p.id,
    code: p.code,
    title: p.title,
    name: p.name,
    editionLabel: p.editionLabel || null,
    language: p.language || null,
    frequency: p.frequency,
    coverDays: p.coverDays || 1,
    scheduleNote: p.scheduleNote || null,
    colour: p.colour || null,
    description: p.description || null,
    active: p.active !== false,
    sortOrder: p.sortOrder ?? 0
  };
}

function isOnDay(plan, day) {
  if (plan.active === false) return false;
  if (plan.validFrom && plan.validFrom > day) return false;
  if (plan.validTo && plan.validTo < day) return false;
  return true;
}

function publicPlan(row) {
  const codes = (row.publications || []).map((p) => p.code).sort();
  return {
    id: row.id,
    key: row.key,
    version: row.version,
    label: row.label,
    description: row.description || null,
    kind: row.kind,
    durationUnit: row.kind === 'period' ? row.durationUnit : null,
    durationCount: row.kind === 'period' ? row.durationCount : null,
    price: row.price === null || row.price === undefined ? null : Number(row.price),
    currency: row.currency || 'UGX',
    publications: codes,
    revenueSplit: row.revenueSplit || null,
    active: row.active !== false,
    featured: row.featured !== false,
    validFrom: row.validFrom || null,
    validTo: row.validTo || null,
    sortOrder: row.sortOrder ?? 0
  };
}

module.exports = ({ strapi }) => {
  const q = (uid) => strapi.db.query(uid);

  async function allPublications() {
    return q(PUB).findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
  }

  async function publicationsByCode(codes) {
    const wanted = [...new Set(codes.map(normCode).filter(Boolean))];
    if (!wanted.length) return [];
    const rows = await q(PUB).findMany({ where: { code: { $in: wanted } } });
    const missing = wanted.filter((c) => !rows.some((r) => r.code === c));
    if (missing.length) throw new CatalogueError(400, `Unknown publication code(s): ${missing.join(', ')}`);
    return rows;
  }

  async function planRows(where = {}) {
    return q(PLAN).findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }, { version: 'desc' }],
      populate: { publications: { select: ['id', 'code'] } }
    });
  }

  /** The version of each plan key on sale on `day`. */
  function currentByKey(rows, day) {
    const out = new Map();
    for (const r of rows) {
      if (!isOnDay(r, day)) continue;
      const have = out.get(r.key);
      if (!have || r.version > have.version) out.set(r.key, r);
    }
    return out;
  }

  /** Latest published edition of a publication, or null. */
  async function latestEdition(publicationId, day) {
    const rows = await q(EDITION).findMany({
      where: {
        publication: { id: publicationId },
        pipelineStatus: 'published',
        publishedAt: { $notNull: true },
        date: { $lte: day }
      },
      orderBy: { date: 'desc' },
      limit: 1,
      select: ['id', 'documentId', 'date', 'coversFrom', 'coversTo', 'pageCount', 'volume', 'issueNumber', 'sku']
    });
    const e = rows[0];
    if (!e) return null;
    return {
      documentId: e.documentId,
      date: e.date,
      coversFrom: e.coversFrom || e.date,
      coversTo: e.coversTo || e.date,
      pageCount: e.pageCount ?? null,
      volume: e.volume || null,
      issueNumber: e.issueNumber || null,
      sku: e.sku || null
    };
  }

  // ---- revenue split ---------------------------------------------------------

  /**
   * Option A: proportional to each publication's own standard price per day.
   * Falls back to equal shares if any publication has no single-publication
   * period plan on sale. Always returns whole percents summing to 100.
   */
  async function suggestSplit(codesIn, day = kampalaToday()) {
    const codes = [...new Set(codesIn.map(normCode).filter(Boolean))].sort();
    if (!codes.length) return {};
    if (codes.length === 1) return { [codes[0]]: 100 };

    const current = [...currentByKey(await planRows({ kind: 'period' }), day).values()];
    const perDay = {};
    for (const code of codes) {
      const single = current
        .filter((p) => (p.publications || []).length === 1 && p.publications[0].code === code)
        .map((p) => ({ days: approxDays(p.durationUnit, p.durationCount), price: Number(p.price) }))
        .filter((p) => p.price > 0)
        .sort((a, b) => a.days - b.days)[0];
      if (single) perDay[code] = single.price / single.days;
    }
    const weights = codes.every((c) => perDay[c] > 0) ? codes.map((c) => perDay[c]) : codes.map(() => 1);
    return toPercents(codes, weights);
  }

  /** Largest-remainder rounding to whole percents that sum to exactly 100. */
  function toPercents(codes, weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    const raw = weights.map((w) => (w / total) * 100);
    const floors = raw.map(Math.floor);
    let left = 100 - floors.reduce((a, b) => a + b, 0);
    const order = raw.map((r, i) => ({ i, frac: r - floors[i] })).sort((a, b) => b.frac - a.frac);
    for (const { i } of order) {
      if (left <= 0) break;
      floors[i] += 1;
      left -= 1;
    }
    return Object.fromEntries(codes.map((c, i) => [c, floors[i]]));
  }

  function validateSplit(split, codes) {
    if (codes.length <= 1) return null;
    if (!split || typeof split !== 'object') throw new CatalogueError(400, 'revenueSplit is required for a plan with more than one publication');
    const keys = Object.keys(split).map(normCode).sort();
    if (keys.join(',') !== [...codes].sort().join(',')) {
      throw new CatalogueError(400, `revenueSplit must have exactly these publications: ${codes.join(', ')}`);
    }
    const clean = {};
    let sum = 0;
    for (const [k, v] of Object.entries(split)) {
      const n = Number(v);
      if (!isWhole(n) || n < 0 || n > 100) throw new CatalogueError(400, `revenueSplit for ${k} must be a whole percent from 0 to 100`);
      clean[normCode(k)] = n;
      sum += n;
    }
    if (sum !== 100) throw new CatalogueError(400, `revenueSplit must total 100% (it totals ${sum}%)`);
    return clean;
  }

  /** Split to apply at sale: the plan's own if valid, else the suggestion. */
  async function splitForSale(plan, day) {
    const codes = (plan.publications || []).map((p) => p.code);
    try {
      const own = validateSplit(plan.revenueSplit, codes);
      if (own) return own;
    } catch {
      strapi.log.warn(`[catalogue] plan ${plan.key} v${plan.version} has an invalid revenueSplit; using the suggested split`);
    }
    return suggestSplit(codes, day);
  }

  /** Splits `amount` by whole-percent shares; the shilling remainders go to the largest shares. */
  function allocate(amount, split) {
    const codes = Object.keys(split);
    const total = Number(amount) || 0;
    const exact = codes.map((c) => (total * split[c]) / 100);
    const floors = exact.map(Math.floor);
    let left = total - floors.reduce((a, b) => a + b, 0);
    const order = exact.map((e, i) => ({ i, frac: e - floors[i] })).sort((a, b) => b.frac - a.frac);
    for (const { i } of order) {
      if (left <= 0) break;
      floors[i] += 1;
      left -= 1;
    }
    return Object.fromEntries(codes.map((c, i) => [c, floors[i]]));
  }

  // ---- plan validation -------------------------------------------------------

  async function cleanPlanShape(body) {
    const kind = String(body.kind || '');
    if (!KINDS.includes(kind)) throw new CatalogueError(400, 'kind must be period or single_issue');
    const codes = Array.isArray(body.publications) ? body.publications.map(normCode).filter(Boolean) : [];
    if (!codes.length) throw new CatalogueError(400, 'Choose at least one publication');
    const pubs = await publicationsByCode(codes);
    if (kind === 'single_issue' && pubs.length !== 1) {
      throw new CatalogueError(400, 'A single-issue plan sells one edition of exactly one publication');
    }
    let durationUnit = null;
    let durationCount = null;
    if (kind === 'period') {
      durationUnit = String(body.durationUnit || 'month');
      if (!UNITS.includes(durationUnit)) throw new CatalogueError(400, 'durationUnit must be day, week, month or year');
      durationCount = toInt(body.durationCount) ?? 1;
      if (!isWhole(durationCount) || durationCount < 1 || durationCount > 120) {
        throw new CatalogueError(400, 'durationCount must be a whole number from 1 to 120');
      }
    }
    return { kind, pubs, codes: pubs.map((p) => p.code).sort(), durationUnit, durationCount };
  }

  function cleanPrice(v) {
    const price = toInt(v);
    if (price === null || !isWhole(price) || price < 0) throw new CatalogueError(400, 'price must be a whole number of shillings, 0 or more');
    return price;
  }

  function cleanDisplay(body, into = {}) {
    if (body.label !== undefined) {
      const label = String(body.label || '').trim();
      if (!label) throw new CatalogueError(400, 'label is required');
      into.label = label.slice(0, 120);
    }
    if (body.description !== undefined) into.description = body.description ? String(body.description).slice(0, 1000) : null;
    if (body.featured !== undefined) into.featured = body.featured !== false;
    if (body.sortOrder !== undefined) {
      const n = toInt(body.sortOrder) ?? 0;
      if (!isWhole(n)) throw new CatalogueError(400, 'sortOrder must be a whole number');
      into.sortOrder = n;
    }
    return into;
  }

  async function versionsOf(key) {
    const rows = await planRows({ key });
    if (!rows.length) throw new CatalogueError(404, `No plan "${key}"`);
    return rows; // version desc
  }

  function groupPlans(rows, day) {
    const byKey = new Map();
    for (const r of rows) {
      const list = byKey.get(r.key) || [];
      list.push(r);
      byKey.set(r.key, list);
    }
    const current = currentByKey(rows, day);
    return [...byKey.entries()].map(([key, versions]) => {
      const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
      const cur = current.get(key) || null;
      const upcoming = versions.filter((v) => v.active !== false && v.validFrom && v.validFrom > day);
      return {
        key,
        label: latest.label,
        kind: latest.kind,
        durationUnit: latest.kind === 'period' ? latest.durationUnit : null,
        durationCount: latest.kind === 'period' ? latest.durationCount : null,
        publications: (latest.publications || []).map((p) => p.code).sort(),
        onSale: Boolean(cur),
        featured: latest.featured !== false,
        sortOrder: latest.sortOrder ?? 0,
        current: cur ? publicPlan(cur) : null,
        upcoming: upcoming.map(publicPlan),
        versions: versions.sort((a, b) => b.version - a.version).map(publicPlan)
      };
    }).sort((a, b) => (a.sortOrder - b.sortOrder) || a.key.localeCompare(b.key));
  }

  // ---- access profile --------------------------------------------------------

  async function personalRows(userId) {
    const rows = await q(ENT).findMany({
      where: {
        user: { id: userId },
        scope: 'personal',
        revokedAt: { $null: true }
      },
      select: ['id', 'coverageStart', 'coverageEnd'],
      populate: { publication: { select: ['code'] } }
    });
    // Rows without a publication predate per-publication selling (test data only). They open nothing.
    return rows
      .filter((r) => r.publication?.code)
      .map((r) => ({ publication: r.publication.code, start: r.coverageStart, end: r.coverageEnd }));
  }

  async function orgProfile(userId) {
    const seat = await q(SEAT).findOne({
      where: { user: { id: userId }, active: true },
      populate: { organization: true }
    });
    const org = seat?.organization;
    if (!org?.id) return null;
    const orgStatus = org.status || (org.active === false ? 'suspended' : 'active');
    const legacy = seat.source === 'legacy';
    const base = {
      orgId: org.id,
      orgName: org.name,
      orgStatus,
      usable: orgStatus === 'active',
      role: seat.role || 'member',
      seatId: seat.id,
      legacy,
      // [] = reads nothing through the organisation; null (older seats) = everything it pays for
      seatPublications: Array.isArray(seat.publicationCodes) ? seat.publicationCodes.map(normCode) : null,
      contracts: [],
      memberWindows: legacy ? null : []
    };
    if (!base.usable) return base;

    const contracts = await q(ENT).findMany({
      where: {
        organization: { id: org.id },
        scope: 'org_contract',
        revokedAt: { $null: true }
      },
      select: ['id', 'coverageStart', 'coverageEnd', 'seats'],
      populate: { publication: { select: ['code'] } }
    });
    base.contracts = contracts
      .filter((c) => c.publication?.code)
      .map((c) => ({ publication: c.publication.code, start: c.coverageStart, end: c.coverageEnd }));

    if (!legacy) {
      const windows = await q(ENT).findMany({
        where: { organization: { id: org.id }, user: { id: userId }, scope: 'org_member', revokedAt: { $null: true } },
        select: ['coverageStart', 'coverageEnd']
      });
      base.memberWindows = windows.map((w) => ({ start: w.coverageStart, end: w.coverageEnd }));
    }
    return base;
  }

  // ---- public API ------------------------------------------------------------

  return {
    CatalogueError,
    suggestSplit,
    splitForSale,
    allocate,
    toPercents,

    // publications

    async listPublications({ includeInactive = true } = {}) {
      const day = kampalaToday();
      const pubs = (await allPublications()).filter((p) => includeInactive || p.active !== false);
      const plans = groupPlans(await planRows(), day);
      return {
        publications: await Promise.all(pubs.map(async (p) => ({
          ...publicPublication(p),
          latestEdition: await latestEdition(p.id, day),
          editionCount: await q(EDITION).count({ where: { publication: { id: p.id }, publishedAt: { $notNull: true } } }),
          planCount: plans.filter((g) => g.onSale && g.publications.includes(p.code)).length
        })))
      };
    },

    async createPublication(body, actorAdminId) {
      const code = normCode(body.code);
      if (!/^[A-Z0-9]{1,12}$/.test(code)) throw new CatalogueError(400, 'code must be 1–12 capital letters or digits, e.g. NV or BKW');
      if (await q(PUB).findOne({ where: { code } })) throw new CatalogueError(409, `Publication ${code} already exists`);
      const data = this.cleanPublication(body, { isCreate: true });
      const row = await q(PUB).create({ data: { ...data, code } });
      strapi.log.info(`[catalogue] publication ${code} created by handle admin ${actorAdminId || '?'}`);
      return { publication: publicPublication(row) };
    },

    async updatePublication(idRaw, body, actorAdminId) {
      const id = toId(idRaw);
      const pub = await q(PUB).findOne({ where: { id } });
      if (!pub) throw new CatalogueError(404, 'Publication not found');
      if (body.code !== undefined && normCode(body.code) !== pub.code) {
        throw new CatalogueError(409, 'A publication code cannot be changed: editions, links and sales already use it');
      }
      const data = this.cleanPublication(body, { isCreate: false });
      if (!Object.keys(data).length) throw new CatalogueError(400, 'Nothing to update');
      const row = await q(PUB).update({ where: { id }, data });
      if (data.coverDays !== undefined && data.coverDays !== pub.coverDays) {
        await this.recomputeCovers(id, data.coverDays);
      }
      strapi.log.info(`[catalogue] publication ${pub.code} updated by handle admin ${actorAdminId || '?'}: ${Object.keys(data).join(', ')}`);
      return { publication: publicPublication(row) };
    },

    cleanPublication(body, { isCreate }) {
      const data = {};
      for (const f of ['title', 'name']) {
        if (body[f] !== undefined || isCreate) {
          const v = String(body[f] || '').trim();
          if (!v) throw new CatalogueError(400, `${f} is required`);
          data[f] = v.slice(0, 120);
        }
      }
      for (const f of ['editionLabel', 'language', 'scheduleNote', 'colour', 'description']) {
        if (body[f] !== undefined) data[f] = body[f] ? String(body[f]).trim().slice(0, f === 'description' ? 1000 : 60) : null;
      }
      if (body.colour && !/^#[0-9a-fA-F]{6}$/.test(String(body.colour).trim())) throw new CatalogueError(400, 'colour must look like #2f55e4');
      if (body.frequency !== undefined || isCreate) {
        const f = String(body.frequency || 'daily');
        if (!FREQUENCIES.includes(f)) throw new CatalogueError(400, `frequency must be one of: ${FREQUENCIES.join(', ')}`);
        data.frequency = f;
      }
      if (body.coverDays !== undefined && body.coverDays !== null && body.coverDays !== '') {
        const n = Number(body.coverDays);
        if (!isWhole(n) || n < 1 || n > 366) throw new CatalogueError(400, 'coverDays must be a whole number from 1 to 366');
        data.coverDays = n;
      } else if (isCreate) {
        data.coverDays = DEFAULT_COVER_DAYS[data.frequency] || 1;
      }
      if (body.active !== undefined) data.active = body.active !== false;
      if (body.sortOrder !== undefined) {
        const n = toInt(body.sortOrder) ?? 0;
        if (!isWhole(n)) throw new CatalogueError(400, 'sortOrder must be a whole number');
        data.sortOrder = n;
      }
      return data;
    },

    /** Re-derives coversFrom/coversTo for every edition row of a publication. */
    async recomputeCovers(publicationId, coverDays) {
      const rows = await q(EDITION).findMany({ where: { publication: { id: publicationId } }, select: ['id', 'date'] });
      for (const r of rows) {
        if (!r.date) continue;
        await q(EDITION).update({ where: { id: r.id }, data: { coversFrom: r.date, coversTo: addDays(r.date, Math.max(1, coverDays) - 1) } });
      }
      return rows.length;
    },

    // plans

    async listPlans() {
      return { plans: groupPlans(await planRows(), kampalaToday()), today: kampalaToday() };
    },

    async createPlan(body, actorAdminId) {
      const key = String(body.key || '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_]{1,39}$/.test(key)) throw new CatalogueError(400, 'key must be 2–40 lower-case letters, digits or _, e.g. nv_month');
      if (await q(PLAN).count({ where: { key } })) throw new CatalogueError(409, `A plan with key "${key}" already exists`);
      const shape = await cleanPlanShape(body);
      const display = cleanDisplay(body, {});
      if (!display.label) throw new CatalogueError(400, 'label is required');
      const price = cleanPrice(body.price);
      const split = shape.codes.length > 1
        ? validateSplit(body.revenueSplit || (await suggestSplit(shape.codes)), shape.codes)
        : null;
      const validFrom = body.validFrom ? String(body.validFrom) : kampalaToday();
      if (!isIsoDate(validFrom)) throw new CatalogueError(400, 'validFrom must be YYYY-MM-DD');

      const row = await q(PLAN).create({
        data: {
          key, version: 1, ...display,
          kind: shape.kind, durationUnit: shape.durationUnit, durationCount: shape.durationCount,
          price, currency: String(body.currency || 'UGX').toUpperCase(),
          publications: shape.pubs.map((p) => p.id),
          revenueSplit: split, active: true, validFrom, validTo: null
        }
      });
      strapi.log.info(`[catalogue] plan ${key} v1 created by handle admin ${actorAdminId || '?'}`);
      return { plan: groupPlans(await versionsOf(row.key), kampalaToday())[0] };
    },

    /** Display-only changes apply to every version (they never change what was sold). */
    async updatePlanDisplay(key, body, actorAdminId) {
      const rows = await versionsOf(key);
      const data = cleanDisplay(body, {});
      if (!Object.keys(data).length) throw new CatalogueError(400, 'Nothing to update');
      for (const r of rows) await q(PLAN).update({ where: { id: r.id }, data });
      strapi.log.info(`[catalogue] plan ${key} display updated by handle admin ${actorAdminId || '?'}`);
      return { plan: groupPlans(await versionsOf(key), kampalaToday())[0] };
    },

    /**
     * New price and/or revenue split from `validFrom` (default today).
     * Earlier versions end the day before; versions that would have started
     * on or after validFrom are withdrawn.
     */
    async newPlanVersion(key, body, actorAdminId) {
      const rows = await versionsOf(key);
      const latest = rows[0];
      const codes = (latest.publications || []).map((p) => p.code).sort();
      const validFrom = body.validFrom ? String(body.validFrom) : kampalaToday();
      if (!isIsoDate(validFrom)) throw new CatalogueError(400, 'validFrom must be YYYY-MM-DD');
      if (validFrom < kampalaToday()) throw new CatalogueError(400, 'A new price cannot start in the past');

      const price = body.price !== undefined ? cleanPrice(body.price) : Number(latest.price);
      const split = codes.length > 1
        ? validateSplit(body.revenueSplit !== undefined ? body.revenueSplit : latest.revenueSplit, codes)
        : null;
      if (price === Number(latest.price) && JSON.stringify(split) === JSON.stringify(latest.revenueSplit || null) && body.validFrom === undefined) {
        throw new CatalogueError(400, 'Nothing changed: set a new price or revenue split');
      }

      const version = Math.max(...rows.map((r) => r.version || 1)) + 1;
      await strapi.db.transaction(async () => {
        for (const r of rows) {
          if (r.validFrom && r.validFrom >= validFrom) {
            // Would have started on or after the new version: withdrawn, never on sale.
            await q(PLAN).update({ where: { id: r.id }, data: { active: false } });
          } else if (!r.validTo || r.validTo >= validFrom) {
            await q(PLAN).update({ where: { id: r.id }, data: { validTo: addDays(validFrom, -1) } });
          }
        }
        await q(PLAN).create({
          data: {
            key, version,
            label: latest.label, description: latest.description, featured: latest.featured, sortOrder: latest.sortOrder,
            kind: latest.kind, durationUnit: latest.durationUnit, durationCount: latest.durationCount,
            price, currency: latest.currency || 'UGX',
            publications: (latest.publications || []).map((p) => p.id),
            revenueSplit: split, active: true, validFrom, validTo: null
          }
        });
      });
      strapi.log.info(`[catalogue] plan ${key} v${version} (from ${validFrom}) created by handle admin ${actorAdminId || '?'}`);
      return { plan: groupPlans(await versionsOf(key), kampalaToday())[0] };
    },

    /** Stop or resume selling. People who already paid keep their access. */
    async setPlanOnSale(key, onSale, actorAdminId) {
      const rows = await versionsOf(key);
      if (onSale) {
        const latest = rows[0];
        await q(PLAN).update({ where: { id: latest.id }, data: { active: true, validTo: null } });
      } else {
        for (const r of rows) await q(PLAN).update({ where: { id: r.id }, data: { active: false } });
      }
      strapi.log.info(`[catalogue] plan ${key} ${onSale ? 'resumed' : 'stopped'} by handle admin ${actorAdminId || '?'}`);
      return { plan: groupPlans(await versionsOf(key), kampalaToday())[0] };
    },

    /** The plan row to charge for `key` today, with publications populated. */
    async planForSale(key, day = kampalaToday()) {
      const rows = await planRows({ key: String(key || '') });
      return currentByKey(rows, day).get(String(key || '')) || null;
    },

    // reader-facing

    /** Plans on sale today, optionally only those that include `publication`. */
    async currentPlans({ publication } = {}) {
      const day = kampalaToday();
      const code = publication ? normCode(publication) : null;
      const current = [...currentByKey(await planRows(), day).values()]
        .map(publicPlan)
        .filter((p) => !code || p.publications.includes(code))
        .sort((a, b) => (a.sortOrder - b.sortOrder) || a.key.localeCompare(b.key));
      return { plans: current, today: day };
    },

    /** Everything the landing page draws: active publications, their latest
     * editions, and the featured plans on sale. */
    async storefront() {
      const day = kampalaToday();
      const pubs = (await allPublications()).filter((p) => p.active !== false);
      const publications = await Promise.all(pubs.map(async (p) => ({
        ...publicPublication(p),
        latestEdition: await latestEdition(p.id, day)
      })));
      const activeCodes = new Set(publications.map((p) => p.code));
      const plans = (await this.currentPlans()).plans
        .filter((p) => p.featured && p.publications.every((c) => activeCodes.has(c)));
      return { today: day, publications, plans };
    },

    /** Published editions of `publicationCode` on the given dates (for single-issue checkout). */
    async editionsFor(publicationCode, dates) {
      const code = normCode(publicationCode);
      const pub = await q(PUB).findOne({ where: { code } });
      if (!pub) throw new CatalogueError(400, `Unknown publication ${code}`);
      const wanted = [...new Set((dates || []).map(String))];
      if (wanted.some((d) => !isIsoDate(d))) throw new CatalogueError(400, 'Edition dates must be YYYY-MM-DD');
      const out = [];
      for (const d of wanted) {
        const rows = await q(EDITION).findMany({
          where: {
            publication: { id: pub.id }, pipelineStatus: 'published', publishedAt: { $notNull: true },
            $or: [{ date: d }, { coversFrom: { $lte: d }, coversTo: { $gte: d } }]
          },
          orderBy: { date: 'desc' },
          limit: 1,
          select: ['id', 'date', 'coversFrom', 'coversTo']
        });
        if (!rows[0]) throw new CatalogueError(404, `No published ${code} edition for ${d}`);
        if (!out.some((e) => e.id === rows[0].id)) out.push({ ...rows[0], publication: { id: pub.id, code } });
      }
      return out;
    },

    /**
     * One reader's access, in one call, for the middleware to cache briefly:
     *   personal: [{ publication, start, end }]
     *   org: null | { orgId, orgName, orgStatus, usable, role, seatId, legacy,
     *                 seatPublications: [codes] | null (= all paid publications),
     *                 contracts: [{ publication, start, end }],
     *                 memberWindows: [{ start, end }] | null (legacy seats) }
     */
    async accessProfile(userIdRaw) {
      const userId = toId(userIdRaw);
      const [personal, org] = await Promise.all([personalRows(userId), orgProfile(userId)]);
      return { userId, today: kampalaToday(), personal, org };
    },

    overlaps
  };
};
