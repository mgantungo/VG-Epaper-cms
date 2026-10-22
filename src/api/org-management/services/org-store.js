'use strict';

/**
 * apps/cms/src/api/org-management/services/org-store.js
 * Phase 2 file (organisation management, handle side), UPDATED in Phase 3:
 * listMembers now also returns invitePending per member. org-members.js
 * reuses listMembers and listAudit for the Org Admin dashboard.
 *
 * All organisation, contract and admin-assignment logic lives here, inside
 * Strapi, so that multi-row writes (create org + contract + admin seat +
 * member window) run in ONE database transaction. Every write also lands in
 * epaper-org-audit.
 *
 * Callers: controllers/org-handle.js only, which in turn is only reachable
 * with STRAPI_API_TOKEN, i.e. from the middleware (routes/adminOrgs.js).
 * The acting handle admin's id arrives in the x-actor-admin-id header,
 * which the middleware sets from the admin's verified JWT.
 *
 * Vocabulary:
 *   contract      = epaper-entitlement, scope org_contract, the window the org paid for
 *   member window = epaper-entitlement, scope org_member, one member's access
 *   seats in use  = ACTIVE seats only. Suspending a member frees a seat.
 *
 * Phase 0 (publications, 23 Oct 2026): a contract is per PUBLICATION. One
 * "paid period" from handle creates one org_contract row per publication,
 * each with its own seats and hand-entered amount (organisations are priced
 * by hand; there is no plan behind a contract). Each member seat lists the
 * publications it reads (publicationCodes); a publication's active seats can
 * never exceed the seats on its current contract.
 *
 * All DB access via strapi.db.query(...), per this project's convention.
 */

const ORG = 'api::epaper-organization.epaper-organization';
const SEAT = 'api::epaper-org-seat.epaper-org-seat';
const ENT = 'api::epaper-entitlement.epaper-entitlement';
const USER = 'api::epaper-user.epaper-user';
const AUDIT = 'api::epaper-org-audit.epaper-org-audit';
const HADMIN = 'api::handle-admin.handle-admin';
const PUB = 'api::publication.publication';
const { kampalaToday } = require('../../../utils/epaper-dates');

class OrgError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Kampala calendar day, the same "today" the middleware's access check uses.
const todayIso = () => kampalaToday();

function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

function requireRange(start, end) {
  if (!isIsoDate(start) || !isIsoDate(end)) throw new OrgError(400, 'coverageStart and coverageEnd must be YYYY-MM-DD');
  if (start > end) throw new OrgError(400, 'coverageStart must be on or before coverageEnd');
}

function toId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new OrgError(400, 'Invalid id');
  return n;
}

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

function orgStatusOf(org) {
  return org.status || (org.active === false ? 'suspended' : 'active');
}

function isContract(e) {
  return e.scope ? e.scope === 'org_contract' : !e.user;
}

function pageArgs(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize, 10) || 25));
  return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
}

const normCode = (c) => String(c || '').trim().toUpperCase();

/** A seat's publications: an explicit list (possibly empty), or null
 * meaning "all the organisation pays for" (seats created before
 * per-publication seats). */
function seatCodes(seat) {
  // An empty list is a real choice (reads nothing through the organisation);
  // only a missing list means "everything".
  return Array.isArray(seat.publicationCodes) ? seat.publicationCodes.map(normCode) : null;
}

function publicUser(u) {
  return u ? { id: u.id, email: u.email, displayName: u.displayName || '', phone: u.phone || '' } : null;
}

