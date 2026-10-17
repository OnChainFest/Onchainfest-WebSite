import type { AuthNoticeCode } from './auth/messages';
import type { Contest, StructureRound } from './competition';
import { partitionLabel } from './competition';
import { sideText, timeText, type Assignment } from './schedule';
import { outcomeReasonLabel, type StaffOutcome } from './results';
import type { FieldParticipant } from './structure';
import { instantToZoned } from './tournament-builder';
import type {
  CompetitionStatus,
  EventStatus,
  ManagedCompetition,
  ManagedEvent,
} from './tournaments';

/**
 * ONCF-L4 operations workspace. Everything here presents the lifecycle commands the API already
 * has — competition activate/complete/cancel, category start/complete/cancel, match
 * start/complete/cancel/void — and the state they act on. The API decides every permission and
 * transition, under its H-2 lifecycle locks; the web only offers the commands the current state
 * advertises, explains what is waiting, and asks for confirmation before anything final.
 */

// ───────────────────────────── commands ─────────────────────────────

export type OpTarget = 'competition' | 'category' | 'match';
export type ContestStatus =
  'PLANNED' | 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'VOID';

export interface Operation {
  readonly target: OpTarget;
  readonly command: string;
  /** The status the command produces (matched against the advertised next statuses). */
  readonly result: string;
  /** The permission the store checks (shown so the page can explain who may do it). */
  readonly permission: string;
  readonly label: string;
  /** What happens, in organizer words, shown before confirming. */
  readonly consequence: string;
  /** The API requires a reason (1–500 characters). */
  readonly reason: boolean;
  /** Final for the target: the organizer ticks an explicit acknowledgement first. */
  readonly final: boolean;
  readonly tone: 'go' | 'neutral' | 'danger';
  readonly notice: AuthNoticeCode;
}

const op = (o: Operation) => o;

/** Every operation the workspace can request, keyed `target:command`. */
export const OPERATIONS = {
  'competition:activate': op({
    target: 'competition',
    command: 'activate',
    result: 'ACTIVE',
    permission: 'COMP_EDIT',
    label: 'Start tournament',
    consequence:
      'The tournament goes live and its categories can be started. It can’t go back to published.',
    reason: false,
    final: false,
    tone: 'go',
    notice: 'tournament_started',
  }),
  'competition:complete': op({
    target: 'competition',
    command: 'complete',
    result: 'COMPLETED',
    permission: 'COMP_EDIT',
    label: 'Complete tournament',
    consequence:
      'Closes the tournament for good: nothing in it can start or change afterwards. Its completed categories keep their final outcome, declared by the organizer.',
    reason: false,
    final: true,
    tone: 'neutral',
    notice: 'tournament_completed',
  }),
  'competition:cancel': op({
    target: 'competition',
    command: 'cancel',
    result: 'CANCELLED',
    permission: 'COMP_CANCEL',
    label: 'Cancel tournament',
    consequence:
      'Cancels the tournament, every category still open and every match that hasn’t started. Participants and staff see the reason. This can’t be undone.',
    reason: true,
    final: true,
    tone: 'danger',
    notice: 'tournament_cancelled',
  }),
  'category:start': op({
    target: 'category',
    command: 'start',
    result: 'IN_PROGRESS',
    permission: 'COMP_EDIT',
    label: 'Start category',
    consequence:
      'Play begins: its scheduled matches can then be started. The category can’t go back to a locked field.',
    reason: false,
    final: false,
    tone: 'go',
    notice: 'operation_category_started',
  }),
  'category:complete': op({
    target: 'category',
    command: 'complete',
    result: 'COMPLETED',
    permission: 'COMP_EDIT',
    label: 'Complete category',
    consequence:
      'Settles the category: its official results become its final outcome and standings, and they are frozen — nothing can be entered, accepted or corrected afterwards.',
    reason: false,
    final: true,
    tone: 'neutral',
    notice: 'operation_category_completed',
  }),
  'category:cancel': op({
    target: 'category',
    command: 'cancel',
    result: 'CANCELLED',
    permission: 'COMP_CANCEL',
    label: 'Cancel category',
    consequence:
      'Cancels the category and every one of its matches that hasn’t started. Participants and staff see the reason. This can’t be undone.',
    reason: true,
    final: true,
    tone: 'danger',
    notice: 'category_cancelled',
  }),
  'match:start': op({
    target: 'match',
    command: 'start',
    result: 'IN_PROGRESS',
    permission: 'COMP_MANAGE_SCHEDULE',
    label: 'Start match',
    consequence: 'The match is marked in play on the court. It can’t go back to scheduled.',
    reason: false,
    final: false,
    tone: 'go',
    notice: 'operation_match_started',
  }),
  'match:complete': op({
    target: 'match',
    command: 'complete',
    result: 'COMPLETED',
    permission: 'COMP_MANAGE_SCHEDULE',
    label: 'Finish match',
    consequence:
      'The match is marked as played. No score or result is recorded here — results are entered separately.',
    reason: false,
    final: false,
    tone: 'go',
    notice: 'operation_match_completed',
  }),
  'match:cancel': op({
    target: 'match',
    command: 'cancel',
    result: 'CANCELLED',
    permission: 'COMP_CANCEL',
    label: 'Cancel match',
    consequence:
      'The match won’t be played and can’t be rescheduled or started. No result is decided. This can’t be undone.',
    reason: true,
    final: true,
    tone: 'danger',
    notice: 'operation_match_cancelled',
  }),
  'match:void': op({
    target: 'match',
    command: 'void',
    result: 'VOID',
    permission: 'COMP_CANCEL',
    label: 'Void match',
    consequence:
      'Annuls the match as played: it can’t be finished, restarted or played again. Voiding decides no result. This can’t be undone.',
    reason: true,
    final: true,
    tone: 'danger',
    notice: 'operation_match_voided',
  }),
} as const satisfies Record<string, Operation>;

