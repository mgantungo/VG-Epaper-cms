'use strict';

/**
 * apps/cms/src/api/org-management/services/org-members.js
 * NEW FILE — Phase 3 (Org Admin dashboard, invites, Excel import)
 *
 * Everything an Org Admin can do for THEIR OWN organisation, plus the
 * invite accept flow. Callers: controllers/org-portal.js, reachable only
 * with STRAPI_API_TOKEN (i.e. from the middleware).
 *
 * The organisation is NEVER taken from the request. context(actorUserId)
 * resolves it from the acting user's own seat on every call, and refuses
 * unless that seat is an active admin seat in an active organisation. The
 * middleware passes the user id from the reader's verified JWT.
 *
 * Access rules enforced here (same as the middleware's hasAccess):
 *   - a member window must start inside a paid period (contract). If it runs
 *     past the end of that period, it is clipped and the caller told so.
 *   - granting access to someone who already has an overlapping or touching
 *     window extends that window instead of stacking a second one.
 *   - seats in use = ACTIVE seats; adding or reactivating respects seatLimit.
 *
 * UPDATED (spreadsheet round-trip): handle admins can run the same Excel
 * import for any organisation (adminContext), both sides can export the
 * current member list (exportMembers) to edit and upload again, and an
 * existing member's row only changes when it has its own dates or months
 * (action "keep" otherwise), so re-uploading an unedited export changes
 * nothing. The upload's default period applies to NEW people only.
 *
 * Invites: a person added who has no reader account gets one created with
 * an unusable random password plus a one-time invite token (only its
 * SHA-256 is stored). The emailed link lets them set a password, which
 * also logs them in.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const ORG = 'api::epaper-organization.epaper-organization';
const SEAT = 'api::epaper-org-seat.epaper-org-seat';
const ENT = 'api::epaper-entitlement.epaper-entitlement';
const USER = 'api::epaper-user.epaper-user';
const AUDIT = 'api::epaper-org-audit.epaper-org-audit';
const IMPORT = 'api::epaper-org-import.epaper-org-import';
const STORE = 'api::org-management.org-store';

const INVITE_TTL_DAYS = 14;
const IMPORT_TTL_HOURS = 24;
const MAX_IMPORT_ROWS = 5000;
const EXPIRING_SOON_DAYS = 14;

class OrgError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    if (extra) this.extra = extra;
  }
}

// ---- dates (all YYYY-MM-DD, UTC, same "today" as the middleware) -----------

// Kampala calendar day (see src/utils/epaper-dates.js).
const todayIso = () => require('../../../utils/epaper-dates').kampalaToday();

function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** iso + n months, clamped to the end of the target month, minus one day:
 * a 1-month window from 2026-01-31 ends 2026-02-27 (inclusive). */
function monthsWindowEnd(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const targetMonth = m - 1 + months;
  const ty = y + Math.floor(targetMonth / 12);
  const tm = ((targetMonth % 12) + 12) % 12;
  const daysInTarget = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const target = new Date(Date.UTC(ty, tm, Math.min(d, daysInTarget)));
  return addDays(target.toISOString().slice(0, 10), -1);
}

// ---- small helpers ---------------------------------------------------------

