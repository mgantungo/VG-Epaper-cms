'use strict';

/**
 * src/api/analytics/services/analytics-queries.js          NEW FILE (Phases 1–4)
 *
 * Every read behind the dashboards. Loaded by analytics-store.js, which
 * passes its helpers in `c`. Nothing here writes.
 *
 *   overview        handle › Analytics › Overview
 *   curve           handle › Analytics › Reader curve
 *   sections        handle › Analytics › Sections and stories
 *   readers         handle › Analytics › Readers (list)
 *   reader          handle › Analytics › Readers › one reader
 *   revenue         handle › Analytics › Revenue
 *   orgUsage        Usage tab: handle organisation page and web /organisation
 *                   (days and publications only)
 *
 * Who pays (for "paying readers"): personal entitlements, plus organisation
 * members whose seat reads the publication while the organisation's
 * contract for it and the member's own window cover the day — the same
 * rule the middleware uses to open editions.
 */

const { kampalaToday, addDays } = require('../../../utils/epaper-dates');

const HOUR = 3600 * 1000;
const kampalaDateOf = (d) => (d ? new Date(new Date(d).getTime() + 3 * HOUR).toISOString().slice(0, 10) : null);
const kampalaTimeOf = (ms) => new Date(Number(ms) + 3 * HOUR).toISOString().slice(0, 16).replace('T', ' ');