export type OperationKey = keyof typeof OPERATIONS;

export function operationOf(target: string, command: string): Operation | null {
  const key = `${target}:${command}`;
  return Object.hasOwn(OPERATIONS, key) ? OPERATIONS[key as OperationKey] : null;
}

/** The canonical route of each command (the API's, unchanged). */
export function operationPath(o: Operation, id: string): string {
  const base =
    o.target === 'competition' ? 'competitions' : o.target === 'category' ? 'events' : 'contests';
  return `/v1/${base}/${id}/${o.command}`;
}

/**
 * Matches are the one lifecycle the API doesn't advertise next statuses for (competitions and
 * categories carry `nextStatuses`). This mirrors the domain's ContestLifecycle for display only —
 * a test pins it to packages/competition — and the store re-checks every command.
 */
export const CONTEST_NEXT: Readonly<Record<ContestStatus, readonly ContestStatus[]>> = {
  PLANNED: ['SCHEDULED', 'CANCELLED'],
  SCHEDULED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'VOID'],
  COMPLETED: ['VOID'],
  CANCELLED: [],
  VOID: [],
};

export const contestNext = (status: string): readonly string[] =>
  Object.hasOwn(CONTEST_NEXT, status) ? CONTEST_NEXT[status as ContestStatus] : [];

/** Operations on `target` that the state advertises and the caller's permissions allow. */
export function offered(
  target: OpTarget,
  next: readonly string[],
  permissions: readonly string[],
): Operation[] {
  return Object.values(OPERATIONS).filter(
    (o) => o.target === target && next.includes(o.result) && permissions.includes(o.permission),
  );
}

export const CONTEST_STATUS_LABEL: Record<ContestStatus, string> = {
  PLANNED: 'Not scheduled',
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'In play',
  COMPLETED: 'Finished',
  CANCELLED: 'Cancelled',
  VOID: 'Void',
};

export const contestStatusLabel = (s: string) =>
  Object.hasOwn(CONTEST_STATUS_LABEL, s) ? CONTEST_STATUS_LABEL[s as ContestStatus] : s;

/** The statuses whose matches exist and matter on the day (field locked onwards). */
export const OPERATIONAL: ReadonlySet<EventStatus> = new Set([
  'FIELD_LOCKED',
  'IN_PROGRESS',
  'COMPLETED',
]);

/** What the caller's permissions let them do here (explanation; the API decides). */
export function operatorScope(permissions: readonly string[]) {
  return {
    lifecycle: permissions.includes('COMP_EDIT'),
    matches: permissions.includes('COMP_MANAGE_SCHEDULE'),
    cancel: permissions.includes('COMP_CANCEL'),
  };
}