function toId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new OrgError(400, 'Invalid id');
  return n;
}
const normEmail = (e) => String(e || '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const orgStatusOf = (org) => org.status || (org.active === false ? 'suspended' : 'active');
const seatStatusOf = (seat) => seat.status || (seat.active === false ? 'suspended' : 'active');
const isContract = (e) => (e.scope ? e.scope === 'org_contract' : !e.user);

function webUrl(path) {
  const base = (process.env.EPAPER_WEB_URL || 'https://epapers.new.visiongroup.co.ug').replace(/\/+$/, '');
  return `${base}${path}`;
}

module.exports = ({ strapi }) => {
  const q = (uid) => strapi.db.query(uid);
  const store = () => strapi.service(STORE);
  const userService = () => strapi.service('api::epaper-user.epaper-user');

  async function audit({ orgId, actorUserId, actorAdminId, action, targetUserId, targetEmail, meta }) {
    await q(AUDIT).create({
      data: {
        organization: orgId,
        actorUser: actorUserId || null,
        actorAdmin: actorAdminId || null,
        action,
        targetUser: targetUserId || null,
        targetEmail: targetEmail || null,
        meta: meta || null
      }
    });
  }

  // ---- context -------------------------------------------------------------

  /** Resolves the Org Admin's organisation from their own seat, or refuses. */
  async function context(actorUserIdRaw) {
    const actorUserId = toId(actorUserIdRaw);
    const seat = await q(SEAT).findOne({
      where: { user: { id: actorUserId } },
      populate: { organization: true, user: { select: ['id', 'email', 'displayName'] } }
    });
    if (!seat || !seat.organization) throw new OrgError(403, 'You are not part of an organisation');
    if (seat.role !== 'admin') throw new OrgError(403, 'Only organisation admins can manage members');
    if (seatStatusOf(seat) !== 'active') throw new OrgError(403, 'Your organisation seat is suspended');
    const org = seat.organization;
    const orgStatus = orgStatusOf(org);
    if (orgStatus !== 'active') {
      throw new OrgError(403, `Your organisation's account is ${orgStatus}. Contact New Vision to restore it.`);
    }
    return {
      orgId: org.id,
      org,
      actorUserId,
      actorSeatId: seat.id,
      actorEmail: seat.user?.email,
      actorName: seat.user?.displayName || seat.user?.email
    };
  }

  /** A handle admin acting for an organisation. The middleware has already
   * checked their canManageOrganizations right. */
  async function adminContext(orgIdRaw, actorAdminIdRaw) {
    const orgId = toId(orgIdRaw);
    const actorAdminId = toId(actorAdminIdRaw);
    const org = await q(ORG).findOne({ where: { id: orgId } });
    if (!org) throw new OrgError(404, 'Organisation not found');
    return {
      orgId, org, actorUserId: null, actorAdminId, actorSeatId: null,
      actorEmail: null, actorName: 'New Vision'
    };
  }

  // ---- paid periods ----------------------------------------------------------

  async function contractRows(orgId) {
    const rows = await q(ENT).findMany({
      where: {
        organization: { id: orgId },
        revokedAt: { $null: true },
        $or: [{ scope: 'org_contract' }, { scope: { $null: true } }]
      },
      orderBy: { coverageStart: 'asc' },
      populate: { user: { select: ['id'] } }
    });
    return rows.filter(isContract).map((e) => ({ start: e.coverageStart, end: e.coverageEnd }));
  }

  /** Contracts merged into continuous ranges (overlapping or back-to-back). */
  function mergeRanges(ranges) {
    const sorted = [...ranges].sort((a, b) => a.start.localeCompare(b.start));
    const out = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last && r.start <= addDays(last.end, 1)) {
        if (r.end > last.end) last.end = r.end;
      } else {
        out.push({ ...r });
      }
    }
    return out;
  }

  /**
   * Turns { coverageStart?, coverageEnd?, months? } into a concrete window
   * inside a paid period.
   *   - no start: today, or the start of the next paid period if none covers today
   *   - months: end = start + months (inclusive)
   *   - neither end nor months: to the end of the paid period
   * Throws if the start isn't inside any paid period; clips the end to it.
   */
  function resolveWindow(merged, input = {}) {
    if (!merged.length) throw new OrgError(409, 'Your organisation has no paid period. Contact New Vision to renew.');
    const today = todayIso();

    let start = input.coverageStart || null;
    if (start && !isIsoDate(start)) throw new OrgError(400, `Start date "${start}" is not a valid date`);
    if (!start) {
      const current = merged.find((r) => r.start <= today && today <= r.end);
      const next = merged.find((r) => r.start > today);
      if (!current && !next) throw new OrgError(409, 'Your paid period has ended. Contact New Vision to renew.');
      start = current ? today : next.start;
    }

    const range = merged.find((r) => r.start <= start && start <= r.end);
    if (!range) throw new OrgError(409, `${start} is outside your organisation's paid period`);

    let end;
    if (input.coverageEnd) {
      if (!isIsoDate(input.coverageEnd)) throw new OrgError(400, `End date "${input.coverageEnd}" is not a valid date`);
      end = input.coverageEnd;
    } else if (input.months !== undefined && input.months !== null && input.months !== '') {
      const months = Number(input.months);
      if (!Number.isInteger(months) || months < 1 || months > 60) throw new OrgError(400, 'months must be a whole number from 1 to 60');
      end = monthsWindowEnd(start, months);
    } else {
      end = range.end;
    }
    if (end < start) throw new OrgError(400, 'End date must be on or after the start date');

    const clipped = end > range.end;
    if (clipped) end = range.end;
    return { start, end, clipped, paidUntil: range.end };
  }

  /** Creates or extends this member's window to cover [start, end]. */
  async function applyWindow({ orgId, userId, email, start, end, actorUserId, actorAdminId, source }) {
    const touching = await q(ENT).findMany({
      where: {
        organization: { id: orgId },
        user: { id: userId },
        scope: 'org_member',
        revokedAt: { $null: true },
        coverageStart: { $lte: addDays(end, 1) },
        coverageEnd: { $gte: addDays(start, -1) }
      },
      orderBy: { coverageStart: 'asc' }
    });

    if (!touching.length) {
      const row = await q(ENT).create({
        data: {
          organization: orgId, user: userId, scope: 'org_member', grantSource: source,
          grantedByUser: actorUserId || null, grantedByAdmin: actorAdminId || null, coverageStart: start, coverageEnd: end
        }
      });
      await audit({ orgId, actorUserId, actorAdminId, action: 'access.create', targetUserId: userId, targetEmail: email, meta: { start, end, source } });
      return { action: 'created', start, end, entitlementId: row.id };
    }

    const keep = touching[0];
    const newStart = touching.reduce((m, w) => (w.coverageStart < m ? w.coverageStart : m), start);
    const newEnd = touching.reduce((m, w) => (w.coverageEnd > m ? w.coverageEnd : m), end);
    const unchanged = touching.length === 1 && keep.coverageStart === newStart && keep.coverageEnd === newEnd;
    if (unchanged) return { action: 'unchanged', start: newStart, end: newEnd, entitlementId: keep.id };

    await q(ENT).update({ where: { id: keep.id }, data: { coverageStart: newStart, coverageEnd: newEnd } });
    for (const extra of touching.slice(1)) {
      await q(ENT).update({
        where: { id: extra.id },
        data: { revokedAt: new Date(), revokedReason: `merged into #${keep.id}` }
      });
    }
    await audit({
      orgId, actorUserId, actorAdminId, action: 'access.extend', targetUserId: userId, targetEmail: email,
      meta: { from: { start: keep.coverageStart, end: keep.coverageEnd }, to: { start: newStart, end: newEnd }, source }
    });
    return { action: 'extended', start: newStart, end: newEnd, entitlementId: keep.id };
  }

  async function activeSeatCount(orgId) {
    return q(SEAT).count({ where: { organization: { id: orgId }, active: true } });
  }

  async function loadSeatInOrg(orgId, seatId) {
    const seat = await q(SEAT).findOne({
      where: { id: toId(seatId) },
      populate: {
        organization: { select: ['id'] },
        user: { select: ['id', 'email', 'displayName', 'accountSource', 'passwordSetAt'] }
      }
    });
    if (!seat || seat.organization?.id !== orgId) throw new OrgError(404, 'Member not found in your organisation');
    return seat;
  }

  // ---- invites ---------------------------------------------------------------

  function newInvite(userId) {
    const secret = crypto.randomBytes(24).toString('base64url');
    return {
      token: `${userId}.${secret}`,
      data: {
        inviteTokenHash: sha256(secret),
        inviteExpiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86400000),
        invitedAt: new Date()
      }
    };
  }

  async function createInvitedUser({ email, displayName, phone, accountSource }) {
    // Unusable password: random, never shown to anyone. Login stays impossible
    // until the invite is accepted and a real password is set.
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    const user = await q(USER).create({
      data: {
        email, passwordHash, displayName: displayName || '', phone: phone || '',
        active: true, tokenVersion: 0, accountSource
      }
    });
    const invite = newInvite(user.id);
    await q(USER).update({ where: { id: user.id }, data: invite.data });
    return { user, inviteToken: invite.token };
  }

  async function sendInvite({ email, displayName, orgName, inviterName, token }) {
    try {
      const mailer = require('../../../services/handle-admin-email.js');
      await mailer.sendOrgInvite(email, {
        displayName, orgName, inviterName,
        link: webUrl(`/invite?token=${encodeURIComponent(token)}`),
        expiresDays: INVITE_TTL_DAYS
      });
      return true;
    } catch (err) {
      strapi.log.error(`[org-members] invite email to ${email} failed:`, err);
      return false;
    }
  }

  function parseInviteToken(token) {
    const m = /^(\d+)\.([A-Za-z0-9_-]{20,})$/.exec(String(token || '').trim());
    if (!m) return null;
    return { userId: Number(m[1]), secret: m[2] };
  }

  async function findInvitedUser(token) {
    const parsed = parseInviteToken(token);
    const invalid = () => new OrgError(400, 'This invite link is invalid or has expired. Ask your organisation admin to resend it.');
    if (!parsed) throw invalid();
    const user = await q(USER).findOne({ where: { id: parsed.userId } });
    if (!user || !user.inviteTokenHash || !user.inviteExpiresAt) throw invalid();
    if (new Date(user.inviteExpiresAt) < new Date()) throw invalid();
    const a = Buffer.from(sha256(parsed.secret), 'hex');
    const b = Buffer.from(String(user.inviteTokenHash), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw invalid();
    return user;
  }

  // ---- import planning (shared by preview and commit) ------------------------

  /**
   * Builds the row-by-row plan. Reads current state only; writes nothing.
   * Each row: { row, email, displayName, phone, action, start, end, clipped,
   *             userId, seatId, notes[], error }
   * actions: new_user | add_existing | extend | error
   */
  async function planRows(ctx, rawRows, defaults) {
    const merged = mergeRanges(await contractRows(ctx.orgId));
    const seatLimit = ctx.org.seatLimit ?? null;
    let seatsLeft = seatLimit === null ? Infinity : seatLimit - (await activeSeatCount(ctx.orgId));

    const rows = rawRows.map((r, i) => ({
      row: Number(r.row) || i + 2,
      email: normEmail(r.email),
      displayName: String(r.displayName || '').trim(),
      phone: String(r.phone || '').trim(),
      input: { coverageStart: r.coverageStart || null, coverageEnd: r.coverageEnd || null, months: r.months ?? null }
    }));

    const emails = [...new Set(rows.map((r) => r.email).filter((e) => EMAIL_RE.test(e)))];
    const users = emails.length
      ? await q(USER).findMany({ where: { email: { $in: emails } }, select: ['id', 'email', 'displayName'] })
      : [];
    const userByEmail = new Map(users.map((u) => [u.email, u]));
    const seats = users.length
      ? await q(SEAT).findMany({
          where: { user: { id: { $in: users.map((u) => u.id) } } },
          populate: { user: { select: ['id'] }, organization: { select: ['id', 'name'] } }
        })
      : [];
    const seatByUser = new Map(seats.map((s) => [s.user?.id, s]));

    const seen = new Map();
    const plan = [];
    for (const r of rows) {
      const out = {
        row: r.row, email: r.email, displayName: r.displayName, phone: r.phone,
        action: 'error', start: null, end: null, clipped: false, userId: null, seatId: null, notes: [], error: null
      };
      plan.push(out);

      if (!EMAIL_RE.test(r.email)) { out.error = r.email ? `"${r.email}" is not a valid email` : 'Email is missing'; continue; }
      if (seen.has(r.email)) { out.error = `Duplicate of row ${seen.get(r.email)}`; continue; }
      seen.set(r.email, r.row);

      const hasOwnDates = Boolean(r.input.coverageStart || r.input.coverageEnd || (r.input.months !== null && r.input.months !== ''));

      const user = userByEmail.get(r.email);
      const seat = user ? seatByUser.get(user.id) : null;
      if (seat && seat.organization?.id !== ctx.orgId) {
        out.error = 'Already belongs to another organisation';
        continue;
      }
      if (user) out.userId = user.id;

      // Existing member, no dates or months on their row: leave them as they
      // are. This is what makes "download members, edit, upload" safe.
      if (seat && !hasOwnDates) {
        out.action = 'keep';
        out.seatId = seat.id;
        out.notes.push('Already a member; no dates given, so nothing changes');
        continue;
      }

      let win;
      try {
        win = resolveWindow(merged, hasOwnDates ? r.input : defaults);
      } catch (err) {
        out.error = err.message;
        continue;
      }
      out.start = win.start;
      out.end = win.end;
      out.clipped = win.clipped;
      if (win.clipped) out.notes.push(`End date shortened to ${win.end}, the end of the paid period`);

      if (seat) {
        out.action = 'extend';
        out.seatId = seat.id;
        if (seatStatusOf(seat) !== 'active') out.notes.push('Member is suspended: access is recorded but they stay blocked until reactivated');
        continue;
      }

      if (seatsLeft <= 0) {
        out.error = `No seats left (limit ${seatLimit})`;
        continue;
      }
      seatsLeft -= 1;
      out.action = user ? 'add_existing' : 'new_user';
    }

    const count = (a) => plan.filter((p) => p.action === a).length;
    const summary = {
      total: plan.length,
      newUsers: count('new_user'),
      addExisting: count('add_existing'),
      extend: count('extend'),
      keep: count('keep'),
      errors: count('error'),
      clipped: plan.filter((p) => p.clipped).length
    };
    return { plan, summary };
  }

  // ---- public API ------------------------------------------------------------

  const api = {
    OrgError,
    context,

    async summary(actorUserId) {
      const ctx = await context(actorUserId);
      const today = todayIso();
      const soon = addDays(today, EXPIRING_SOON_DAYS);
      const [inUse, suspended, contracts, windows, pendingInvites] = await Promise.all([
        activeSeatCount(ctx.orgId),
        q(SEAT).count({ where: { organization: { id: ctx.orgId }, active: false } }),
        contractRows(ctx.orgId),
        q(ENT).findMany({
          where: { organization: { id: ctx.orgId }, scope: 'org_member', revokedAt: { $null: true }, coverageEnd: { $gte: today } },
          select: ['coverageStart', 'coverageEnd'],
          populate: { user: { select: ['id'] } }
        }),
        q(SEAT).count({
          where: {
            organization: { id: ctx.orgId },
            user: { accountSource: { $in: ['org_invite', 'org_import'] }, passwordSetAt: { $null: true } }
          }
        })
      ]);

      // A member is "expiring soon" if their furthest window ends within 14 days.
      const furthest = new Map();
      for (const w of windows) {
        const id = w.user?.id;
        if (id && (!furthest.has(id) || w.coverageEnd > furthest.get(id))) furthest.set(id, w.coverageEnd);
      }
      const expiringSoon = [...furthest.values()].filter((end) => end <= soon).length;
      const merged = mergeRanges(contracts);
      const current = merged.find((r) => r.start <= today && today <= r.end) || null;
      const next = merged.find((r) => r.start > today) || null;

      // Per publication: seats on the governing contract and seats in use.
      // No amounts: what the organisation paid is New Vision's business.
      const publications = await store().publicationSeatUse(ctx.orgId);

      return {
        organisation: { id: ctx.orgId, name: ctx.org.name, status: orgStatusOf(ctx.org) },
        you: { email: ctx.actorEmail, seatId: ctx.actorSeatId },
        seats: { inUse, suspended, limit: ctx.org.seatLimit ?? null },
        publications,
        paidPeriod: { current, next, ranges: merged },
        expiringSoon,
        pendingInvites
      };
    },

    async listMembers(actorUserId, query) {
      const ctx = await context(actorUserId);
      return store().listMembers(ctx.orgId, query || {});
    },

    async listAudit(actorUserId, query) {
      const ctx = await context(actorUserId);
      return store().listAudit(ctx.orgId, query || {});
    },

    /** body: { email, displayName?, phone?, coverageStart?, coverageEnd?, months?,
     *          publications? }  publications: codes; default = every paid
     *          publication with a free seat */
    async addMember(actorUserId, body) {
      const ctx = await context(actorUserId);
      const email = normEmail(body.email);
      if (!EMAIL_RE.test(email)) throw new OrgError(400, 'A valid email is required');

      const win = resolveWindow(mergeRanges(await contractRows(ctx.orgId)), body);
      const existingUser = await q(USER).findOne({ where: { email } });
      if (existingUser) {
        const seat = await q(SEAT).findOne({
          where: { user: { id: existingUser.id } },
          populate: { organization: { select: ['id'] } }
        });
        if (seat && seat.organization?.id === ctx.orgId) {
          throw new OrgError(409, `${email} is already a member. Use "Extend access" instead.`);
        }
        if (seat) throw new OrgError(409, `${email} already belongs to another organisation`);
      }
      if (ctx.org.seatLimit !== null && ctx.org.seatLimit !== undefined) {
        if ((await activeSeatCount(ctx.orgId)) >= ctx.org.seatLimit) {
          throw new OrgError(409, `All ${ctx.org.seatLimit} seats are in use. Suspend or remove someone first.`);
        }
      }

      let inviteToken = null;
      const result = await strapi.db.transaction(async () => {
        let user = existingUser;
        if (!user) {
          const created = await createInvitedUser({
            email, displayName: body.displayName, phone: body.phone, accountSource: 'org_invite'
          });
          user = created.user;
          inviteToken = created.inviteToken;
          await audit({ orgId: ctx.orgId, actorUserId: ctx.actorUserId, action: 'member.invite', targetUserId: user.id, targetEmail: email });
        }
        const seat = await q(SEAT).create({
          data: {
            organization: ctx.orgId, user: user.id, role: 'member', status: 'active', source: 'manual', addedBy: ctx.actorUserId,
            publicationCodes: []
          }
        });
        await audit({ orgId: ctx.orgId, actorUserId: ctx.actorUserId, action: 'member.add', targetUserId: user.id, targetEmail: email });
        const wanted = Array.isArray(body.publications) ? body.publications : await store().defaultSeatPublications(ctx.orgId);
        await store().setSeatPublications(ctx.orgId, seat.id, wanted, { actorUserId: ctx.actorUserId });
        const access = await applyWindow({
          orgId: ctx.orgId, userId: user.id, email, start: win.start, end: win.end,
          actorUserId: ctx.actorUserId, source: 'org_admin'
        });
        return { seatId: seat.id, userId: user.id, access };
      });

      let emailSent = null;
      if (inviteToken) {
        emailSent = await sendInvite({
          email, displayName: body.displayName, orgName: ctx.org.name, inviterName: ctx.actorName, token: inviteToken
        });
      }
      return { ...result, invited: Boolean(inviteToken), emailSent, clipped: win.clipped, paidUntil: win.paidUntil };
    },

    /** body: { coverageStart?, coverageEnd?, months? } */
    async grantAccess(actorUserId, seatId, body) {
      const ctx = await context(actorUserId);
      const seat = await loadSeatInOrg(ctx.orgId, seatId);
      const win = resolveWindow(mergeRanges(await contractRows(ctx.orgId)), body || {});
      const access = await applyWindow({
        orgId: ctx.orgId, userId: seat.user.id, email: seat.user.email, start: win.start, end: win.end,
        actorUserId: ctx.actorUserId, source: 'org_admin'
      });
      return { access, clipped: win.clipped, paidUntil: win.paidUntil };
    },

    /** body: { status: active|suspended, reason? } */
    async setStatus(actorUserId, seatId, body) {
      const ctx = await context(actorUserId);
      const seat = await loadSeatInOrg(ctx.orgId, seatId);
      if (seat.id === ctx.actorSeatId) throw new OrgError(409, 'You cannot change your own status');
      const status = String(body.status || '');
      if (!['active', 'suspended'].includes(status)) throw new OrgError(400, 'status must be active or suspended');
      const from = seatStatusOf(seat);
      if (from === status) throw new OrgError(409, `Member is already ${status}`);
      if (status === 'active' && ctx.org.seatLimit !== null && ctx.org.seatLimit !== undefined) {
        if ((await activeSeatCount(ctx.orgId)) >= ctx.org.seatLimit) throw new OrgError(409, `All ${ctx.org.seatLimit} seats are in use`);
      }
      if (status === 'active') await store().assertRoomForSeat(ctx.orgId, seat);
      const reason = String(body.reason || '').trim() || null;
      await q(SEAT).update({
        where: { id: seat.id },
        data: status === 'active' ? { status } : { status, suspendedReason: reason }
      });
      await audit({
        orgId: ctx.orgId, actorUserId: ctx.actorUserId, action: status === 'active' ? 'member.reactivate' : 'member.suspend',
        targetUserId: seat.user.id, targetEmail: seat.user.email, meta: { reason }
      });
      return { success: true, status };
    },

    /** body: { role: member|admin } */
    async setRole(actorUserId, seatId, body) {
      const ctx = await context(actorUserId);
      const seat = await loadSeatInOrg(ctx.orgId, seatId);
      if (seat.id === ctx.actorSeatId) throw new OrgError(409, 'You cannot change your own role');
      const role = String(body.role || '');
      if (!['member', 'admin'].includes(role)) throw new OrgError(400, 'role must be member or admin');
      const from = seat.role || 'member';
      if (from === role) throw new OrgError(409, `Member is already ${role === 'admin' ? 'an admin' : 'a member'}`);
      await q(SEAT).update({ where: { id: seat.id }, data: { role } });
      if (role === 'member') {
        const org = await q(ORG).findOne({ where: { id: ctx.orgId }, populate: { owner: { select: ['id'] } } });
        if (org.owner?.id === seat.user.id) await q(ORG).update({ where: { id: ctx.orgId }, data: { owner: ctx.actorUserId } });
      }
      await audit({
        orgId: ctx.orgId, actorUserId: ctx.actorUserId, action: 'member.role',
        targetUserId: seat.user.id, targetEmail: seat.user.email, meta: { from, to: role }
      });
      return { success: true, role };
    },

    /** Removes the seat and revokes the member's org access. Their reader account stays. */
    async removeMember(actorUserId, seatId, body) {
      const ctx = await context(actorUserId);
      const seat = await loadSeatInOrg(ctx.orgId, seatId);
      if (seat.id === ctx.actorSeatId) throw new OrgError(409, 'You cannot remove yourself');
      const reason = String(body?.reason || '').trim() || null;

      await strapi.db.transaction(async () => {
        const windows = await q(ENT).findMany({
          where: { organization: { id: ctx.orgId }, user: { id: seat.user.id }, scope: 'org_member', revokedAt: { $null: true } },
          select: ['id']
        });
        for (const w of windows) {
          await q(ENT).update({ where: { id: w.id }, data: { revokedAt: new Date(), revokedReason: 'removed from organisation' } });
        }
        await q(SEAT).delete({ where: { id: seat.id } });
        const org = await q(ORG).findOne({ where: { id: ctx.orgId }, populate: { owner: { select: ['id'] } } });
        if (org.owner?.id === seat.user.id) await q(ORG).update({ where: { id: ctx.orgId }, data: { owner: ctx.actorUserId } });
        await audit({
          orgId: ctx.orgId, actorUserId: ctx.actorUserId, action: 'member.remove',
          targetUserId: seat.user.id, targetEmail: seat.user.email, meta: { reason, windowsRevoked: windows.length }
        });
      });
      return { success: true };
    },

    /** body: { publications: ['NV', 'BK'] } — which paid publications this member reads. */
    async setMemberPublications(actorUserId, seatId, body) {
      const ctx = await context(actorUserId);
      return store().setSeatPublications(ctx.orgId, seatId, body?.publications, { actorUserId: ctx.actorUserId });
    },

    async resendInvite(actorUserId, seatId) {
      const ctx = await context(actorUserId);
      const seat = await loadSeatInOrg(ctx.orgId, seatId);
      const pending = ['org_invite', 'org_import'].includes(seat.user.accountSource) && !seat.user.passwordSetAt;
      if (!pending) throw new OrgError(409, 'This member has already set up their account');
      const invite = newInvite(seat.user.id);
      await q(USER).update({ where: { id: seat.user.id }, data: invite.data });
      await audit({ orgId: ctx.orgId, actorUserId: ctx.actorUserId, action: 'member.invite', targetUserId: seat.user.id, targetEmail: seat.user.email, meta: { resend: true } });
      const emailSent = await sendInvite({
        email: seat.user.email, displayName: seat.user.displayName, orgName: ctx.org.name, inviterName: ctx.actorName, token: invite.token
      });
      return { success: true, emailSent };
    },

    // ---- Excel import ----------------------------------------------------

    /** body: { filename, rows: [{ row, email, displayName, phone, coverageStart, coverageEnd, months }],
     *          defaults?: { coverageStart?, coverageEnd?, months? } } */
    async previewImport(actorUserId, body) {
      return previewImportCtx(await context(actorUserId), body);
    },
    async adminPreviewImport(orgId, actorAdminId, body) {
      return previewImportCtx(await adminContext(orgId, actorAdminId), body);
    },
    async commitImport(actorUserId, importIdRaw) {
      return commitImportCtx(await context(actorUserId), importIdRaw);
    },
    async adminCommitImport(orgId, actorAdminId, importIdRaw) {
      return commitImportCtx(await adminContext(orgId, actorAdminId), importIdRaw);
    },
    async exportMembers(actorUserId) {
      return exportMembersCtx(await context(actorUserId));
    },
    async adminExportMembers(orgId, actorAdminId) {
      return exportMembersCtx(await adminContext(orgId, actorAdminId));
    },

    // ---- invite acceptance (no Org Admin involved) -----------------------

    async inspectInvite(token) {
      const user = await findInvitedUser(token);
      const seat = await q(SEAT).findOne({ where: { user: { id: user.id } }, populate: { organization: { select: ['name'] } } });
      return { email: user.email, displayName: user.displayName || '', organisation: seat?.organization?.name || null };
    },

    /** Sets the password, clears the invite, and returns what the middleware
     * needs to issue a session (same shape as verify-credentials). */
    async acceptInvite(token, password, displayName) {
      if (!password || String(password).length < 8) throw new OrgError(400, 'Password must be at least 8 characters');
      const user = await findInvitedUser(token);
      const passwordHash = await userService().hashPassword(String(password));
      const updated = await q(USER).update({
        where: { id: user.id },
        data: {
          passwordHash,
          inviteTokenHash: null,
          inviteExpiresAt: null,
          passwordSetAt: new Date(),
          active: true,
          tokenVersion: (user.tokenVersion || 0) + 1,
          ...(displayName ? { displayName: String(displayName).trim() } : {})
        }
      });
      return { success: true, user: userService().toPublicProfile(updated), tokenVersion: updated.tokenVersion };
    }
  };

  // ---- import / export internals (ctx = Org Admin or handle admin) ---------

  async function previewImportCtx(ctx, body) {
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) throw new OrgError(400, 'The file has no rows');
    if (rows.length > MAX_IMPORT_ROWS) throw new OrgError(400, `The file has ${rows.length} rows; the limit is ${MAX_IMPORT_ROWS}`);
    const defaults = body.defaults || {};

    const { plan, summary } = await planRows(ctx, rows, defaults);
    const record = await q(IMPORT).create({
      data: {
        organization: ctx.orgId, uploadedBy: ctx.actorUserId, uploadedByAdmin: ctx.actorAdminId, filename: String(body.filename || 'upload').slice(0, 200),
        status: 'previewed', rowCount: plan.length, summary: { ...summary, defaults }, rows: plan
      }
    });
    await audit({ orgId: ctx.orgId, ...actorOf(ctx), action: 'import.preview', meta: { importId: record.id, filename: record.filename, ...summary } });
    return { importId: record.id, summary, rows: plan };
  }

  /**
   * Applies a previewed import. State is re-planned from the stored INPUT
   * rows so that anything that changed since the preview (a seat taken, an
   * account created) is handled correctly, all in one transaction. Rows that
   * became errors are skipped and reported. Invite emails go out after commit.
   */
  async function commitImportCtx(ctx, importIdRaw) {
    const importId = toId(importIdRaw);
    const rec = await q(IMPORT).findOne({ where: { id: importId }, populate: { organization: { select: ['id'] } } });
    if (!rec || rec.organization?.id !== ctx.orgId) throw new OrgError(404, 'Import not found');
    if (rec.status !== 'previewed') throw new OrgError(409, `This import is already ${rec.status}`);
    if (Date.now() - new Date(rec.createdAt).getTime() > IMPORT_TTL_HOURS * 3600000) {
      await q(IMPORT).update({ where: { id: importId }, data: { status: 'expired' } });
      throw new OrgError(409, 'This preview is more than a day old. Upload the file again.');
    }

    // Claim it. Only one concurrent commit can flip previewed -> committing.
    const claimed = await q(IMPORT).updateMany({ where: { id: importId, status: 'previewed' }, data: { status: 'committing' } });
    if (!claimed?.count) throw new OrgError(409, 'This import is already being applied');

    const storedRows = Array.isArray(rec.rows) ? rec.rows : [];
    const defaults = rec.summary?.defaults || {};
    // Re-plan from the original inputs: the preview's start/end are kept by
    // passing them as explicit dates, so clipping decisions don't move.
    const inputs = storedRows.map((r) => ({
      row: r.row, email: r.email, displayName: r.displayName, phone: r.phone,
      coverageStart: r.start || null, coverageEnd: r.end || null
    }));

    const invites = [];
    const counts = { created: 0, added: 0, extended: 0, unchanged: 0, kept: 0, skipped: 0 };
    let finalPlan;
    try {
      await strapi.db.transaction(async () => {
        const { plan } = await planRows(ctx, inputs, defaults);
        finalPlan = plan;
        for (const p of plan) {
          if (p.action === 'error') { counts.skipped++; continue; }
          if (p.action === 'keep') { counts.kept++; continue; }
          let userId = p.userId;
          if (p.action === 'new_user') {
            const created = await createInvitedUser({ email: p.email, displayName: p.displayName, phone: p.phone, accountSource: 'org_import' });
            userId = created.user.id;
            invites.push({ email: p.email, displayName: p.displayName, token: created.inviteToken });
            await audit({ orgId: ctx.orgId, ...actorOf(ctx), action: 'member.invite', targetUserId: userId, targetEmail: p.email, meta: { importId } });
          }
          if (p.action === 'new_user' || p.action === 'add_existing') {
            await q(SEAT).create({
              data: {
                organization: ctx.orgId, user: userId, role: 'member', status: 'active', source: 'import',
                addedBy: ctx.actorUserId, addedByAdmin: ctx.actorAdminId,
                // Spreadsheet columns per publication come in a follow-up; until
                // then imported members get every paid publication with a free seat.
                publicationCodes: await store().defaultSeatPublications(ctx.orgId)
              }
            });
            await audit({ orgId: ctx.orgId, ...actorOf(ctx), action: 'member.add', targetUserId: userId, targetEmail: p.email, meta: { importId } });
            if (p.action === 'new_user') counts.created++; else counts.added++;
          }
          const res = await applyWindow({
            orgId: ctx.orgId, userId, email: p.email, start: p.start, end: p.end, ...actorOf(ctx), source: 'import'
          });
          if (p.action === 'extend') {
            if (res.action === 'unchanged') counts.unchanged++; else counts.extended++;
          }
        }
      });
    } catch (err) {
      await q(IMPORT).update({ where: { id: importId }, data: { status: 'failed', error: String(err.message || err).slice(0, 1000) } });
      await audit({ orgId: ctx.orgId, ...actorOf(ctx), action: 'import.fail', meta: { importId, error: String(err.message || err).slice(0, 300) } });
      throw err.status ? err : new OrgError(500, 'The import could not be applied. Nothing was changed.');
    }

    await q(IMPORT).update({
      where: { id: importId },
      data: { status: 'committed', committedAt: new Date(), rows: finalPlan, summary: { ...rec.summary, result: counts } }
    });
    await audit({ orgId: ctx.orgId, ...actorOf(ctx), action: 'import.commit', meta: { importId, ...counts, invites: invites.length } });

    // Fire-and-forget: a large import shouldn't hold the request open while
    // hundreds of emails go out. Failures are logged; "Resend invite" on the
    // member row covers anyone who didn't receive one.
    if (invites.length) {
      (async () => {
        let sent = 0;
        for (const inv of invites) {
          if (await sendInvite({ ...inv, orgName: ctx.org.name, inviterName: ctx.actorName })) sent++;
        }
        strapi.log.info(`[org-members] import ${importId}: ${sent}/${invites.length} invite emails sent`);
      })();
    }

    return { importId, result: counts, invitesQueued: invites.length, rows: finalPlan };
  }

  /** Current members as plain rows for the downloadable spreadsheet. */
  async function exportMembersCtx(ctx) {
    const today = todayIso();
    const seats = await q(SEAT).findMany({
      where: { organization: { id: ctx.orgId } },
      orderBy: { assignedAt: 'asc' },
      populate: { user: { select: ['id', 'email', 'displayName', 'phone', 'accountSource', 'passwordSetAt'] } }
    });
    const userIds = seats.map((s) => s.user?.id).filter(Boolean);
    const windows = userIds.length
      ? await q(ENT).findMany({
          where: { organization: { id: ctx.orgId }, scope: 'org_member', revokedAt: { $null: true }, user: { id: { $in: userIds } } },
          select: ['coverageStart', 'coverageEnd'],
          populate: { user: { select: ['id'] } }
        })
      : [];
    const byUser = new Map();
    for (const w of windows) {
      const list = byUser.get(w.user?.id) || [];
      list.push(w);
      byUser.set(w.user?.id, list);
    }
    const members = seats.filter((s) => s.user).map((s) => {
      const list = byUser.get(s.user.id) || [];
      const current = list.find((w) => w.coverageStart <= today && today <= w.coverageEnd);
      const latestEnd = list.reduce((m, w) => (w.coverageEnd > m ? w.coverageEnd : m), '') || null;
      return {
        email: s.user.email,
        displayName: s.user.displayName || '',
        phone: s.user.phone || '',
        role: s.role || 'member',
        status: seatStatusOf(s),
        accessEnds: s.source === 'legacy' ? 'whole paid period' : (current ? current.coverageEnd : latestEnd),
        publications: (() => {
          const codes = store().seatCodes(s);
          return codes === null ? 'all' : (codes.length ? codes.join(', ') : 'none');
        })(),
        inviteAccepted: !(['org_invite', 'org_import'].includes(s.user.accountSource) && !s.user.passwordSetAt)
      };
    });
    const merged = mergeRanges(await contractRows(ctx.orgId));
    const paid = merged.find((r) => r.start <= today && today <= r.end) || merged.find((r) => r.start > today) || null;
    return { organisation: { id: ctx.orgId, name: ctx.org.name }, paidUntil: paid?.end || null, members };
  }

  function actorOf(ctx) {
    return { actorUserId: ctx.actorUserId || null, actorAdminId: ctx.actorAdminId || null };
  }

  return api;
};