module.exports = ({ strapi }) => {
  const q = (uid) => strapi.db.query(uid);

  async function audit({ orgId, actorAdminId, actorUserId, action, targetUserId, targetEmail, meta }) {
    await q(AUDIT).create({
      data: {
        organization: orgId || null,
        actorAdmin: actorAdminId || null,
        actorUser: actorUserId || null,
        action,
        targetUser: targetUserId || null,
        targetEmail: targetEmail || null,
        meta: meta || null
      }
    });
  }

  async function loadOrg(orgId) {
    const org = await q(ORG).findOne({
      where: { id: orgId },
      populate: { owner: { select: ['id', 'email', 'displayName'] } }
    });
    if (!org) throw new OrgError(404, 'Organisation not found');
    return org;
  }

  async function activeSeatCount(orgId) {
    return q(SEAT).count({ where: { organization: { id: orgId }, active: true } });
  }

  async function contractsFor(orgId) {
    const rows = await q(ENT).findMany({
      where: {
        organization: { id: orgId },
        revokedAt: { $null: true },
        $or: [{ scope: 'org_contract' }, { scope: { $null: true } }]
      },
      orderBy: { coverageStart: 'asc' },
      populate: {
        user: { select: ['id'] },
        plan: { select: ['id', 'key', 'label'] },
        publication: { select: ['id', 'code', 'name', 'colour'] }
      }
    });
    return rows.filter(isContract).map((e) => ({
      id: e.id,
      publication: e.publication ? { code: e.publication.code, name: e.publication.name, colour: e.publication.colour || null } : null,
      coverageStart: e.coverageStart,
      coverageEnd: e.coverageEnd,
      seats: e.seats ?? null,
      plan: e.plan ? { key: e.plan.key, label: e.plan.label } : null,
      amountPaid: e.amountPaid === null || e.amountPaid === undefined ? null : Number(e.amountPaid),
      currency: e.currency || null,
      reference: e.reference || null,
      note: e.note || null,
      createdAt: e.createdAt
    }));
  }

  /**
   * Per publication: the contract that governs seats today (the current one,
   * else the next upcoming), its seats, and how many ACTIVE member seats read
   * it. Seats with no explicit list (older seats) count against every
   * publication the organisation has.
   */
  async function publicationSeatUse(orgId, contracts) {
    const list = contracts || (await contractsFor(orgId));
    const today = todayIso();
    const seats = await q(SEAT).findMany({
      where: { organization: { id: orgId }, active: true },
      select: ['id', 'publicationCodes']
    });
    const byCode = new Map();
    for (const c of list) {
      if (!c.publication) continue;
      const code = c.publication.code;
      const entry = byCode.get(code) || { code, name: c.publication.name, colour: c.publication.colour, current: null, next: null, latestEnd: null };
      if (c.coverageStart <= today && today <= c.coverageEnd) {
        if (!entry.current || c.coverageEnd > entry.current.coverageEnd) entry.current = c;
      } else if (c.coverageStart > today) {
        if (!entry.next || c.coverageStart < entry.next.coverageStart) entry.next = c;
      }
      if (!entry.latestEnd || c.coverageEnd > entry.latestEnd) entry.latestEnd = c.coverageEnd;
      byCode.set(code, entry);
    }
    return [...byCode.values()].map((e) => {
      const governing = e.current || e.next;
      const inUse = seats.filter((s) => {
        const codes = seatCodes(s);
        return codes === null || codes.includes(e.code);
      }).length;
      return {
        code: e.code,
        name: e.name,
        colour: e.colour || null,
        seats: governing ? governing.seats ?? null : null,
        inUse,
        current: e.current ? { start: e.current.coverageStart, end: e.current.coverageEnd } : null,
        next: e.next ? { start: e.next.coverageStart, end: e.next.coverageEnd } : null,
        latestEnd: e.latestEnd
      };
    }).sort((a, b) => a.code.localeCompare(b.code));
  }

  /** Publications a new member gets by default: every one with a current or
   * upcoming contract that still has a free seat. */
  async function defaultSeatPublications(orgId) {
    const use = await publicationSeatUse(orgId);
    return use
      .filter((u) => (u.current || u.next) && (u.seats === null || u.inUse < u.seats))
      .map((u) => u.code);
  }

  /** Before (re)activating a seat: every publication it reads must still have a free seat. */
  async function assertRoomForSeat(orgId, seat) {
    const use = await publicationSeatUse(orgId);
    const codes = seatCodes(seat) || use.map((u) => u.code);
    for (const code of codes) {
      const u = use.find((x) => x.code === code);
      if (u && u.seats !== null && u.inUse >= u.seats) {
        throw new OrgError(409, `All ${u.seats} ${code} seats are in use. Free one, or remove ${code} from this member first.`);
      }
    }
  }

  /** Validates contract lines: [{ publicationCode, seats, amount, currency? }]. */
  async function cleanContractLines(lines) {
    if (!Array.isArray(lines) || !lines.length) throw new OrgError(400, 'Add at least one publication to the paid period');
    const codes = lines.map((l) => normCode(l.publicationCode));
    if (new Set(codes).size !== codes.length) throw new OrgError(400, 'Each publication can appear only once in a paid period');
    const pubs = await q(PUB).findMany({ where: { code: { $in: codes } } });
    return lines.map((l, i) => {
      const pub = pubs.find((p) => p.code === codes[i]);
      if (!pub) throw new OrgError(400, `Unknown publication "${codes[i]}"`);
      const seats = Number(l.seats);
      if (!Number.isInteger(seats) || seats < 1) throw new OrgError(400, `${pub.code}: seats must be a whole number, 1 or more`);
      const amount = l.amount === undefined || l.amount === null || l.amount === '' ? null : Number(l.amount);
      if (amount !== null && (!Number.isInteger(amount) || amount < 0)) throw new OrgError(400, `${pub.code}: amount must be a whole number of shillings`);
      return { pub, seats, amount, currency: String(l.currency || 'UGX').toUpperCase() };
    });
  }

  /** Creates one org_contract row per line, inside the caller's transaction. */
  async function createContractRows(orgId, { coverageStart, coverageEnd, reference, note }, lines, actorAdminId) {
    const rows = [];
    for (const line of lines) {
      const row = await q(ENT).create({
        data: {
          organization: orgId,
          scope: 'org_contract',
          grantSource: 'handle',
          grantedByAdmin: actorAdminId || null,
          publication: line.pub.id,
          coverageStart,
          coverageEnd,
          seats: line.seats,
          amountPaid: line.amount,
          amountAllocated: line.amount,
          currency: line.currency,
          reference: reference ? String(reference).slice(0, 120) : null,
          note: note || null
        }
      });
      await audit({
        orgId, actorAdminId, action: 'contract.create',
        meta: { contractId: row.id, publication: line.pub.code, seats: line.seats, coverageStart, coverageEnd, reference: reference || null }
      });
      rows.push(row);
    }
    return rows;
  }

  function summarizeContracts(contracts) {
    const today = todayIso();
    const current = contracts.find((c) => c.coverageStart <= today && today <= c.coverageEnd) || null;
    const upcoming = contracts.filter((c) => c.coverageStart > today);
    const latestEnd = contracts.reduce((m, c) => (c.coverageEnd > m ? c.coverageEnd : m), '') || null;
    return { current, upcomingCount: upcoming.length, latestEnd };
  }

  // The window a newly assigned admin gets by default: the whole current
  // contract (so they can read every paper the org has paid for), or
  // failing that the next upcoming one.
  function defaultWindow(contracts) {
    const today = todayIso();
    const current = contracts.find((c) => c.coverageStart <= today && today <= c.coverageEnd);
    if (current) return { start: current.coverageStart, end: current.coverageEnd };
    const next = contracts.find((c) => c.coverageStart > today);
    return next ? { start: next.coverageStart, end: next.coverageEnd } : null;
  }

  async function findUserByEmail(email) {
    const e = normEmail(email);
    if (!e || !e.includes('@')) throw new OrgError(400, 'A valid email is required');
    const user = await q(USER).findOne({ where: { email: e } });
    if (!user) {
      throw new OrgError(404, `No reader account exists for ${e}. Ask them to register on the e-paper site first.`);
    }
    return user;
  }

  async function seatOf(userId) {
    return q(SEAT).findOne({
      where: { user: { id: userId } },
      populate: { organization: { select: ['id', 'name'] }, user: { select: ['id', 'email', 'displayName'] } }
    });
  }

  async function loadSeatInOrg(orgId, seatId) {
    const seat = await q(SEAT).findOne({
      where: { id: seatId },
      populate: { organization: { select: ['id'] }, user: { select: ['id', 'email', 'displayName'] } }
    });
    if (!seat || seat.organization?.id !== orgId) throw new OrgError(404, 'Member not found in this organisation');
    return seat;
  }

  return {
    OrgError,

    // ---- handle admin rights ------------------------------------------------

    async handleAdminRights(adminId) {
      const admin = await q(HADMIN).findOne({
        where: { id: toId(adminId) },
        select: ['id', 'active', 'canManageEditions', 'canManageOrganizations', 'isSuperAdmin']
      });
      if (!admin) throw new OrgError(404, 'Admin not found');
      const isSuperAdmin = admin.isSuperAdmin === true;
      return {
        id: admin.id,
        active: admin.active !== false,
        isSuperAdmin,
        canManageEditions: isSuperAdmin || admin.canManageEditions !== false,
        canManageOrganizations: isSuperAdmin || admin.canManageOrganizations === true
      };
    },

    // ---- organisations ------------------------------------------------------

    async listOrgs(query) {
      const { page, pageSize, offset, limit } = pageArgs(query);
      const where = {};
      if (query.search) where.name = { $containsi: String(query.search).trim() };
      if (query.status) where.status = String(query.status);

      const [rows, total] = await Promise.all([
        q(ORG).findMany({
          where,
          orderBy: { name: 'asc' },
          offset,
          limit,
          populate: { owner: { select: ['id', 'email', 'displayName'] } }
        }),
        q(ORG).count({ where })
      ]);

      const organisations = await Promise.all(
        rows.map(async (org) => {
          const [seatsInUse, contracts] = await Promise.all([activeSeatCount(org.id), contractsFor(org.id)]);
          return {
            id: org.id,
            name: org.name,
            status: orgStatusOf(org),
            seatLimit: org.seatLimit ?? null,
            seatsInUse,
            owner: publicUser(org.owner),
            contract: summarizeContracts(contracts),
            createdAt: org.createdAt
          };
        })
      );

      return { organisations, pagination: { page, pageSize, total, pageCount: Math.ceil(total / pageSize) } };
    },

    async getOrg(orgIdRaw) {
      const orgId = toId(orgIdRaw);
      const org = await loadOrg(orgId);
      const [contracts, seatsInUse, suspendedSeats, adminSeats] = await Promise.all([
        contractsFor(orgId),
        activeSeatCount(orgId),
        q(SEAT).count({ where: { organization: { id: orgId }, active: false } }),
        q(SEAT).findMany({
          where: { organization: { id: orgId }, role: 'admin' },
          populate: { user: { select: ['id', 'email', 'displayName', 'phone'] } }
        })
      ]);

      const publications = await publicationSeatUse(orgId, contracts);

      return {
        organisation: {
          id: org.id,
          name: org.name,
          status: orgStatusOf(org),
          seatLimit: org.seatLimit ?? null,
          contactName: org.contactName || null,
          contactEmail: org.contactEmail || null,
          contactPhone: org.contactPhone || null,
          notes: org.notes || null,
          suspendedAt: org.suspendedAt || null,
          suspendedReason: org.suspendedReason || null,
          owner: publicUser(org.owner),
          createdAt: org.createdAt
        },
        seats: { inUse: seatsInUse, suspended: suspendedSeats, limit: org.seatLimit ?? null },
        contracts,
        contractSummary: summarizeContracts(contracts),
        publications,
        admins: adminSeats.map((s) => ({
          seatId: s.id,
          status: s.status || (s.active === false ? 'suspended' : 'active'),
          user: publicUser(s.user)
        }))
      };
    },

    /**
     * body: { name, seatLimit?, contactName?, contactEmail?, contactPhone?, notes?,
     *         contract?: { coverageStart, coverageEnd, planKey?, amountPaid?, currency?, note? },
     *         adminEmail? }
     */
    async createOrg(body, actorAdminId) {
      const name = String(body.name || '').trim();
      if (!name) throw new OrgError(400, 'name is required');

      const seatLimit = body.seatLimit === undefined || body.seatLimit === null || body.seatLimit === ''
        ? null
        : Number(body.seatLimit);
      if (seatLimit !== null && (!Number.isInteger(seatLimit) || seatLimit < 0)) {
        throw new OrgError(400, 'seatLimit must be a whole number, 0 or more');
      }
      if (seatLimit === 0 && body.adminEmail) throw new OrgError(400, 'seatLimit 0 leaves no seat for the admin');

      const clash = await q(ORG).findOne({ where: { name: { $eqi: name } } });
      if (clash) throw new OrgError(409, `An organisation named "${clash.name}" already exists`);

      const contract = body.contract || null;
      let contractLines = null;
      if (contract) {
        requireRange(contract.coverageStart, contract.coverageEnd);
        contractLines = await cleanContractLines(contract.lines);
      }

      // Validate the admin BEFORE writing anything, so a bad email can't
      // leave a half-created organisation behind.
      let adminUser = null;
      if (body.adminEmail) {
        adminUser = await findUserByEmail(body.adminEmail);
        const existingSeat = await seatOf(adminUser.id);
        if (existingSeat) {
          throw new OrgError(409, `${adminUser.email} already belongs to "${existingSeat.organization?.name || 'another organisation'}"`);
        }
      }

      const created = await strapi.db.transaction(async () => {
        const org = await q(ORG).create({
          data: {
            name,
            status: 'active',
            seatLimit,
            contactName: body.contactName || null,
            contactEmail: body.contactEmail ? normEmail(body.contactEmail) : null,
            contactPhone: body.contactPhone || null,
            notes: body.notes || null,
            createdByAdmin: actorAdminId || null,
            owner: adminUser ? adminUser.id : null
          }
        });
        await audit({ orgId: org.id, actorAdminId, action: 'org.create', meta: { name, seatLimit } });

        let contractRows = [];
        if (contract) {
          contractRows = await createContractRows(org.id, contract, contractLines, actorAdminId);
        }

        if (adminUser) {
          await q(SEAT).create({
            data: {
              organization: org.id,
              user: adminUser.id,
              role: 'admin',
              status: 'active',
              source: 'handle',
              addedByAdmin: actorAdminId || null,
              publicationCodes: contractLines ? contractLines.map((l) => l.pub.code) : []
            }
          });
          await audit({
            orgId: org.id, actorAdminId, action: 'member.add',
            targetUserId: adminUser.id, targetEmail: adminUser.email, meta: { role: 'admin' }
          });

          if (contractRows.length) {
            const win = defaultWindow([{ coverageStart: contract.coverageStart, coverageEnd: contract.coverageEnd }]);
            if (win) {
              await q(ENT).create({
                data: {
                  organization: org.id,
                  user: adminUser.id,
                  scope: 'org_member',
                  grantSource: 'handle',
                  grantedByAdmin: actorAdminId || null,
                  coverageStart: win.start,
                  coverageEnd: win.end
                }
              });
              await audit({
                orgId: org.id, actorAdminId, action: 'access.create',
                targetUserId: adminUser.id, targetEmail: adminUser.email, meta: win
              });
            }
          }
        }
        return org;
      });

      return this.getOrg(created.id);
    },

    async updateOrg(orgIdRaw, body, actorAdminId) {
      const orgId = toId(orgIdRaw);
      const org = await loadOrg(orgId);
      const data = {};
      const changes = {};

      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) throw new OrgError(400, 'name cannot be empty');
        if (name.toLowerCase() !== String(org.name).toLowerCase()) {
          const clash = await q(ORG).findOne({ where: { name: { $eqi: name }, id: { $ne: orgId } } });
          if (clash) throw new OrgError(409, `An organisation named "${clash.name}" already exists`);
        }
        data.name = name;
      }
      if (body.seatLimit !== undefined) {
        const v = body.seatLimit === null || body.seatLimit === '' ? null : Number(body.seatLimit);
        if (v !== null && (!Number.isInteger(v) || v < 0)) throw new OrgError(400, 'seatLimit must be a whole number, 0 or more');
        if (v !== null) {
          const inUse = await activeSeatCount(orgId);
          if (v < inUse) throw new OrgError(409, `${inUse} seats are in use. Suspend or remove members before lowering the limit to ${v}.`);
        }
        data.seatLimit = v;
      }
      for (const f of ['contactName', 'contactPhone', 'notes']) {
        if (body[f] !== undefined) data[f] = body[f] || null;
      }
      if (body.contactEmail !== undefined) data.contactEmail = body.contactEmail ? normEmail(body.contactEmail) : null;

      if (!Object.keys(data).length) throw new OrgError(400, 'Nothing to update');
      for (const k of Object.keys(data)) changes[k] = { from: org[k] ?? null, to: data[k] };

      await q(ORG).update({ where: { id: orgId }, data });
      await audit({ orgId, actorAdminId, action: 'org.update', meta: changes });
      return this.getOrg(orgId);
    },

    async setOrgStatus(orgIdRaw, body, actorAdminId) {
      const orgId = toId(orgIdRaw);
      const org = await loadOrg(orgId);
      const status = String(body.status || '');
      if (!['active', 'suspended', 'archived'].includes(status)) {
        throw new OrgError(400, 'status must be active, suspended or archived');
      }
      const reason = String(body.reason || '').trim();
      if (status !== 'active' && !reason) throw new OrgError(400, 'A reason is required to suspend or archive');
      const from = orgStatusOf(org);
      if (from === status) throw new OrgError(409, `Organisation is already ${status}`);

      await q(ORG).update({
        where: { id: orgId },
        data: status === 'active' ? { status } : { status, suspendedReason: reason }
      });
      const action = status === 'active' ? 'org.reactivate' : status === 'suspended' ? 'org.suspend' : 'org.archive';
      await audit({ orgId, actorAdminId, action, meta: { from, to: status, reason: reason || null } });
      return this.getOrg(orgId);
    },

    // ---- contracts ----------------------------------------------------------

    /**
     * One paid period, priced by hand per publication.
     * body: { coverageStart, coverageEnd, reference?, note?,
     *         lines: [{ publicationCode, seats, amount, currency? }] }
     */
    async addContract(orgIdRaw, body, actorAdminId) {
      const orgId = toId(orgIdRaw);
      await loadOrg(orgId);
      requireRange(body.coverageStart, body.coverageEnd);
      const lines = await cleanContractLines(body.lines);
      await strapi.db.transaction(async () => {
        await createContractRows(orgId, body, lines, actorAdminId);
      });
      return this.getOrg(orgId);
    },

    async updateContract(orgIdRaw, entIdRaw, body, actorAdminId) {
      const orgId = toId(orgIdRaw);
      const entId = toId(entIdRaw);
      const ent = await q(ENT).findOne({
        where: { id: entId },
        populate: { organization: { select: ['id'] }, user: { select: ['id'] } }
      });
      if (!ent || ent.organization?.id !== orgId || !isContract(ent)) throw new OrgError(404, 'Contract not found');
      if (ent.revokedAt) throw new OrgError(409, 'This contract has been revoked');

      const start = body.coverageStart ?? ent.coverageStart;
      const end = body.coverageEnd ?? ent.coverageEnd;
      requireRange(start, end);

      const data = { coverageStart: start, coverageEnd: end };
      if (body.note !== undefined) data.note = body.note || null;
      if (body.reference !== undefined) data.reference = body.reference ? String(body.reference).slice(0, 120) : null;
      if (body.seats !== undefined) {
        const seats = Number(body.seats);
        if (!Number.isInteger(seats) || seats < 1) throw new OrgError(400, 'seats must be a whole number, 1 or more');
        data.seats = seats;
      }
      if (body.amount !== undefined) {
        const amount = body.amount === null || body.amount === '' ? null : Number(body.amount);
        if (amount !== null && (!Number.isInteger(amount) || amount < 0)) throw new OrgError(400, 'amount must be a whole number of shillings');
        data.amountPaid = amount;
        data.amountAllocated = amount;
      }
      await q(ENT).update({ where: { id: entId }, data });
      await audit({
        orgId, actorAdminId, action: 'contract.extend',
        meta: {
          contractId: entId,
          from: { start: ent.coverageStart, end: ent.coverageEnd, seats: ent.seats ?? null },
          to: { start, end, seats: data.seats ?? ent.seats ?? null }
        }
      });
      return this.getOrg(orgId);
    },

    async revokeContract(orgIdRaw, entIdRaw, body, actorAdminId) {
      const orgId = toId(orgIdRaw);
      const entId = toId(entIdRaw);
      const reason = String(body.reason || '').trim();
      if (!reason) throw new OrgError(400, 'A reason is required to revoke a contract');
      const ent = await q(ENT).findOne({
        where: { id: entId },
        populate: { organization: { select: ['id'] }, user: { select: ['id'] } }
      });
      if (!ent || ent.organization?.id !== orgId || !isContract(ent)) throw new OrgError(404, 'Contract not found');
      if (ent.revokedAt) throw new OrgError(409, 'Contract already revoked');

      await q(ENT).update({ where: { id: entId }, data: { revokedAt: new Date(), revokedReason: reason } });
      await audit({ orgId, actorAdminId, action: 'contract.revoke', meta: { contractId: entId, reason } });
      return this.getOrg(orgId);
    },

    // ---- org admins ---------------------------------------------------------

    /** body: { email, grantAccess? (default true) } */
    async assignAdmin(orgIdRaw, body, actorAdminId) {
      const orgId = toId(orgIdRaw);
      const org = await loadOrg(orgId);
      const user = await findUserByEmail(body.email);
      const grantAccess = body.grantAccess !== false;
      const existing = await seatOf(user.id);

      if (existing && existing.organization?.id !== orgId) {
        throw new OrgError(409, `${user.email} already belongs to "${existing.organization?.name || 'another organisation'}"`);
      }
      if (existing && existing.role === 'admin') throw new OrgError(409, `${user.email} is already an admin here`);

      if (!existing && org.seatLimit !== null && org.seatLimit !== undefined) {
        const inUse = await activeSeatCount(orgId);
        if (inUse >= org.seatLimit) throw new OrgError(409, `All ${org.seatLimit} seats are in use`);
      }

      const contracts = grantAccess ? await contractsFor(orgId) : [];

      await strapi.db.transaction(async () => {
        if (existing) {
          await q(SEAT).update({ where: { id: existing.id }, data: { role: 'admin' } });
          await audit({
            orgId, actorAdminId, action: 'member.role',
            targetUserId: user.id, targetEmail: user.email, meta: { from: existing.role || 'member', to: 'admin' }
          });
        } else {
          await q(SEAT).create({
            data: {
              organization: orgId, user: user.id, role: 'admin', status: 'active',
              source: 'handle', addedByAdmin: actorAdminId || null,
              publicationCodes: await defaultSeatPublications(orgId)
            }
          });
          await audit({
            orgId, actorAdminId, action: 'member.add',
            targetUserId: user.id, targetEmail: user.email, meta: { role: 'admin' }
          });
        }

        if (!org.owner) await q(ORG).update({ where: { id: orgId }, data: { owner: user.id } });

        if (grantAccess) {
          const win = defaultWindow(contracts);
          if (win) {
            const today = todayIso();
            const hasWindow = await q(ENT).count({
              where: {
                organization: { id: orgId }, user: { id: user.id }, scope: 'org_member',
                revokedAt: { $null: true }, coverageEnd: { $gte: today }
              }
            });
            if (!hasWindow) {
              await q(ENT).create({
                data: {
                  organization: orgId, user: user.id, scope: 'org_member', grantSource: 'handle',
                  grantedByAdmin: actorAdminId || null, coverageStart: win.start, coverageEnd: win.end
                }
              });
              await audit({
                orgId, actorAdminId, action: 'access.create',
                targetUserId: user.id, targetEmail: user.email, meta: win
              });
            }
          }
        }
      });

      return this.getOrg(orgId);
    },

    /** Demotes an admin to member. The seat and the member's access stay. */
    async removeAdmin(orgIdRaw, seatIdRaw, actorAdminId) {
      const orgId = toId(orgIdRaw);
      const seat = await loadSeatInOrg(orgId, toId(seatIdRaw));
      if (seat.role !== 'admin') throw new OrgError(409, 'This member is not an admin');
      const org = await loadOrg(orgId);

      await q(SEAT).update({ where: { id: seat.id }, data: { role: 'member' } });
      if (org.owner?.id && org.owner.id === seat.user?.id) {
        const otherAdmin = await q(SEAT).findOne({
          where: { organization: { id: orgId }, role: 'admin', id: { $ne: seat.id } },
          populate: { user: { select: ['id'] } }
        });
        await q(ORG).update({ where: { id: orgId }, data: { owner: otherAdmin?.user?.id || null } });
      }
      await audit({
        orgId, actorAdminId, action: 'member.role',
        targetUserId: seat.user?.id, targetEmail: seat.user?.email, meta: { from: 'admin', to: 'member' }
      });
      return this.getOrg(orgId);
    },

    // ---- members (read-only list + force suspend/reactivate) ----------------

    async listMembers(orgIdRaw, query) {
      const orgId = toId(orgIdRaw);
      await loadOrg(orgId);
      const { page, pageSize, offset, limit } = pageArgs(query);

      const where = { organization: { id: orgId } };
      if (query.status === 'active') where.active = true;
      if (query.status === 'suspended') where.active = false;
      if (query.role === 'admin' || query.role === 'member') where.role = query.role;
      if (query.search) {
        const s = String(query.search).trim();
        where.user = { $or: [{ email: { $containsi: s } }, { displayName: { $containsi: s } }] };
      }

      const [seats, total] = await Promise.all([
        q(SEAT).findMany({
          where, offset, limit, orderBy: { assignedAt: 'desc' },
          populate: { user: { select: ['id', 'email', 'displayName', 'phone', 'accountSource', 'passwordSetAt'] } }
        }),
        q(SEAT).count({ where })
      ]);

      const userIds = seats.map((s) => s.user?.id).filter(Boolean);
      const windows = userIds.length
        ? await q(ENT).findMany({
            where: {
              organization: { id: orgId }, scope: 'org_member',
              revokedAt: { $null: true }, user: { id: { $in: userIds } }
            },
            populate: { user: { select: ['id'] } }
          })
        : [];

      const today = todayIso();
      const byUser = new Map();
      for (const w of windows) {
        const list = byUser.get(w.user?.id) || [];
        list.push(w);
        byUser.set(w.user?.id, list);
      }

      const members = seats.map((s) => {
        const list = byUser.get(s.user?.id) || [];
        const current = list.find((w) => w.coverageStart <= today && today <= w.coverageEnd) || null;
        const latestEnd = list.reduce((m, w) => (w.coverageEnd > m ? w.coverageEnd : m), '') || null;
        return {
          seatId: s.id,
          role: s.role || 'member',
          status: s.status || (s.active === false ? 'suspended' : 'active'),
          source: s.source || null,
          assignedAt: s.assignedAt || null,
          suspendedAt: s.suspendedAt || null,
          suspendedReason: s.suspendedReason || null,
          user: publicUser(s.user),
          // Added by an Org Admin and hasn't set a password through the invite yet.
          invitePending: Boolean(s.user && ['org_invite', 'org_import'].includes(s.user.accountSource) && !s.user.passwordSetAt),
          // null = every publication the organisation pays for (seats from before per-publication seats)
          publications: seatCodes(s),
          access: {
            current: current ? { start: current.coverageStart, end: current.coverageEnd } : null,
            latestEnd,
            // Legacy seats predate member windows and read on the contract alone.
            contractWide: s.source === 'legacy'
          }
        };
      });

      return { members, pagination: { page, pageSize, total, pageCount: Math.ceil(total / pageSize) } };
    },

    async setMemberStatus(orgIdRaw, seatIdRaw, body, actorAdminId) {
      const orgId = toId(orgIdRaw);
      const seat = await loadSeatInOrg(orgId, toId(seatIdRaw));
      const status = String(body.status || '');
      if (!['active', 'suspended'].includes(status)) throw new OrgError(400, 'status must be active or suspended');
      const reason = String(body.reason || '').trim();
      if (status === 'suspended' && !reason) throw new OrgError(400, 'A reason is required to suspend');
      const from = seat.status || (seat.active === false ? 'suspended' : 'active');
      if (from === status) throw new OrgError(409, `Member is already ${status}`);

      if (status === 'active') {
        const org = await loadOrg(orgId);
        if (org.seatLimit !== null && org.seatLimit !== undefined) {
          const inUse = await activeSeatCount(orgId);
          if (inUse >= org.seatLimit) throw new OrgError(409, `All ${org.seatLimit} seats are in use`);
        }
        await assertRoomForSeat(orgId, seat);
      }

      await q(SEAT).update({
        where: { id: seat.id },
        data: status === 'active' ? { status } : { status, suspendedReason: reason }
      });
      await audit({
        orgId, actorAdminId, action: status === 'active' ? 'member.reactivate' : 'member.suspend',
        targetUserId: seat.user?.id, targetEmail: seat.user?.email, meta: { reason: reason || null, by: 'handle' }
      });
      return { success: true };
    },

    // ---- member publications ------------------------------------------------

    publicationSeatUse: (orgIdRaw) => publicationSeatUse(toId(orgIdRaw)),
    assertRoomForSeat: (orgIdRaw, seat) => assertRoomForSeat(toId(orgIdRaw), seat),
    defaultSeatPublications: (orgIdRaw) => defaultSeatPublications(toId(orgIdRaw)),
    seatCodes,

    /**
     * Sets which publications one member reads. Used by handle and by the
     * Org Admin (actor = { actorAdminId } or { actorUserId }).
     * A publication can only be added if the organisation pays for it and
     * its current (or next) contract still has a free seat.
     */
    async setSeatPublications(orgIdRaw, seatIdRaw, codesIn, actor = {}) {
      const orgId = toId(orgIdRaw);
      const seat = await loadSeatInOrg(orgId, toId(seatIdRaw));
      const codes = [...new Set((Array.isArray(codesIn) ? codesIn : []).map(normCode).filter(Boolean))].sort();
      const use = await publicationSeatUse(orgId);
      const before = seatCodes(seat);
      const had = (code) => before === null || before.includes(code);

      for (const code of codes) {
        const u = use.find((x) => x.code === code);
        if (!u || (!u.current && !u.next)) throw new OrgError(409, `Your organisation does not pay for ${code}`);
        const active = seat.status ? seat.status === 'active' : seat.active !== false;
        if (active && !had(code) && u.seats !== null && u.inUse >= u.seats) {
          throw new OrgError(409, `All ${u.seats} ${code} seats are in use. Free one first or ask New Vision for more.`);
        }
      }
      await q(SEAT).update({ where: { id: seat.id }, data: { publicationCodes: codes } });
      await audit({
        orgId,
        actorAdminId: actor.actorAdminId || null,
        actorUserId: actor.actorUserId || null,
        action: 'member.publications',
        targetUserId: seat.user?.id,
        targetEmail: seat.user?.email,
        meta: { from: before, to: codes }
      });
      return { success: true, publications: codes };
    },

    // ---- audit --------------------------------------------------------------

    async listAudit(orgIdRaw, query) {
      const orgId = toId(orgIdRaw);
      await loadOrg(orgId);
      const { page, pageSize, offset, limit } = pageArgs(query);
      const where = { organization: { id: orgId } };
      const [rows, total] = await Promise.all([
        q(AUDIT).findMany({
          where, offset, limit, orderBy: { createdAt: 'desc' },
          populate: {
            actorUser: { select: ['id', 'email', 'displayName'] },
            actorAdmin: { select: ['id', 'email', 'displayName'] },
            targetUser: { select: ['id', 'email', 'displayName'] }
          }
        }),
        q(AUDIT).count({ where })
      ]);
      return {
        entries: rows.map((r) => ({
          id: r.id,
          action: r.action,
          at: r.createdAt,
          actor: r.actorAdmin
            ? { kind: 'handle', email: r.actorAdmin.email, displayName: r.actorAdmin.displayName }
            : r.actorUser
              ? { kind: 'org_admin', email: r.actorUser.email, displayName: r.actorUser.displayName }
              : null,
          target: r.targetUser ? publicUser(r.targetUser) : r.targetEmail ? { email: r.targetEmail } : null,
          meta: r.meta || null
        })),
        pagination: { page, pageSize, total, pageCount: Math.ceil(total / pageSize) }
      };
    }
  };
};