export function scopeText(permissions: readonly string[]): string {
  const s = operatorScope(permissions);
  const can = [
    s.lifecycle ? 'start and complete the tournament and its categories' : null,
    s.matches ? 'start and finish matches' : null,
    s.cancel ? 'cancel or void' : null,
  ].filter((x) => x !== null);
  return can.length === 0
    ? 'You can follow play here, but your role can’t change it.'
    : `You can ${can.join(', ').replace(/, ([^,]*)$/, ' and $1')}.`;
}

// ───────────────────────────── matches ─────────────────────────────

export interface OpsMatch {
  contestId: string;
  event: ManagedEvent;
  round: string;
  title: string;
  sides: string[];
  status: string;
  /** Official time from the published schedule (null: not on it). */
  slot: { start: string; end: string | null; zone: string; court: string | null } | null;
  /** Why the match can't start yet (only for matches whose next step is starting). */
  waiting: Waiting | null;
}

/** "Match 3", "Group A", "Race 1": what organizers call it. */
function titleOf(c: Contest): string {
  const field = c.slots.length === 0 && (c.entryCount ?? c.entries?.length ?? 0) > 0;
  return partitionLabel(c.partitionKey) ?? `${field ? 'Race' : 'Match'} ${c.sequence}`;
}

/** `inactive`: an entrant withdrew or was disqualified — it won't resolve on its own. */
export interface Waiting {
  kind: 'category' | 'place' | 'inactive';
  text: string;
}

const PARTICIPANT_STATUS: Record<string, string> = {
  WITHDRAWN: 'withdrew',
  DISQUALIFIED: 'was disqualified',
};

/**
 * Why a match can't be started from the state on screen: its category isn't in play, or a place
 * isn't decided (or its entrant left). Advice only — the API re-checks every slot when starting.
 */
function waitingFor(
  c: Contest,
  event: ManagedEvent,
  names: ReadonlyMap<string, string>,
  status: ReadonlyMap<string, string>,
): Waiting | null {
  if (event.status !== 'IN_PROGRESS')
    return event.status === 'FIELD_LOCKED'
      ? { kind: 'category', text: 'Start the category first' }
      : null;
  const sorted = [...c.slots].sort((a, b) => a.slot - b.slot);
  const open = sorted.filter((s) => s.kind !== 'PARTICIPANT' && !s.resolved);
  if (open.length > 0)
    return {
      kind: 'place',
      text: `Waiting for ${open.map((s) => sideText(s, names)).join(' and ')}`,
    };
  for (const s of sorted) {
    const id = s.kind === 'PARTICIPANT' ? s.participantId : s.resolved ? s.participantId : null;
    const st = id === null ? undefined : status.get(id);
    if (st !== undefined && st !== 'ACTIVE')
      return {
        kind: 'inactive',
        text: `${sideText(s, names)} ${PARTICIPANT_STATUS[st] ?? 'is not active'}`,
      };
  }
  if (c.slots.length === 0 && (c.entryCount ?? c.entries?.length ?? 0) === 0)
    return { kind: 'place', text: 'Waiting for its entrants' };
  return null;
}

/**
 * Every match of the operational categories, with its official time and court and — for those
 * whose next step is starting — what it's still waiting for.
 */
export function opsMatches(
  categories: readonly {
    event: ManagedEvent;
    rounds: readonly StructureRound[];
    field: readonly FieldParticipant[];
  }[],
  assignments: readonly Assignment[],
  courts: ReadonlyMap<string, string>,
): OpsMatch[] {
  const placed = new Map(assignments.map((a) => [a.contestId, a]));
  const out: OpsMatch[] = [];
  for (const { event, rounds, field } of categories) {
    const names = new Map<string, string>();
    const status = new Map<string, string>();
    for (const p of field) {
      names.set(p.participantId, p.athlete?.displayName ?? p.teamName ?? 'Private entrant');
      status.set(p.participantId, p.status);
    }
    for (const r of rounds)
      for (const c of r.contests) {
        const a = placed.get(c.contestId);
        const isField = c.slots.length === 0;
        out.push({
          contestId: c.contestId,
          event,
          round: r.label,
          title: titleOf(c),
          sides: isField
            ? [`${c.entryCount ?? c.entries?.length ?? 0} entrants`]
            : [...c.slots].sort((x, y) => x.slot - y.slot).map((s) => sideText(s, names)),
          status: c.status,
          slot:
            a !== undefined
              ? {
                  start: a.startsAt,
                  end: a.expectedEnd,
                  zone: a.zone,
                  court:
                    (a.resourceId === null ? undefined : courts.get(a.resourceId)) ??
                    a.courtLabel ??
                    null,
                }
              : c.scheduledStart !== null
                ? {
                    start: c.scheduledStart,
                    end: c.scheduledEnd,
                    zone: event.settings.timezone,
                    court: c.courtLabel,
                  }
                : null,
          waiting: c.status === 'SCHEDULED' ? waitingFor(c, event, names, status) : null,
        });
      }
  }
  return out;
}