function median(list) {
  const a = list.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const minutes = (ms) => Math.round((Number(ms) || 0) / 6000) / 10;
const covers = (r, day) => r.start && r.end && r.start <= day && r.end >= day;
const overlapsRange = (r, from, to) => r.start && r.end && r.start <= to && r.end >= from;
const ACCESS_RANK = { personal: 3, organisation: 2, none: 1 };
const bestAccess = (a, b) => ((ACCESS_RANK[a] || 0) >= (ACCESS_RANK[b] || 0) ? a : b);

module.exports = (strapi, c) => {
  const { knex, q, range, previousRange, daysBetween, monthStart, monthEnd, addMonthsToMonth, pct, num } = c;
  const db = () => knex();

  // ---- shared loaders ----------------------------------------------------------

  /** Everything needed to say who pays for what on any day, loaded once. */
  async function payingIndex() {
    const ents = await q(c.ENT).findMany({
      where: { revokedAt: { $null: true }, scope: { $in: ['personal', 'org_contract', 'org_member'] } },
      select: ['id', 'scope', 'coverageStart', 'coverageEnd', 'seats'],
      populate: {
        publication: { select: ['code'] },
        user: { select: ['id'] },
        organization: { select: ['id'] }
      }
    });
    const seats = await q(c.SEAT).findMany({
      where: { active: true },
      select: ['id', 'source', 'publicationCodes', 'role'],
      populate: { user: { select: ['id'] }, organization: { select: ['id', 'name', 'status', 'active'] } }
    });
    const personal = [];
    const contracts = [];
    const windows = new Map(); // `${org}:${user}` -> [{start,end}]
    for (const e of ents) {
      const row = { start: e.coverageStart, end: e.coverageEnd, pub: e.publication?.code || null };
      if (e.scope === 'personal' && row.pub && e.user?.id) personal.push({ ...row, userId: e.user.id });
      else if (e.scope === 'org_contract' && row.pub && e.organization?.id) contracts.push({ ...row, orgId: e.organization.id, seats: e.seats || 0 });
      else if (e.scope === 'org_member' && e.organization?.id && e.user?.id) {
        const k = `${e.organization.id}:${e.user.id}`;
        if (!windows.has(k)) windows.set(k, []);
        windows.get(k).push(row);
      }
    }
    const members = seats
      .filter((s) => s.user?.id && s.organization?.id)
      .map((s) => ({
        seatId: s.id,
        userId: s.user.id,
        orgId: s.organization.id,
        orgName: s.organization.name,
        orgUsable: (s.organization.status || (s.organization.active === false ? 'suspended' : 'active')) === 'active',
        legacy: s.source === 'legacy',
        codes: Array.isArray(s.publicationCodes) ? s.publicationCodes.map((x) => String(x).toUpperCase()) : null
      }));

    /** { [pub]: { personal:Set<userId>, org:Set<userId> } } on `day`. */
    function payingOn(day) {
      const out = {};
      const slot = (p) => (out[p] ||= { personal: new Set(), org: new Set() });
      for (const r of personal) if (covers(r, day)) slot(r.pub).personal.add(r.userId);
      const orgPubs = new Map();
      for (const r of contracts) {
        if (!covers(r, day)) continue;
        if (!orgPubs.has(r.orgId)) orgPubs.set(r.orgId, new Set());
        orgPubs.get(r.orgId).add(r.pub);
      }
      for (const m of members) {
        if (!m.orgUsable) continue;
        const pubs = orgPubs.get(m.orgId);
        if (!pubs) continue;
        if (!m.legacy && !(windows.get(`${m.orgId}:${m.userId}`) || []).some((w) => covers(w, day))) continue;
        for (const p of pubs) if (!m.codes || m.codes.includes(p)) slot(p).org.add(m.userId);
      }
      return out;
    }
    return { personal, contracts, members, windows, payingOn };
  }

  function emptyFill(dates, codes) {
    return Object.fromEntries(codes.map((cd) => [cd, dates.map(() => 0)]));
  }

  // ---- overview ----------------------------------------------------------------

  async function overview(query = {}) {
    const r = range(query);
    const prev = previousRange(r);
    const pubs = await c.publicationList();
    const codes = pubs.map((p) => p.code);
    const dates = daysBetween(r.from, r.to);
    const prevDates = daysBetween(prev.from, prev.to);

    // daily active readers, per publication and overall
    const perPubDay = await db()('ana_reader_day')
      .select('local_date', 'publication')
      .countDistinct({ n: 'reader_key' })
      .whereBetween('local_date', [prev.from, r.to])
      .whereNot('publication', '')
      .groupBy('local_date', 'publication');
    const totalDay = await db()('ana_reader_day')
      .select('local_date')
      .countDistinct({ n: 'reader_key' })
      .whereBetween('local_date', [prev.from, r.to])
      .groupBy('local_date');
    const dIdx = new Map(dates.map((d, i) => [d, i]));
    const pIdx = new Map(prevDates.map((d, i) => [d, i]));
    const series = emptyFill(dates, codes);
    const total = dates.map(() => 0);
    const previousTotal = prevDates.map(() => 0);
    for (const row of perPubDay) {
      if (dIdx.has(row.local_date) && series[row.publication]) series[row.publication][dIdx.get(row.local_date)] = num(row.n);
    }
    for (const row of totalDay) {
      if (dIdx.has(row.local_date)) total[dIdx.get(row.local_date)] = num(row.n);
      if (pIdx.has(row.local_date)) previousTotal[pIdx.get(row.local_date)] = num(row.n);
    }

    const nowF = await readerDayFacts(r.from, r.to, dates.length);
    const prevF = await readerDayFacts(prev.from, prev.to, prevDates.length);

    const facts = (f) => ({
      dailyActiveAvg: f.days ? Math.round(f.readerDays / f.days) : 0,
      activeReaders: f.readers,
      minutesPerReader: f.readers ? Math.round(f.ms / f.readers / 60000) : 0,
      stickiness: f.readers && f.days ? pct(f.readerDays / f.days, f.readers) : 0,
      pagesRead: f.pagesRead,
      signedIn: f.signedIn,
      anonymous: f.readers - f.signedIn
    });

    // paying readers on the last day of the range
    const idx = await payingIndex();
    const payNow = idx.payingOn(r.to);
    const paying = codes.map((cd) => {
      const s = payNow[cd] || { personal: new Set(), org: new Set() };
      const all = new Set([...s.personal, ...s.org]);
      return { code: cd, total: all.size, personal: s.personal.size, org: [...s.org].filter((u) => !s.personal.has(u)).length };
    });

    // 12 months: active readers per publication, and paying flow
    const lastMonth = r.to.slice(0, 7);
    const months = Array.from({ length: 12 }, (_, i) => addMonthsToMonth(lastMonth, i - 11));
    const monthRows = await db()('ana_reader_day')
      .select(db().raw('substr(local_date, 1, 7) as ym'), 'publication')
      .countDistinct({ n: 'reader_key' })
      .whereBetween('local_date', [`${months[0]}-01`, monthEnd(`${lastMonth}-01`)])
      .groupByRaw('substr(local_date, 1, 7), publication');
    const monthTotalRows = await db()('ana_reader_day')
      .select(db().raw('substr(local_date, 1, 7) as ym'))
      .countDistinct({ n: 'reader_key' })
      .whereBetween('local_date', [`${months[0]}-01`, monthEnd(`${lastMonth}-01`)])
      .groupByRaw('substr(local_date, 1, 7)');
    const mIdx = new Map(months.map((m, i) => [m, i]));
    const monthly = { months, series: emptyFill(months, codes), total: months.map(() => 0) };
    for (const row of monthRows) {
      if (row.publication && mIdx.has(row.ym) && monthly.series[row.publication]) monthly.series[row.publication][mIdx.get(row.ym)] = num(row.n);
    }
    for (const row of monthTotalRows) if (mIdx.has(row.ym)) monthly.total[mIdx.get(row.ym)] = num(row.n);

    const today = kampalaToday();
    const ends = [addMonthsToMonth(months[0], -1), ...months].map((m) => {
      const e = monthEnd(`${m}-01`);
      return e > today ? today : e;
    });
    const sets = ends.map((d) => idx.payingOn(d));
    const flow = { months, byPub: {}, net: months.map(() => 0) };
    for (const cd of codes) {
      const nw = [];
      const lapsed = [];
      for (let i = 1; i < sets.length; i += 1) {
        const before = new Set([...(sets[i - 1][cd]?.personal || []), ...(sets[i - 1][cd]?.org || [])]);
        const after = new Set([...(sets[i][cd]?.personal || []), ...(sets[i][cd]?.org || [])]);
        nw.push([...after].filter((u) => !before.has(u)).length);
        lapsed.push([...before].filter((u) => !after.has(u)).length);
        flow.net[i - 1] += nw[nw.length - 1] - lapsed[lapsed.length - 1];
      }
      flow.byPub[cd] = { new: nw, lapsed };
    }

    // who is reading: best access each reader had per publication in range
    const accRows = await db()('ana_reader_day')
      .select('publication', 'reader_key', 'access_via')
      .whereBetween('local_date', [r.from, r.to])
      .whereNot('publication', '');
    const perPub = new Map();
    for (const row of accRows) {
      if (!perPub.has(row.publication)) perPub.set(row.publication, new Map());
      const m = perPub.get(row.publication);
      m.set(row.reader_key, bestAccess(m.get(row.reader_key), row.access_via || 'none'));
    }
    const who = codes.map((cd) => {
      const m = perPub.get(cd) || new Map();
      const n = m.size;
      const cnt = { personal: 0, organisation: 0, none: 0 };
      for (const v of m.values()) cnt[v in cnt ? v : 'none'] += 1;
      return { code: cd, readers: n, personal: cnt.personal, organisation: cnt.organisation, preview: cnt.none, personalPct: pct(cnt.personal, n), organisationPct: pct(cnt.organisation, n), previewPct: pct(cnt.none, n) };
    });
    let crossSell = null;
    for (const a of codes) {
      const ma = perPub.get(a);
      if (!ma) continue;
      for (const b of codes) {
        if (a === b || !perPub.get(b)) continue;
        const mb = perPub.get(b);
        let n = 0;
        for (const [k, v] of ma) if (v === 'none' && ['personal', 'organisation'].includes(mb.get(k))) n += 1;
        if (n && (!crossSell || n > crossSell.readers)) crossSell = { previewing: a, payingFor: b, readers: n };
      }
    }

    // hour of day (Kampala) — distinct readers per hour, per publication
    const hourRows = await db()('ana_events')
      .select('local_hour', 'publication')
      .countDistinct({ n: 'reader_key' })
      .whereBetween('local_date', [r.from, r.to])
      .whereIn('type', ['page.view', 'edition.open', 'story.open'])
      .whereNotNull('publication')
      .groupBy('local_hour', 'publication');
    const hours = { hours: Array.from({ length: 24 }, (_, i) => i), series: emptyFill(Array(24).fill(0), codes) };
    for (const row of hourRows) if (hours.series[row.publication]) hours.series[row.publication][num(row.local_hour)] = num(row.n);

    // per publication totals in range
    const pubTotals = await db()('ana_reader_day')
      .select('publication')
      .countDistinct({ readers: 'reader_key' })
      .sum({ pages: 'pages_read', ms: 'read_ms', stories: 'stories' })
      .whereBetween('local_date', [r.from, r.to])
      .whereNot('publication', '')
      .groupBy('publication');
    const byPublication = codes.map((cd) => {
      const t = pubTotals.find((x) => x.publication === cd) || {};
      return { code: cd, readers: num(t.readers), pagesRead: num(t.pages), minutes: Math.round(num(t.ms) / 60000), stories: num(t.stories) };
    });

    // devices (distinct readers)
    const devRows = await db()('ana_events')
      .select('device')
      .countDistinct({ n: 'reader_key' })
      .whereBetween('local_date', [r.from, r.to])
      .groupBy('device');
    const devices = devRows.map((d) => ({ device: d.device || 'unknown', readers: num(d.n) })).sort((a, b) => b.readers - a.readers);

    const atRisk = (await orgSeatUse({ idx, asOf: r.to > today ? today : r.to }))
      .filter((x) => x.end >= today)
      .sort((a, b) => a.usePct - b.usePct || a.end.localeCompare(b.end))
      .slice(0, 8);

    return {
      range: r,
      previous: prev,
      publications: pubs,
      kpis: { now: facts(nowF), previous: facts(prevF) },
      paying,
      daily: { dates, series, total, previousTotal },
      monthly,
      flow,
      who,
      crossSell,
      hours,
      byPublication,
      devices,
      atRisk
    };
  }

  async function readerDayFacts(from, to, days) {
    const rows = await db()('ana_reader_day')
      .select('local_date', 'reader_key')
      .max({ uid: 'user_id' })
      .sum({ ms: 'read_ms', pages: 'pages_read' })
      .whereBetween('local_date', [from, to])
      .groupBy('local_date', 'reader_key');
    const readers = new Set();
    const signed = new Set();
    let ms = 0;
    let pagesRead = 0;
    for (const row of rows) {
      readers.add(row.reader_key);
      if (row.uid) signed.add(row.reader_key);
      ms += num(row.ms);
      pagesRead += num(row.pages);
    }
    return { readers: readers.size, signedIn: signed.size, readerDays: rows.length, ms, pagesRead, days };
  }

  /** Current/at-date organisation contracts with how many of their seats opened the paper in the 30 days to asOf. */
  async function orgSeatUse({ idx, asOf, orgId = null, from = null, to = null }) {
    const lookFrom = from || addDays(asOf, -29);
    const lookTo = to || asOf;
    const list = idx.contracts.filter((k) => (orgId ? k.orgId === orgId : true) && (from ? overlapsRange(k, from, to) : covers(k, asOf) || k.start > asOf));
    if (!list.length) return [];
    const memberIds = [...new Set(idx.members.map((m) => m.userId))];
    const opened = memberIds.length
      ? await db()('ana_reader_day').distinct('user_id', 'publication').whereIn('user_id', memberIds).whereBetween('local_date', [lookFrom, lookTo]).whereNot('publication', '').where('editions', '>', 0)
      : [];
    const openedSet = new Set(opened.map((o) => `${o.user_id}:${o.publication}`));
    const orgNames = await c.orgsById(list.map((k) => k.orgId));
    return list.map((k) => {
      const holders = idx.members.filter((m) => m.orgId === k.orgId && (!m.codes || m.codes.includes(k.pub)));
      const used = holders.filter((m) => openedSet.has(`${m.userId}:${k.pub}`)).length;
      return {
        orgId: k.orgId,
        orgName: orgNames.get(k.orgId)?.name || `Organisation ${k.orgId}`,
        publication: k.pub,
        start: k.start,
        end: k.end,
        seats: k.seats,
        holders: holders.length,
        used,
        usePct: pct(used, k.seats || holders.length)
      };
    });
  }

  // ---- reader curve ----------------------------------------------------------------

  async function latestEditionWithReaders(pub) {
    const row = await db()('ana_page_day').select('edition_date').where('publication', pub).orderBy('edition_date', 'desc').first();
    return row?.edition_date || null;
  }

  async function editionMeta(pub, date) {
    // the published version first (Strapi keeps a draft row too; pages hang off the published one)
    const ed = (await q(c.EDITION).findOne({
      where: { publicationCode: pub, date, publishedAt: { $notNull: true } },
      select: ['id', 'date', 'coversFrom', 'coversTo']
    })) || (await q(c.EDITION).findOne({
      where: { publicationCode: pub, date },
      select: ['id', 'date', 'coversFrom', 'coversTo']
    }));
    if (!ed) return { id: null, pages: 0, sections: {} };
    const pages = await q('api::page.page').findMany({ where: { edition: { id: ed.id } }, select: ['pageNumber', 'section'] });
    const sections = {};
    for (const p of pages) if (p.pageNumber) sections[p.pageNumber] = p.section || null;
    return { id: ed.id, coversFrom: ed.coversFrom || date, coversTo: ed.coversTo || date, pages: pages.length, sections };
  }

  async function editionCurve(pub, date) {
    const meta = await editionMeta(pub, date);
    const ev = await db()('ana_events')
      .select('type', 'reader_key', 'page_number', 'dwell_ms', 'local_date', 'local_hour', 'occurred_at', 'locked', 'session_id', 'meta')
      .where({ publication: pub, edition_date: date })
      .whereIn('type', ['edition.open', 'page.view', 'story.open']);
    const pageCount = Math.max(meta.pages, ...ev.map((e) => num(e.page_number)), 0);

    const opened = new Set();
    const preview = new Set();
    const deepest = new Map();
    const timeIn = new Map();
    const pageReaders = Array.from({ length: pageCount }, () => new Set());
    const firstSeen = new Map(); // reader -> {date, hour, ms}
    const dayReaders = new Map(); // offset -> Set
    const archiveSessions = new Set();
    const searchSessions = new Set();
    const startDay = meta.coversFrom || date;

    for (const e of ev) {
      const locked = e.locked === true || e.locked === 1;
      if (locked) {
        preview.add(e.reader_key);
        continue;
      }
      opened.add(e.reader_key);
      const f = firstSeen.get(e.reader_key);
      if (!f || num(e.occurred_at) < f.ms) firstSeen.set(e.reader_key, { ms: num(e.occurred_at), date: e.local_date, hour: num(e.local_hour) });
      const off = daysBetween(startDay, e.local_date).length - 1;
      if (e.local_date >= startDay && off <= 13) {
        if (!dayReaders.has(off)) dayReaders.set(off, new Set());
        dayReaders.get(off).add(e.reader_key);
      }
      if (e.type === 'page.view') {
        timeIn.set(e.reader_key, (timeIn.get(e.reader_key) || 0) + num(e.dwell_ms));
        if (num(e.dwell_ms) >= c.READ_MS && e.page_number >= 1 && e.page_number <= pageCount) {
          pageReaders[e.page_number - 1].add(e.reader_key);
          deepest.set(e.reader_key, Math.max(deepest.get(e.reader_key) || 0, e.page_number));
        }
      }
      if (e.type === 'edition.open' && e.local_date > (meta.coversTo || date)) {
        archiveSessions.add(e.session_id);
        try {
          const m = e.meta ? JSON.parse(e.meta) : null;
          if (m && m.via === 'search') searchSessions.add(e.session_id);
        } catch { /* ignore */ }
      }
    }
    const n = opened.size;
    const depth = pageReaders.map((s) => s.size);
    const depthPct = depth.map((x) => pct(x, n));

    const sectionStarts = [];
    let prevSection = null;
    for (let p = 1; p <= pageCount; p += 1) {
      const s = meta.sections[p] || null;
      if (s && s !== prevSection) sectionStarts.push({ page: p, section: s });
      prevSection = s || prevSection;
    }
    const drops = [];
    for (let p = 1; p < pageCount; p += 1) {
      if (depth[p - 1] > 0) drops.push({ page: p + 1, change: Math.round(((depth[p] - depth[p - 1]) / depth[p - 1]) * 100) });
    }
    drops.sort((a, b) => a.change - b.change);

    // pickup on release day, by hour of first open
    const byHour = Array(24).fill(0);
    let releaseDayReaders = 0;
    for (const f of firstSeen.values()) {
      if (f.date !== startDay) continue;
      byHour[f.hour] += 1;
      releaseDayReaders += 1;
    }
    const cumulative = [];
    let run = 0;
    for (let h = 0; h < 24; h += 1) {
      run += byHour[h];
      cumulative.push(pct(run, releaseDayReaders));
    }
    const halfHour = cumulative.findIndex((x) => x >= 50);
    let halfBy = null;
    if (halfHour >= 0) {
      const before = halfHour ? cumulative[halfHour - 1] : 0;
      const span = cumulative[halfHour] - before || 1;
      const mins = Math.round(((50 - before) / span) * 60);
      halfBy = `${String(halfHour).padStart(2, '0')}:${String(Math.min(59, mins)).padStart(2, '0')}`;
    }
    const peak = byHour.indexOf(Math.max(...byHour));
    const evening = byHour.slice(18).reduce((a, b) => a + b, 0);
    const firstHour = byHour[5] || 0;

    const life = Array.from({ length: 14 }, (_, i) => (dayReaders.get(i) || new Set()).size);
    const day0 = life[0];
    const later = new Set();
    for (const [off, s] of dayReaders) if (off > 0) for (const k of s) later.add(k);
    let halfLife = null;
    if (day0) {
      for (let i = 1; i < life.length; i += 1) {
        if (life[i] <= day0 / 2) {
          const a = life[i - 1];
          const b = life[i];
          halfLife = Math.round((i - 1 + (a - day0 / 2) / ((a - b) || 1)) * 10) / 10;
          break;
        }
      }
    }
    const singleSales = meta.id
      ? await q(c.ENT).count({ where: { edition: { id: meta.id }, scope: 'personal', revokedAt: { $null: true } } })
      : 0;

    return {
      publication: pub,
      date,
      coversFrom: meta.coversFrom || date,
      coversTo: meta.coversTo || date,
      pages: pageCount,
      sections: meta.sections,
      sectionStarts,
      readers: n,
      previewReaders: [...preview].filter((k) => !opened.has(k)).length,
      depth,
      depthPct,
      biggestDrops: drops.filter((d) => d.change < 0).slice(0, 3),
      medianDepth: median([...deepest.values()]),
      reachedLast: pct([...deepest.values()].filter((d) => d >= pageCount).length, n),
      medianMinutes: minutes(median([...timeIn.values()])),
      pickup: {
        byHour,
        cumulative,
        firstHourPct: pct(firstHour, releaseDayReaders),
        halfBy,
        peakHour: releaseDayReaders ? `${String(peak).padStart(2, '0')}:00` : null,
        eveningPct: pct(evening, releaseDayReaders)
      },
      life: {
        days: life,
        laterPct: pct([...later].filter((k) => !(dayReaders.get(0) || new Set()).has(k)).length, n),
        halfLifeDays: halfLife,
        singleSales,
        fromSearchPct: pct(searchSessions.size, archiveSessions.size)
      }
    };
  }

  /**
   * Average share of readers on each page over the last `count` editions
   * before `date`, measured exactly like editionCurve (readers who read the
   * page for 3 s or more ÷ readers who opened the edition with access).
   */
  async function averageDepth(pub, date, count = 30) {
    const eds = await db()('ana_page_day').distinct('edition_date').where('publication', pub).where('edition_date', '<', date).orderBy('edition_date', 'desc').limit(count);
    if (!eds.length) return { editions: 0, depthPct: [] };
    const list = eds.map((e) => e.edition_date);
    const unlocked = (b) => b.whereNull('locked').orWhere('locked', false);
    const opened = await db()('ana_events')
      .select('edition_date')
      .countDistinct({ n: 'reader_key' })
      .where('publication', pub)
      .whereIn('edition_date', list)
      .whereIn('type', ['edition.open', 'page.view', 'story.open'])
      .where(unlocked)
      .groupBy('edition_date');
    const rows = await db()('ana_events')
      .select('edition_date', 'page_number')
      .countDistinct({ n: 'reader_key' })
      .where({ publication: pub, type: 'page.view' })
      .whereIn('edition_date', list)
      .where('dwell_ms', '>=', c.READ_MS)
      .where(unlocked)
      .groupBy('edition_date', 'page_number');
    const openedBy = new Map(opened.map((o) => [o.edition_date, num(o.n)]));
    const maxPage = Math.max(0, ...rows.map((r) => num(r.page_number)));
    const sums = Array(maxPage).fill(0);
    const counts = Array(maxPage).fill(0);
    for (const r of rows) {
      const n = openedBy.get(r.edition_date);
      if (!n || !r.page_number) continue;
      sums[r.page_number - 1] += (num(r.n) / n) * 100;
      counts[r.page_number - 1] += 1;
    }
    const used = [...openedBy.values()].filter(Boolean).length;
    return { editions: used, depthPct: sums.map((v, i) => (counts[i] ? Math.round((v / counts[i]) * 10) / 10 : null)) };
  }

  /** query.editions = "NV:2026-10-22,BK:2026-10-22" (1–3). Default: the latest read edition of the first two publications. */
  async function curve(query = {}) {
    const pubs = await c.publicationList();
    let wanted = String(query.editions || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [p, d] = s.split(':');
        return { pub: c.normPub(p), date: d };
      })
      .filter((x) => x.pub && /^\d{4}-\d{2}-\d{2}$/.test(x.date || ''))
      .slice(0, 3);
    if (!wanted.length) {
      for (const p of pubs) {
        const d = await latestEditionWithReaders(p.code);
        if (d) wanted.push({ pub: p.code, date: d });
        if (wanted.length === 2) break;
      }
    }
    const editions = [];
    for (const w of wanted) {
      const cur = await editionCurve(w.pub, w.date);
      cur.average = await averageDepth(w.pub, w.date, 30);
      editions.push(cur);
    }
    const recent = {};
    for (const p of pubs) {
      const rows = await db()('ana_page_day').distinct('edition_date').where('publication', p.code).orderBy('edition_date', 'desc').limit(60);
      recent[p.code] = rows.map((r) => r.edition_date);
    }
    return { publications: pubs, editions, recentEditions: recent };
  }

  // ---- sections and stories -----------------------------------------------------

  async function sections(query = {}) {
    const r = range(query);
    const pubs = await c.publicationList();
    const pub = c.normPub(query.publication) || pubs[0]?.code;
    const base = () => db()('ana_events')
      .where({ type: 'page.view', publication: pub })
      .whereBetween('local_date', [r.from, r.to])
      .where('dwell_ms', '>=', c.READ_MS)
      // front-page previews by readers without access are not reading a section
      .where((b) => b.whereNull('locked').orWhere('locked', false));

    const perReader = await base()
      .select(db().raw("COALESCE(section, '') as section"), 'reader_key')
      .max({ uid: 'user_id', org: 'org_id', via: 'access_via' })
      .sum({ ms: 'dwell_ms' })
      .groupByRaw("COALESCE(section, ''), reader_key");
    const bySection = new Map();
    for (const row of perReader) {
      const s = row.section || 'Unlabelled';
      if (!bySection.has(s)) bySection.set(s, []);
      bySection.get(s).push(row);
    }
    const list = [...bySection.entries()]
      .map(([name, rows]) => ({ name, readers: rows.length, medianMinutes: minutes(median(rows.map((x) => num(x.ms)))), totalMinutes: Math.round(rows.reduce((a, x) => a + num(x.ms), 0) / 60000) }))
      .sort((a, b) => b.readers - a.readers);

    const chosen = query.section && bySection.has(String(query.section)) ? String(query.section) : list[0]?.name || null;
    let whoRead = null;
    if (chosen) {
      const rows = bySection.get(chosen);
      const cnt = { personal: 0, organisation: 0, none: 0 };
      const orgs = new Map();
      for (const x of rows) {
        cnt[x.via in cnt ? x.via : 'none'] += 1;
        if (x.org) {
          const o = orgs.get(x.org) || { members: 0, ms: 0 };
          o.members += 1;
          o.ms += num(x.ms);
          orgs.set(x.org, o);
        }
      }
      const orgNames = await c.orgsById([...orgs.keys()]);
      const top = rows.filter((x) => x.uid).sort((a, b) => num(b.ms) - num(a.ms)).slice(0, 10);
      const users = await c.usersById(top.map((x) => x.uid));
      const topOrgs = await c.orgsById(top.map((x) => x.org));
      whoRead = {
        section: chosen,
        readers: rows.length,
        personalPct: pct(cnt.personal, rows.length),
        organisationPct: pct(cnt.organisation, rows.length),
        previewPct: pct(cnt.none, rows.length),
        organisations: [...orgs.entries()]
          .map(([id, o]) => ({ orgId: id, name: orgNames.get(id)?.name || `Organisation ${id}`, members: o.members, minutes: Math.round(o.ms / 60000) }))
          .sort((a, b) => b.minutes - a.minutes)
          .slice(0, 10),
        topReaders: top.map((x) => ({
          userId: x.uid,
          name: users.get(x.uid)?.displayName || users.get(x.uid)?.email || `Reader ${x.uid}`,
          email: users.get(x.uid)?.email || null,
          via: x.org ? topOrgs.get(x.org)?.name || 'organisation' : x.via === 'personal' ? 'personal' : 'not paying',
          minutes: Math.round(num(x.ms) / 60000)
        }))
      };
    }

    // heatmap: section × day distinct readers
    const heatRows = await base()
      .select(db().raw("COALESCE(section, '') as section"), 'local_date')
      .countDistinct({ n: 'reader_key' })
      .groupByRaw("COALESCE(section, ''), local_date");
    const dates = daysBetween(r.from, r.to);
    const dI = new Map(dates.map((d, i) => [d, i]));
    const heat = list.slice(0, 12).map((s) => ({ name: s.name, values: dates.map(() => 0) }));
    const hI = new Map(heat.map((h, i) => [h.name, i]));
    for (const row of heatRows) {
      const name = row.section || 'Unlabelled';
      if (hI.has(name) && dI.has(row.local_date)) heat[hI.get(name)].values[dI.get(row.local_date)] = num(row.n);
    }

    // most-read stories
    const storyRows = await db()('ana_story_day')
      .select('story_id')
      .max({ edition_date: 'edition_date' })
      .sum({ opens: 'opens', readers: 'readers' })
      .where('publication', pub)
      .whereBetween('local_date', [r.from, r.to])
      .groupBy('story_id')
      .orderBy('opens', 'desc')
      .limit(20);
    const ids = storyRows.map((s) => s.story_id);
    const meta = await c.storiesById(ids);
    const dwellRows = ids.length
      ? await db()('ana_events').select('story_id', 'dwell_ms').where({ type: 'story.open', publication: pub }).whereIn('story_id', ids).whereBetween('local_date', [r.from, r.to])
      : [];
    const dw = new Map();
    for (const d of dwellRows) {
      if (!dw.has(d.story_id)) dw.set(d.story_id, []);
      if (d.dwell_ms !== null) dw.get(d.story_id).push(num(d.dwell_ms));
    }
    const stories = storyRows.map((s, i) => ({
      rank: i + 1,
      storyId: s.story_id,
      headline: meta.get(s.story_id)?.headline || '(story removed)',
      editionDate: s.edition_date,
      page: meta.get(s.story_id)?.page?.pageNumber || null,
      section: meta.get(s.story_id)?.page?.section || null,
      opens: num(s.opens),
      readers: num(s.readers),
      medianSeconds: Math.round(median(dw.get(s.story_id) || []) / 1000)
    }));

    return { range: r, publications: pubs, publication: pub, sections: list, whoRead, heatmap: { dates, rows: heat }, stories };
  }

  // ---- readers -----------------------------------------------------------------

  async function readers(query = {}) {
    const r = range(query);
    const pub = c.normPub(query.publication);
    const pageSize = Math.min(200, Math.max(10, Number(query.pageSize) || 50));
    const page = Math.max(1, Number(query.page) || 1);
    const idx = await payingIndex();
    const memberOf = new Map(idx.members.map((m) => [m.userId, m]));

    let userFilter = null;
    if (query.q) {
      const term = String(query.q).trim();
      const found = await q(c.USER).findMany({
        where: { $or: [{ email: { $containsi: term } }, { displayName: { $containsi: term } }] },
        select: ['id'],
        limit: 500
      });
      userFilter = found.map((u) => u.id);
      if (!userFilter.length) return { range: r, total: 0, page, pageSize, readers: [], anonymous: null };
    }
    const orgId = Number(query.org) || null;
    if (orgId) {
      const ids = idx.members.filter((m) => m.orgId === orgId).map((m) => m.userId);
      userFilter = userFilter ? userFilter.filter((u) => ids.includes(u)) : ids;
      if (!userFilter.length) return { range: r, total: 0, page, pageSize, readers: [], anonymous: null };
    }

    let qb = db()('ana_reader_day')
      .select('user_id')
      .countDistinct({ days: 'local_date' })
      .sum({ editions: 'editions', pages: 'pages_read', ms: 'read_ms', stories: 'stories' })
      .max({ last: 'local_date' })
      .whereNotNull('user_id')
      .whereBetween('local_date', [r.from, r.to])
      .groupBy('user_id');
    if (pub) qb = qb.whereIn('publication', [pub, '']);
    if (userFilter) qb = qb.whereIn('user_id', userFilter);
    let rows = await qb;

    const type = query.type;
    if (type === 'organisation') rows = rows.filter((x) => memberOf.has(x.user_id));
    if (type === 'personal') rows = rows.filter((x) => !memberOf.has(x.user_id));

    const pubRows = rows.length
      ? await db()('ana_reader_day')
        .distinct('user_id', 'publication')
        .whereIn('user_id', rows.map((x) => x.user_id))
        .whereBetween('local_date', [r.from, r.to])
        .whereNot('publication', '')
        .where('editions', '>', 0)
      : [];
    const readPubs = new Map();
    for (const p of pubRows) {
      if (!readPubs.has(p.user_id)) readPubs.set(p.user_id, []);
      readPubs.get(p.user_id).push(p.publication);
    }

    const sortKey = { days: 'days', minutes: 'ms', pages: 'pages', last: 'last' }[query.sort] || 'ms';
    rows.sort((a, b) => (sortKey === 'last' ? String(b.last).localeCompare(String(a.last)) : num(b[sortKey]) - num(a[sortKey])));
    const total = rows.length;
    const slice = rows.slice((page - 1) * pageSize, page * pageSize);
    const users = await c.usersById(slice.map((x) => x.user_id));
    const paying = idx.payingOn(r.to > kampalaToday() ? kampalaToday() : r.to);

    const list = slice.map((x) => {
      const m = memberOf.get(x.user_id);
      const pays = Object.entries(paying).filter(([, s]) => s.personal.has(x.user_id) || s.org.has(x.user_id)).map(([cd]) => cd);
      return {
        userId: x.user_id,
        name: users.get(x.user_id)?.displayName || null,
        email: users.get(x.user_id)?.email || null,
        organisation: m ? { id: m.orgId, name: m.orgName } : null,
        pays,
        publications: (readPubs.get(x.user_id) || []).sort(),
        daysActive: num(x.days),
        editions: num(x.editions),
        pagesRead: num(x.pages),
        minutes: Math.round(num(x.ms) / 60000),
        stories: num(x.stories),
        lastActive: x.last
      };
    });

    let anonymous = null;
    if (!userFilter && type !== 'organisation' && type !== 'personal') {
      let aq = db()('ana_reader_day').countDistinct({ n: 'reader_key' }).sum({ pages: 'pages_read' }).whereNull('user_id').whereBetween('local_date', [r.from, r.to]);
      if (pub) aq = aq.where('publication', pub);
      const [a] = await aq;
      anonymous = { visitors: num(a?.n), pagesRead: num(a?.pages) };
    }
    return { range: r, total, page, pageSize, readers: list, anonymous };
  }

  function arrivalLabel(first) {
    if (!first) return 'Opened a link';
    if (first.type === 'auth.login') return 'Password login';
    if (first.type === 'auth.refresh') return 'Signed in (refresh)';
    if (first.type === 'search.query') {
      let m = null;
      try { m = first.meta ? JSON.parse(first.meta) : null; } catch { m = null; }
      return m?.q ? `Search: "${String(m.q).slice(0, 60)}"` : 'Search';
    }
    let m = null;
    try { m = first.meta ? JSON.parse(first.meta) : null; } catch { m = null; }
    if (m?.via === 'landing') return 'Landing page';
    if (m?.via === 'archive') return 'Archive calendar';
    if (m?.via === 'search') return 'Search result';
    return 'Opened a link';
  }

  async function reader(userIdRaw, query = {}) {
    const userId = Number(userIdRaw);
    if (!Number.isInteger(userId) || userId < 1) throw new c.AnalyticsError(400, 'Unknown reader');
    const r = range(query);
    const user = await q(c.USER).findOne({ where: { id: userId }, select: ['id', 'email', 'displayName', 'createdAt', 'accountSource'] });
    if (!user) throw new c.AnalyticsError(404, 'Reader not found');

    const access = await strapi.service('api::catalogue.catalogue-store').accessProfile(userId);
    const pubs = await c.publicationList();

    const days = await db()('ana_reader_day')
      .select('local_date', 'publication')
      .sum({ ms: 'read_ms', pages: 'pages_read', stories: 'stories', editions: 'editions' })
      .where('user_id', userId)
      .whereBetween('local_date', [r.from, r.to])
      .groupBy('local_date', 'publication');
    const dates = daysBetween(r.from, r.to);
    const dI = new Map(dates.map((d, i) => [d, i]));
    const activeDates = new Set(days.map((d) => d.local_date));
    const codesRead = [...new Set(days.filter((d) => num(d.ms) > 0).map((d) => d.publication).filter(Boolean))];
    const daily = { dates, series: Object.fromEntries(codesRead.map((cd) => [cd, dates.map(() => 0)])) };
    let ms = 0;
    let pagesRead = 0;
    let stories = 0;
    for (const d of days) {
      ms += num(d.ms);
      pagesRead += num(d.pages);
      stories += num(d.stories);
      if (d.publication && daily.series[d.publication] && dI.has(d.local_date)) daily.series[d.publication][dI.get(d.local_date)] = Math.round(num(d.ms) / 6000) / 10;
    }

    const ev = await db()('ana_events')
      .select('id', 'occurred_at', 'type', 'session_id', 'publication', 'edition_date', 'page_number', 'section', 'story_id', 'dwell_ms', 'device', 'browser', 'os', 'meta', 'local_date', 'locked')
      .where('user_id', userId)
      .whereBetween('local_date', [r.from, r.to])
      .orderBy('occurred_at', 'asc')
      .limit(20000);

    const editionsOpened = new Map();
    const sectionMs = new Map();
    const sessions = new Map();
    const storyEvents = [];
    for (const e of ev) {
      if (e.publication && e.edition_date && !(e.locked === true || e.locked === 1) && (e.type === 'page.view' || e.type === 'edition.open')) {
        editionsOpened.set(`${e.publication}:${e.edition_date}`, e.publication);
      }
      if (e.type === 'page.view' && num(e.dwell_ms) >= c.READ_MS && !(e.locked === true || e.locked === 1)) {
        const k = `${e.publication}|${e.section || 'Unlabelled'}`;
        sectionMs.set(k, (sectionMs.get(k) || 0) + num(e.dwell_ms));
      }
      if (e.type === 'story.open') storyEvents.push(e);
      const sid = e.session_id || `none-${e.local_date}`;
      if (!sessions.has(sid)) sessions.set(sid, []);
      sessions.get(sid).push(e);
    }
    const perPubEditions = {};
    for (const p of editionsOpened.values()) perPubEditions[p] = (perPubEditions[p] || 0) + 1;

    const storyMeta = await c.storiesById(storyEvents.map((s) => s.story_id));
    const storyList = storyEvents
      .slice(-100)
      .reverse()
      .map((s) => ({
        at: kampalaTimeOf(s.occurred_at),
        publication: s.publication,
        editionDate: s.edition_date,
        page: s.page_number || storyMeta.get(s.story_id)?.page?.pageNumber || null,
        headline: storyMeta.get(s.story_id)?.headline || '(story removed)',
        section: s.section || storyMeta.get(s.story_id)?.page?.section || null,
        seconds: s.dwell_ms === null ? null : Math.round(num(s.dwell_ms) / 1000)
      }));

    const pageCounts = new Map();
    const sessionList = [];
    for (const [sid, list] of sessions) {
      const views = list.filter((e) => e.type === 'page.view');
      const edCount = new Map();
      for (const v of views) if (v.publication && v.edition_date) edCount.set(`${v.publication}:${v.edition_date}`, (edCount.get(`${v.publication}:${v.edition_date}`) || 0) + 1);
      const main = [...edCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      let total = null;
      if (main) {
        if (!pageCounts.has(main)) {
          const [p, d] = main.split(':');
          const m = await editionMeta(p, d);
          pageCounts.set(main, m.pages || null);
        }
        total = pageCounts.get(main);
      }
      const first = list[0];
      const last = list[list.length - 1];
      const dwellSum = views.reduce((a, v) => a + num(v.dwell_ms), 0);
      sessionList.push({
        sessionId: sid.startsWith('none-') ? null : sid,
        started: kampalaTimeOf(first.occurred_at),
        startedMs: num(first.occurred_at),
        publication: main ? main.split(':')[0] : null,
        editionDate: main ? main.split(':')[1] : null,
        archive: main ? main.split(':')[1] < first.local_date : false,
        pagesRead: views.filter((v) => num(v.dwell_ms) >= c.READ_MS && !(v.locked === true || v.locked === 1)).length,
        deepestPage: Math.max(0, ...views.map((v) => num(v.page_number))),
        pages: total,
        minutes: Math.max(Math.round(dwellSum / 60000), Math.round((num(last.occurred_at) - num(first.occurred_at)) / 60000)),
        device: [first.os, first.browser].filter(Boolean).join(' · ') || first.device || null,
        cameInBy: arrivalLabel(first)
      });
    }
    sessionList.sort((a, b) => b.startedMs - a.startedMs);

    const lastEv = await db()('ana_events').select('occurred_at', 'device', 'os', 'browser').where('user_id', userId).orderBy('occurred_at', 'desc').first();
    const sectionList = [...sectionMs.entries()]
      .map(([k, v]) => ({ publication: k.split('|')[0], name: k.split('|').slice(1).join('|'), minutes: Math.round(v / 60000) }))
      .sort((a, b) => b.minutes - a.minutes);

    return {
      range: r,
      publications: pubs,
      user: { id: user.id, email: user.email, name: user.displayName || null, since: kampalaDateOf(user.createdAt), accountSource: user.accountSource || null },
      access,
      kpis: {
        daysActive: activeDates.size,
        daysInRange: dates.length,
        editionsOpened: editionsOpened.size,
        editionsByPublication: perPubEditions,
        pagesRead,
        minutes: Math.round(ms / 60000),
        minutesPerActiveDay: activeDates.size ? Math.round(ms / 60000 / activeDates.size) : 0,
        storiesOpened: stories,
        lastSeen: lastEv ? kampalaTimeOf(lastEv.occurred_at) : null,
        lastDevice: lastEv ? [lastEv.os, lastEv.browser].filter(Boolean).join(' · ') || lastEv.device : null
      },
      daily,
      sections: sectionList,
      stories: storyList,
      sessions: sessionList.slice(0, 40).map(({ startedMs, ...s }) => s)
    };
  }

  // ---- revenue -------------------------------------------------------------------

  async function revenue(query = {}) {
    const r = range(query);
    const prev = previousRange(r);
    const pubs = await c.publicationList();
    const codes = pubs.map((p) => p.code);
    const startTs = new Date(`${prev.from}T00:00:00+03:00`);
    const endTs = new Date(`${addDays(r.to, 1)}T00:00:00+03:00`);

    const rows = await q(c.ENT).findMany({
      where: {
        scope: { $in: ['personal', 'org_contract'] },
        revokedAt: { $null: true },
        createdAt: { $gte: startTs, $lt: endTs }
      },
      select: ['id', 'scope', 'amountAllocated', 'amountPaid', 'currency', 'coverageStart', 'coverageEnd', 'seats', 'createdAt', 'reference'],
      populate: {
        publication: { select: ['code'] },
        plan: { select: ['key', 'label', 'kind'], populate: { publications: { select: ['code'] } } },
        transaction: { select: ['id'] },
        user: { select: ['id'] },
        organization: { select: ['id', 'name'] }
      }
    });
    const amountOf = (e) => num(e.amountAllocated ?? e.amountPaid);
    const items = rows
      .filter((e) => e.publication?.code)
      .map((e) => ({ ...e, day: kampalaDateOf(e.createdAt), pub: e.publication.code, amount: amountOf(e) }));
    const inNow = items.filter((e) => e.day >= r.from && e.day <= r.to);
    const inPrev = items.filter((e) => e.day >= prev.from && e.day <= prev.to);
    const sum = (list) => list.reduce((a, e) => a + e.amount, 0);

    const total = sum(inNow);
    const byPub = codes.map((cd) => {
      const list = inNow.filter((e) => e.pub === cd);
      const amount = sum(list);
      const payers = new Set(list.filter((e) => e.scope === 'personal' && e.user?.id).map((e) => e.user.id));
      return {
        code: cd,
        amount,
        sharePct: pct(amount, total),
        previous: sum(inPrev.filter((e) => e.pub === cd)),
        personal: sum(list.filter((e) => e.scope === 'personal')),
        organisation: sum(list.filter((e) => e.scope === 'org_contract')),
        payingReaders: payers.size,
        perPayingReader: payers.size ? Math.round(sum(list.filter((e) => e.scope === 'personal')) / payers.size) : 0
      };
    });
    const personalPayers = new Set(inNow.filter((e) => e.scope === 'personal' && e.user?.id).map((e) => e.user.id));
    const orgAmount = sum(inNow.filter((e) => e.scope === 'org_contract'));

    // chart: by day, or by month when the range is longer than ~3 months
    const dates = daysBetween(r.from, r.to);
    const byMonth = dates.length > 92;
    const buckets = byMonth ? [...new Set(dates.map((d) => d.slice(0, 7)))] : dates;
    const bI = new Map(buckets.map((b, i) => [b, i]));
    const chart = { buckets, unit: byMonth ? 'month' : 'day', series: emptyFill(buckets, codes), total: buckets.map(() => 0), cumulative: [] };
    for (const e of inNow) {
      const b = byMonth ? e.day.slice(0, 7) : e.day;
      if (!bI.has(b)) continue;
      if (chart.series[e.pub]) chart.series[e.pub][bI.get(b)] += e.amount;
      chart.total[bI.get(b)] += e.amount;
    }
    let run = 0;
    chart.cumulative = chart.total.map((v) => (run += v));

    // by plan
    const planRows = new Map();
    for (const e of inNow) {
      let key;
      let rowPub;
      let label;
      let boughtBy;
      if (e.scope === 'org_contract') {
        key = `org|${e.pub}`;
        rowPub = e.pub;
        label = 'Organisation contract';
        boughtBy = 'organisation';
      } else {
        const planPubs = (e.plan?.publications || []).map((p) => p.code).sort();
        const bundle = planPubs.length > 1;
        rowPub = bundle ? planPubs.join('+') : e.pub;
        key = `plan|${e.plan?.key || 'unknown'}|${rowPub}`;
        label = e.plan?.label || (e.plan?.kind === 'single_issue' ? 'Single edition' : 'Plan removed');
        boughtBy = 'personal';
      }
      const row = planRows.get(key) || { publication: rowPub, plan: label, planKey: e.plan?.key || null, boughtBy, bundle: rowPub.includes('+'), payments: new Set(), orgs: new Set(), amount: 0 };
      row.payments.add(e.transaction?.id ? `t${e.transaction.id}` : `e${e.id}`);
      if (e.organization?.id) row.orgs.add(e.organization.id);
      row.amount += e.amount;
      planRows.set(key, row);
    }
    const byPlan = [...planRows.values()]
      .map((x) => ({ ...x, payments: x.payments.size, organisations: x.orgs.size, orgs: undefined, sharePct: pct(x.amount, total) }))
      .sort((a, b) => b.amount - a.amount);

    // paywall → checkout → paid, per publication
    const funnelRows = await db()('ana_events')
      .select('publication', 'type')
      .countDistinct({ n: 'reader_key' })
      .whereIn('type', ['paywall.view', 'checkout.start'])
      .whereBetween('local_date', [r.from, r.to])
      .whereNotNull('publication')
      .groupBy('publication', 'type');
    const funnel = codes.map((cd) => {
      const views = num(funnelRows.find((x) => x.publication === cd && x.type === 'paywall.view')?.n);
      const starts = num(funnelRows.find((x) => x.publication === cd && x.type === 'checkout.start')?.n);
      const paid = new Set(inNow.filter((e) => e.pub === cd && e.scope === 'personal' && e.user?.id).map((e) => e.user.id)).size;
      return {
        code: cd,
        steps: [
          { key: 'paywall', label: 'Saw the paywall', n: views, pct: 100 },
          { key: 'checkout', label: 'Started checkout', n: starts, pct: pct(starts, views) },
          // readers who paid for this paper in the range (from payments, so it can include readers who paid elsewhere)
          { key: 'paid', label: 'Paid', n: paid, pct: pct(paid, views) }
        ],
        checkoutLossPct: starts ? Math.round((1 - paid / starts) * 1000) / 10 : 0
      };
    });
    const failed = await q('api::epaper-transaction.epaper-transaction').findMany({
      where: { createdAt: { $gte: new Date(`${r.from}T00:00:00+03:00`), $lt: endTs }, payment_success: { $ne: true }, payment_request_sent: true },
      select: ['aggregator_status', 'frontend_status']
    });
    const failures = {};
    for (const f of failed) {
      const k = f.aggregator_status || f.frontend_status || 'unknown';
      failures[k] = (failures[k] || 0) + 1;
    }

    // organisation contracts that touch the range, with seat use within it
    const idx = await payingIndex();
    const today = kampalaToday();
    const contractUse = await orgSeatUse({ idx, asOf: today, from: r.from, to: r.to });
    const contractAmounts = await q(c.ENT).findMany({
      where: { scope: 'org_contract', revokedAt: { $null: true }, coverageEnd: { $gte: r.from }, coverageStart: { $lte: r.to } },
      select: ['coverageStart', 'coverageEnd', 'amountAllocated', 'amountPaid', 'seats'],
      populate: { publication: { select: ['code'] }, organization: { select: ['id'] } }
    });
    const contracts = contractUse.map((u) => {
      const a = contractAmounts.find((x) => x.organization?.id === u.orgId && x.publication?.code === u.publication && x.coverageStart === u.start && x.coverageEnd === u.end);
      const daysLeft = daysBetween(today, u.end).length - 1;
      return { ...u, amount: a ? amountOf(a) : null, daysToRenewal: u.end >= today ? daysLeft : null };
    }).sort((a, b) => a.end.localeCompare(b.end));

    return {
      range: r,
      previous: prev,
      publications: pubs,
      currency: inNow.find((e) => e.currency)?.currency || 'UGX',
      kpis: {
        total,
        previousTotal: sum(inPrev),
        perPayingReader: personalPayers.size ? Math.round(sum(inNow.filter((e) => e.scope === 'personal')) / personalPayers.size) : 0,
        payingReaders: personalPayers.size,
        organisationPct: pct(orgAmount, total),
        organisations: new Set(inNow.filter((e) => e.scope === 'org_contract' && e.organization?.id).map((e) => e.organization.id)).size
      },
      byPublication: byPub,
      chart,
      byPlan,
      funnel,
      failures,
      contracts
    };
  }

  // ---- organisation usage (days and publications only) ------------------------------

  /** org: { id, name }. month: 'YYYY-MM'. withUserIds: handle only (links to reader detail). */
  async function orgUsage(org, monthRaw, { withUserIds = false } = {}) {
    const today = kampalaToday();
    const month = /^\d{4}-\d{2}$/.test(String(monthRaw || '')) ? String(monthRaw) : today.slice(0, 7);
    const from = `${month}-01`;
    const end = monthEnd(from);
    const to = end > today ? today : end;
    const prevMonth = addMonthsToMonth(month, -1);
    const prevFrom = `${prevMonth}-01`;
    const prevTo = monthEnd(prevFrom);
    const dates = from <= to ? daysBetween(from, to) : [];
    const pubs = await c.publicationList();

    const idx = await payingIndex();
    const seats = await q(c.SEAT).findMany({
      where: { organization: { id: org.id } },
      select: ['id', 'role', 'active', 'status', 'publicationCodes', 'assignedAt'],
      populate: { user: { select: ['id', 'email', 'displayName', 'passwordSetAt', 'accountSource', 'invitedAt'] } }
    });
    const members = seats.filter((s) => s.user?.id);
    const ids = members.map((s) => s.user.id);

    const rows = ids.length
      ? await db()('ana_reader_day').select('user_id', 'local_date', 'publication', 'editions').whereIn('user_id', ids).whereBetween('local_date', [prevFrom, to])
      : [];
    const lastRows = ids.length
      ? await db()('ana_events').select('user_id').max({ last: 'occurred_at' }).whereIn('user_id', ids).groupBy('user_id')
      : [];
    const lastOf = new Map(lastRows.map((x) => [x.user_id, num(x.last)]));

    const grid = new Map(); // user -> date -> Set(pub)
    const prevActive = new Map(); // user -> Set(date)
    for (const row of rows) {
      if (row.local_date >= from) {
        if (!grid.has(row.user_id)) grid.set(row.user_id, new Map());
        const g = grid.get(row.user_id);
        if (!g.has(row.local_date)) g.set(row.local_date, new Set());
        // a paper counts as opened only when read with access, not a front-page preview
        if (row.publication && num(row.editions) > 0) g.get(row.local_date).add(row.publication);
      } else {
        if (!prevActive.has(row.user_id)) prevActive.set(row.user_id, new Set());
        prevActive.get(row.user_id).add(row.local_date);
      }
    }

    const contracts = idx.contracts.filter((k) => k.orgId === org.id && overlapsRange(k, from, end));
    const contractPubs = [...new Set(contracts.map((k) => k.pub))];
    const shownPubs = pubs.filter((p) => contractPubs.includes(p.code) || rows.some((x) => x.publication === p.code && num(x.editions) > 0));

    const list = members.map((s) => {
      const g = grid.get(s.user.id) || new Map();
      const codes = Array.isArray(s.publicationCodes) ? s.publicationCodes.map((x) => String(x).toUpperCase()) : null;
      const perPub = {};
      for (const p of shownPubs) perPub[p.code] = [...g.values()].filter((set) => set.has(p.code)).length;
      const seatStatus = s.status || (s.active === false ? 'suspended' : 'active');
      return {
        seatId: s.id,
        ...(withUserIds ? { userId: s.user.id } : {}),
        name: s.user.displayName || s.user.email,
        email: s.user.email,
        role: s.role || 'member',
        status: s.active === false ? 'removed' : seatStatus,
        seatPublications: codes === null ? contractPubs : codes,
        invitePending: !s.user.passwordSetAt && (s.user.accountSource === 'org_invite' || s.user.accountSource === 'org_import'),
        days: Object.fromEntries(dates.map((d) => [d, g.has(d) ? [...g.get(d)].sort() : null])),
        daysActive: g.size,
        perPublication: perPub,
        lastSeen: lastOf.get(s.user.id) ? kampalaTimeOf(lastOf.get(s.user.id)) : null,
        prevDaysActive: (prevActive.get(s.user.id) || new Set()).size
      };
    });
    const current = list.filter((m) => m.status !== 'removed');

    const activeNow = current.filter((m) => m.daysActive > 0).length;
    const activePrev = current.filter((m) => m.prevDaysActive > 0).length;
    const avg = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : 0);

    const seatUse = shownPubs.map((p) => {
      const ks = contracts.filter((k) => k.pub === p.code);
      const seatsPaid = ks.reduce((a, k) => Math.max(a, k.seats || 0), 0);
      const holders = current.filter((m) => m.seatPublications.includes(p.code));
      const used = holders.filter((m) => m.perPublication[p.code] > 0).length;
      return {
        code: p.code,
        seats: seatsPaid,
        holders: holders.length,
        used,
        usePct: pct(used, seatsPaid || holders.length),
        periods: ks.map((k) => ({ start: k.start, end: k.end, seats: k.seats }))
      };
    });

    const daily = {
      dates,
      active: dates.map((d) => current.filter((m) => m.days[d]).length),
      series: Object.fromEntries(shownPubs.map((p) => [p.code, dates.map((d) => current.filter((m) => (m.days[d] || []).includes(p.code)).length)]))
    };

    // seat use month by month, last 6 months
    const months = Array.from({ length: 6 }, (_, i) => addMonthsToMonth(month, i - 5));
    const histRows = ids.length
      ? await db()('ana_reader_day')
        .distinct(db().raw('substr(local_date, 1, 7) as ym'), 'user_id', 'publication')
        .whereIn('user_id', ids)
        .whereBetween('local_date', [`${months[0]}-01`, to])
        .whereNot('publication', '')
        .where('editions', '>', 0)
      : [];
    const history = {
      months,
      series: Object.fromEntries(shownPubs.map((p) => [p.code, months.map((m) => {
        const mEnd = monthEnd(`${m}-01`);
        const ks = idx.contracts.filter((k) => k.orgId === org.id && k.pub === p.code && overlapsRange(k, `${m}-01`, mEnd));
        if (!ks.length) return null;
        const seatsPaid = ks.reduce((a, k) => Math.max(a, k.seats || 0), 0);
        const used = new Set(histRows.filter((x) => x.ym === m && x.publication === p.code).map((x) => x.user_id)).size;
        return pct(Math.min(used, seatsPaid || used), seatsPaid || used || 1);
      })]))
    };

    const available = [];
    for (let i = 0; i < 12; i += 1) available.push(addMonthsToMonth(today.slice(0, 7), -i));

    return {
      organisation: { id: org.id, name: org.name },
      month,
      months: available,
      from,
      to,
      publications: shownPubs,
      kpis: {
        members: current.length,
        activeMembers: activeNow,
        previousActiveMembers: activePrev,
        averageDays: avg(current.map((m) => m.daysActive)),
        previousAverageDays: avg(current.map((m) => m.prevDaysActive)),
        daysSoFar: dates.length,
        neverSignedIn: current.filter((m) => !m.lastSeen).length,
        invitesPending: current.filter((m) => m.invitePending).length
      },
      seatUse,
      members: current.map(({ prevDaysActive, ...m }) => m),
      daily,
      history
    };
  }

  return { overview, curve, sections, readers, reader, revenue, orgUsage };
};
