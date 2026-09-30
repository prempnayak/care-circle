import {
  copy,
  normalize,
  parseDoseId,
  partOfDay,
  scheduleTime,
  scopeLabel,
  TransactionFailedError,
  todayIn,
  type Dose,
  type PartOfDay,
} from '@care-circle/core';
import {
  buildCard,
  doseLabel,
  fail,
  requireMember,
  requireRecipient,
  spokenAt,
  succeed,
  ToolError,
  type Outcome,
  type ToolContext,
} from './common';
import type { ToolInput } from './definitions';

const MAX_SPOKEN = 5;
const isOpen = (d: Dose) => d.status === 'open' || d.status === 'missed';

/** Today's doses, open ones first, at most 5 spoken. Attaches the card. */
export async function getTodaysDoses(ctx: ToolContext, input: ToolInput<'get_todays_doses'>): Promise<Outcome<'get_todays_doses'>> {
  const member = await requireMember(ctx);
  requireRecipient(member);
  const { store, clock } = ctx.services;
  const circle = member.circle;
  const date = todayIn(clock, circle.tz);
  const day = await store.getDay(member.circleId, date);
  await store.writeAudit(member.circleId, member.sub, 'get_todays_doses', 'get_todays_doses', true, clock.now());

  const part = input.part_of_day;
  const inScope = day.doses.filter((d) => part === 'all' || partOfDay(d.time) === part);
  const ordered = [...inScope.filter(isOpen), ...inScope.filter((d) => !isOpen(d))].slice(0, MAX_SPOKEN);
  const open = inScope.filter(isOpen);
  const scope = scopeLabel(part);

  let speech: string;
  if (inScope.length === 0) speech = copy.dosesNone(scope);
  else if (open.length === 0) speech = copy.dosesAllLogged(inScope.length, scope);
  else speech = copy.dosesList(open.slice(0, MAX_SPOKEN).map(doseLabel), open.length, inScope.length - open.length);

  return succeed({
    speech,
    date,
    doses: ordered.map((d) => ({ doseId: d.doseId, name: d.name, time: d.time, status: d.status })),
    today: buildCard(circle, date, day.checkIn, day.doses, clock.now()),
  });
}

function nameMatches(dose: Dose, said: string): boolean {
  const s = normalize(said)
    .replace(/\b(my|the|a|an|pill|pills|tablet|tablets|medicine|medication|meds)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const candidates = [dose.name, ...dose.aliases].map((n) =>
    normalize(n)
      .replace(/\b(my|the|a|an|pill|pills|tablet|tablets|medicine|medication|meds)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  if (!s) return false;
  return candidates.some((c) => c.length > 0 && (c === s || c.includes(s) || s.includes(c)));
}

/** Resolve which of today's doses the person meant: by id, by name or alias, or by part of day. */
function resolve(doses: Dose[], input: ToolInput<'log_dose'>): { matches: Dose[]; bulk: boolean; part?: PartOfDay } {
  if (input.dose_id) {
    const parsed = parseDoseId(input.dose_id);
    const dose = parsed ? doses.find((d) => d.doseId === input.dose_id) : undefined;
    return { matches: dose ? [dose] : [], bulk: false };
  }
  if (input.medication_name) {
    let matches = doses.filter((d) => nameMatches(d, input.medication_name!));
    if (input.part_of_day) matches = matches.filter((d) => partOfDay(d.time) === input.part_of_day);
    return { matches, bulk: false };
  }
  if (input.part_of_day) {
    return { matches: doses.filter((d) => partOfDay(d.time) === input.part_of_day), bulk: true, part: input.part_of_day };
  }
  throw new ToolError(copy.doseNeedName());
}

/**
 * Log one dose (GSI1 + day query + one transaction with the audit record), or read back and then log several.
 * Several name matches: ask which one and write nothing.
 */
export async function logDose(ctx: ToolContext, input: ToolInput<'log_dose'>): Promise<Outcome<'log_dose'>> {
  const member = await requireMember(ctx);
  requireRecipient(member);
  const { store, clock } = ctx.services;
  const circle = member.circle;
  const now = clock.now();
  const date = todayIn(clock, circle.tz);
  const doses = await store.getDoses(member.circleId, date);

  const { matches, bulk, part } = resolve(doses, input);
  if (matches.length === 0) {
    return fail(part ? copy.doseNothingOpen(scopeLabel(part)) : copy.doseNotFound());
  }

  let targets: Dose[];
  if (bulk) {
    targets = matches.filter(isOpen);
    if (targets.length === 0) return fail(copy.doseNothingOpen(scopeLabel(part!)));
    if (!input.confirm && targets.length > 1) {
      return succeed({
        speech: copy.doseBulkReadBack(
          targets.map((d) => d.name),
          scopeLabel(part!),
          input.status,
        ),
        step: 'confirm',
        logged: [],
        stillOpen: doses.filter(isOpen).map(ref),
        pending: targets.map(ref),
      });
    }
  } else {
    const open = matches.filter(isOpen);
    if (open.length === 0) {
      return fail(copy.doseAlreadyLogged(matches[0]!.name, scopeLabel(partOfDay(matches[0]!.time))));
    }
    if (open.length > 1) {
      // Same name at several times, or a nickname shared by two medicines.
      return fail(copy.doseWhich(open.slice(0, 5).map((d) => `the ${scheduleTime(d.time)} ${d.name}`)));
    }
    targets = open;
  }

  try {
    await store.transact([
      ...targets.map((dose) => store.doseLogUpdate(member.circleId, { dose, status: input.status }, member.firstName, now)),
      store.auditPut(member.circleId, member.sub, 'log_dose', 'log_dose', true, now),
    ]);
  } catch (err) {
    if (err instanceof TransactionFailedError) {
      // Logged from another device in the meantime.
      return fail(copy.doseAlreadyLogged(targets[0]!.name, scopeLabel(partOfDay(targets[0]!.time))));
    }
    throw err;
  }

  const loggedIds = new Set(targets.map((d) => d.doseId));
  const stillOpen = doses.filter((d) => isOpen(d) && !loggedIds.has(d.doseId));
  const at = now.toISOString();
  return succeed({
    speech: copy.doseLogged(
      targets.map((d) => d.name),
      input.status,
      spokenAt(at, circle.tz),
      stillOpen.slice(0, 5).map((d) => d.name),
    ),
    step: 'logged',
    logged: targets.map((d) => ({ doseId: d.doseId, name: d.name, status: input.status, at })),
    stillOpen: stillOpen.map(ref),
  });
}

function ref(d: Dose) {
  return { doseId: d.doseId, name: d.name, time: d.time };
}