const byTime = (a: OpsMatch, b: OpsMatch) =>
  (a.slot === null ? Infinity : Date.parse(a.slot.start)) -
    (b.slot === null ? Infinity : Date.parse(b.slot.start)) ||
  a.event.settings.name.localeCompare(b.event.settings.name) ||
  a.contestId.localeCompare(b.contestId);

/** The day's board: in play, up next (by official time), not on the schedule yet, and done. */
export function board(matches: readonly OpsMatch[]) {
  const live = matches.filter((m) => m.status === 'IN_PROGRESS').sort(byTime);
  const next = matches.filter((m) => m.status === 'SCHEDULED').sort(byTime);
  const unscheduled = matches.filter((m) => m.status === 'PLANNED');
  const done = matches
    .filter((m) => m.status === 'COMPLETED' || m.status === 'CANCELLED' || m.status === 'VOID')
    .sort((a, b) => byTime(b, a));
  return { live, next, unscheduled, done };
}

export const slotTime = (m: OpsMatch) => (m.slot === null ? null : timeText(m.slot));

// ───────────────────────────── categories ─────────────────────────────

export interface CategoryOps {
  event: ManagedEvent;
  matches: { total: number; live: number; finished: number; open: number };
  operations: Operation[];
  /** Why start isn't offered although the lifecycle allows it next. */
  blocked: { label: string; reason: string; href?: string } | null;
}

const TERMINAL_MATCH = new Set(['COMPLETED', 'CANCELLED', 'VOID']);

/**
 * ONCF-L6: why a category can't be completed yet, from the API's readiness (null: it can, or it
 * isn't known — the API decides either way).
 */
export function completionBlock(o: StaffOutcome | null | undefined): string | null {
  if (o === null || o === undefined || o.readiness.ready) return null;
  const r = o.readiness;
  if (r.contestsOpen.length > 0)
    return `${r.contestsOpen.length} ${r.contestsOpen.length === 1 ? 'match is' : 'matches are'} still open — finish ${r.contestsOpen.length === 1 ? 'it' : 'them'}, or cancel what won’t be played`;
  if (r.resultsNotOfficial.length > 0)
    return `${r.resultsNotOfficial.length} finished ${r.resultsNotOfficial.length === 1 ? 'match needs' : 'matches need'} an official result`;
  const why = o.outcome.reasons.find(
    (x) => !['TIE_UNBROKEN_LOT', 'GROUPS_NO_CHAMPION'].includes(x.code),
  );
  return why === undefined ? 'Its outcome isn’t decided yet' : outcomeReasonLabel(why.code);
}

export function categoryOps(
  data: ManagedCompetition,
  base: string,
  matches: readonly OpsMatch[],
  planned: ReadonlySet<string>,
  outcomes: ReadonlyMap<string, StaffOutcome | null> = new Map(),
): CategoryOps[] {
  const perms = data.access.permissions;
  return data.events
    .filter((e) => OPERATIONAL.has(e.status))
    .map((event) => {
      const own = matches.filter((m) => m.event.id === event.id);
      const counts = {
        total: own.length,
        live: own.filter((m) => m.status === 'IN_PROGRESS').length,
        finished: own.filter((m) => TERMINAL_MATCH.has(m.status)).length,
        open: own.filter((m) => !TERMINAL_MATCH.has(m.status)).length,
      };
      let operations = offered('category', event.nextStatuses, perms);
      let blocked: CategoryOps['blocked'] = null;
      const start = operations.find((o) => o.command === 'start');
      if (start !== undefined) {
        // The store also requires an ACTIVE tournament and generated matches; say which is missing.
        const reason =
          data.competition.status !== 'ACTIVE'
            ? { reason: 'Start the tournament first' }
            : !planned.has(event.id)
              ? {
                  reason: 'Generate its matches first',
                  href: `${base}/categories/${event.id}/structure`,
                }
              : null;
        if (reason !== null) {
          operations = operations.filter((o) => o !== start);
          blocked = { label: start.label, ...reason };
        }
      }
      // ONCF-L6 (ADR-0078): completion settles the outcome; say what still blocks it.
      const complete = operations.find((o) => o.command === 'complete');
      const notReady = complete === undefined ? null : completionBlock(outcomes.get(event.id));
      if (complete !== undefined && notReady !== null) {
        operations = operations.filter((o) => o !== complete);
        blocked = {
          label: complete.label,
          reason: notReady,
          href: `${base}/results#res-outcome`,
        };
      }
      return { event, matches: counts, operations, blocked };
    });
}

// ───────────────────────────── the tournament ─────────────────────────────

const TERMINAL_EVENT: ReadonlySet<EventStatus> = new Set(['COMPLETED', 'CANCELLED']);

export function competitionOps(data: ManagedCompetition) {
  const c = data.competition;
  // Publishing stays in the hub's builder: operations start once the tournament is public.
  let operations = offered('competition', c.nextStatuses, data.access.permissions);
  let blocked: { label: string; reason: string } | null = null;
  const complete = operations.find((o) => o.command === 'complete');
  const open = data.events.filter((e) => !TERMINAL_EVENT.has(e.status));
  if (complete !== undefined && open.length > 0) {
    operations = operations.filter((o) => o !== complete);
    blocked = {
      label: complete.label,
      reason: `${open.length} ${open.length === 1 ? 'category is' : 'categories are'} still open — complete or cancel ${open.length === 1 ? 'it' : 'them'} first`,
    };
  } else if (complete !== undefined && !data.events.some((e) => e.status === 'COMPLETED')) {
    // ONCF-L6 (ADR-0078 §2.4): nothing was played to completion — cancel it instead.
    operations = operations.filter((o) => o !== complete);
    blocked = {
      label: complete.label,
      reason: 'No category was completed — if nothing was played, cancel the tournament instead',
    };
  }
  return { operations, blocked };
}

/** "Today · Sat 14 Nov · Day 1 of 2" in the tournament's zone (null without valid dates). */
export function dayContext(
  c: Pick<ManagedCompetition['competition'], 'profile'>,
  now: number,
): { today: string; day: string | null } {
  const zone = c.profile.timezone;
  const local = instantToZoned(new Date(now).toISOString(), zone).slice(0, 10);
  const label = (d: string) =>
    new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    }).format(new Date(`${d}T00:00:00Z`));
  const today = local === '' ? '' : label(local);
  const first = instantToZoned(c.profile.startsAt, zone).slice(0, 10);
  const last = instantToZoned(c.profile.endsAt, zone).slice(0, 10);
  if (local === '' || first === '' || last === '') return { today, day: null };
  const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
  const total = days(first, last) + 1;
  if (local < first) {
    const n = days(local, first);
    return { today, day: n === 1 ? 'Starts tomorrow' : `Starts in ${n} days` };
  }
  if (local > last) return { today, day: 'After the last scheduled day' };
  return { today, day: `Day ${days(first, local) + 1} of ${total}` };
}

// ───────────────────────────── what needs attention ─────────────────────────────

export interface AttentionItem {
  key: string;
  tone: 'go' | 'warn' | 'bad';
  label: string;
  detail: string;
  href: string;
}

/**
 * The few things an operator should look at now, from the state on screen and the clock: what is
 * ready to start, what is late or running over, what is stuck, what can be closed. Advice only.
 */
export function attention(
  data: ManagedCompetition,
  cats: readonly CategoryOps[],
  b: ReturnType<typeof board>,
  now: number,
): AttentionItem[] {
  const c = data.competition;
  const perms = data.access.permissions;
  const items: AttentionItem[] = [];
  const name = (m: OpsMatch) => `${m.event.settings.name} · ${m.title}`;
  if (
    c.status === 'PUBLISHED' &&
    offered('competition', c.nextStatuses, perms).some((o) => o.command === 'activate') &&
    cats.some((x) => x.event.status === 'FIELD_LOCKED')
  )
    items.push({
      key: 'start-competition',
      tone: 'go',
      label: 'Start the tournament',
      detail: 'Categories and matches can only start once the tournament is live.',
      href: '#ops-lifecycle',
    });
  for (const x of cats)
    if (x.operations.some((o) => o.command === 'start'))
      items.push({
        key: `start-${x.event.id}`,
        tone: 'go',
        label: `${x.event.settings.name} is ready to start`,
        detail: `${x.matches.total} ${x.matches.total === 1 ? 'match' : 'matches'} generated.`,
        href: `#cat-${x.event.id}`,
      });
  const late = b.next.filter(
    (m) => m.waiting === null && m.slot !== null && Date.parse(m.slot.start) <= now,
  );
  if (late.length > 0)
    items.push({
      key: 'late',
      tone: 'warn',
      label:
        late.length === 1
          ? `${name(late[0] as OpsMatch)} was due at ${(slotTime(late[0] as OpsMatch) ?? '').slice(0, 5)}`
          : `${late.length} matches are past their start time`,
      detail: 'Start them when the players are on court.',
      href: `#m-${(late[0] as OpsMatch).contestId}`,
    });
  const over = b.live.filter(
    (m) => m.slot?.end !== null && m.slot !== null && Date.parse(m.slot.end as string) < now,
  );
  if (over.length > 0)
    items.push({
      key: 'over',
      tone: 'warn',
      label:
        over.length === 1
          ? `${name(over[0] as OpsMatch)} is running over`
          : `${over.length} matches are running over`,
      detail: 'Finish them once play ends so the courts show as free.',
      href: `#m-${(over[0] as OpsMatch).contestId}`,
    });
  const stuck = b.next.filter((m) => m.waiting?.kind === 'inactive');
  for (const m of stuck.slice(0, 3))
    items.push({
      key: `stuck-${m.contestId}`,
      tone: 'bad',
      label: `${name(m)} can’t start`,
      detail: `${m.waiting?.text ?? ''}. Decide whether to cancel it.`,
      href: `#m-${m.contestId}`,
    });
  // ONCF-L6: every match is done, but the outcome isn't settled yet (results to declare).
  for (const x of cats) {
    const b = x.blocked;
    if (
      b !== null &&
      x.event.status === 'IN_PROGRESS' &&
      x.matches.total > 0 &&
      x.matches.open === 0 &&
      b.label === operationOf('category', 'complete')?.label
    )
      items.push({
        key: `settle-${x.event.id}`,
        tone: 'warn',
        label: `${x.event.settings.name}: every match is done`,
        detail: `${b.reason}.`,
        href: b.href ?? `#cat-${x.event.id}`,
      });
  }
  for (const x of cats)
    if (
      x.event.status === 'IN_PROGRESS' &&
      x.matches.total > 0 &&
      x.matches.open === 0 &&
      x.operations.some((o) => o.command === 'complete')
    )
      items.push({
        key: `complete-${x.event.id}`,
        tone: 'go',
        label: `${x.event.settings.name}: every match is done`,
        detail: 'Its results are official: complete the category to settle its outcome.',
        href: `#cat-${x.event.id}`,
      });
  if (
    c.status === 'ACTIVE' &&
    data.events.some((e) => e.status === 'COMPLETED') &&
    data.events.every((e) => TERMINAL_EVENT.has(e.status)) &&
    offered('competition', c.nextStatuses, perms).some((o) => o.command === 'complete')
  )
    items.push({
      key: 'complete-competition',
      tone: 'go',
      label: 'Every category is closed',
      detail: 'Complete the tournament when you’re done.',
      href: '#ops-lifecycle',
    });
  return items;
}

// ───────────────────────────── recent ─────────────────────────────

export interface RecentItem {
  key: string;
  at: string;
  label: string;
  status: CompetitionStatus | EventStatus;
}

/** The latest lifecycle changes the API reports (the tournament's and its categories'). */
export function recentChanges(data: ManagedCompetition, limit = 6): RecentItem[] {
  const c = data.competition;
  const items: RecentItem[] = [
    { key: c.id, at: c.statusChangedAt, label: 'Tournament', status: c.status },
    ...data.events
      .filter((e) => e.status !== 'DRAFT')
      .map((e) => ({ key: e.id, at: e.statusChangedAt, label: e.settings.name, status: e.status })),
  ];
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}
