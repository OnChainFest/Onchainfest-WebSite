import { reviewChecklist } from './tournament-builder';
import type { EventStatus, ManagedCompetition } from './tournaments';

/**
 * ONCF-L1 Competition Hub: the organizer's view of where a tournament stands, derived only from
 * GET /v1/competitions/:id/manage (and the staff list when it loads). Stages whose web surface
 * does not exist yet are reported as such — never as done — and carry no link.
 */

export type StageState = 'ready' | 'open' | 'progress' | 'attention' | 'todo' | 'planned';

export const STAGE_STATE_LABEL: Record<StageState, string> = {
  ready: 'Ready',
  open: 'Open',
  progress: 'In progress',
  attention: 'Needs attention',
  todo: 'Not started',
  planned: 'Not available yet',
};

export interface HubStage {
  readonly key: string;
  readonly label: string;
  readonly state: StageState;
  readonly detail: string;
  readonly href?: string;
}

const PAST_REGISTRATION: readonly EventStatus[] = [
  'REGISTRATION_CLOSED',
  'FIELD_LOCKED',
  'IN_PROGRESS',
  'COMPLETED',
];
const FIELD_LOCKED: readonly EventStatus[] = ['FIELD_LOCKED', 'IN_PROGRESS', 'COMPLETED'];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Later slices (resources, schedule, operations/results) have API support but no web surface. */
const PLANNED = 'Not in the web app yet';

export function hubStages(
  data: ManagedCompetition,
  base: string,
  staffCount: number | null,
): HubStage[] {
  const c = data.competition;
  const live = data.events.filter((e) => e.status !== 'CANCELLED');
  const open = live.filter((e) => e.status === 'REGISTRATION_OPEN').length;
  const closed = live.filter((e) => PAST_REGISTRATION.includes(e.status)).length;
  const locked = live.filter((e) => FIELD_LOCKED.includes(e.status)).length;
  const confirmed = live.reduce((n, e) => n + e.counts.confirmed, 0);
  const waitlisted = live.reduce((n, e) => n + e.counts.waitlisted, 0);
  const only = live.length === 1 ? live[0] : undefined;
  const entries = `${confirmed} confirmed${waitlisted > 0 ? ` · ${waitlisted} waitlisted` : ''}`;

  return [
    {
      key: 'categories',
      label: 'Categories',
      state: live.length > 0 ? 'ready' : 'attention',
      detail: live.length > 0 ? plural(live.length, 'category', 'categories') : 'None yet',
      href: '#categories',
    },
    {
      key: 'registrations',
      label: 'Registrations',
      state:
        live.length === 0
          ? 'todo'
          : open > 0
            ? 'open'
            : closed === live.length
              ? 'ready'
              : closed > 0
                ? 'progress'
                : 'todo',
      detail:
        live.length === 0
          ? 'Add a category first'
          : open > 0
            ? `${plural(open, 'category', 'categories')} open · ${entries}`
            : closed === live.length
              ? `Closed · ${entries}`
              : 'Not opened yet',
      ...(data.events.length > 0 ? { href: `${base}/registrations` } : {}),
    },
    {
      key: 'structure',
      label: 'Structure',
      state: live.length > 0 && locked === live.length ? 'ready' : locked > 0 ? 'progress' : 'todo',
      detail:
        live.length === 0
          ? 'Add a category first'
          : `${locked}/${live.length} ${live.length === 1 ? 'field' : 'fields'} locked`,
      ...(live.length === 0
        ? {}
        : {
            href: only !== undefined ? `${base}/categories/${only.id}/structure` : '#categories',
          }),
    },
    { key: 'resources', label: 'Resources', state: 'planned', detail: PLANNED },
    { key: 'schedule', label: 'Schedule', state: 'planned', detail: PLANNED },
    { key: 'operations', label: 'Operations & results', state: 'planned', detail: PLANNED },
    {
      key: 'staff',
      label: 'Staff',
      state: 'ready',
      detail:
        staffCount === null
          ? 'Organization owners & admins'
          : staffCount === 0
            ? 'Organization owners & admins only'
            : `${plural(staffCount, 'person', 'people')} assigned`,
      href: `${base}/staff`,
    },
    c.status === 'DRAFT'
      ? {
          key: 'public',
          label: 'Public page',
          state: 'todo',
          detail: 'Available after publishing',
        }
      : {
          key: 'public',
          label: 'Public page',
          state: c.status === 'CANCELLED' ? 'attention' : 'ready',
          detail: `/competitions/${c.slug}`,
          href: `/competitions/${c.slug}`,
        },
  ];
}

export interface NextAction {
  readonly label: string;
  readonly detail: string;
  readonly href?: string;
}

/**
 * The single most useful next step, from stored state and the caller's own permissions. Advice
 * only: the destination page and the API still decide what is possible.
 */
export function nextAction(data: ManagedCompetition, base: string): NextAction {
  const c = data.competition;
  const perms = data.access.permissions;
  const live = data.events.filter((e) => e.status !== 'CANCELLED');
  if (c.status === 'CANCELLED')
    return { label: 'Tournament cancelled', detail: 'Nothing else can change.' };
  if (c.status === 'COMPLETED')
    return {
      label: 'Tournament completed',
      detail: 'Results and match operations come to the web app in a later release.',
    };
  if (c.status === 'DRAFT') {
    if (live.length === 0)
      return c.editable.addEvents && perms.includes('COMP_EDIT')
        ? {
            label: 'Add your first category',
            detail: 'Sport, discipline, entrants and format.',
            href: `${base}/categories/new`,
          }
        : { label: 'Waiting for categories', detail: 'Your role can’t add categories.' };
    const review = reviewChecklist(data);
    const missing = review.filter((r) => !r.done);
    if (missing.length > 0)
      return {
        label: 'Finish the review',
        detail: missing.map((r) => r.label).join(' · '),
        href: '#review',
      };
    return perms.includes('COMP_PUBLISH')
      ? {
          label: 'Publish the tournament',
          detail: 'It then appears on your public page.',
          href: '#publish',
        }
      : { label: 'Ready to publish', detail: 'An owner or admin can publish it.' };
  }
  const draft = live.find((e) => e.status === 'DRAFT');
  if (draft !== undefined)
    return {
      label: `Open registration for ${draft.settings.name}`,
      detail: 'Entrants can sign up once registration opens.',
      href: `${base}/categories/${draft.id}`,
    };
  if (live.some((e) => e.status === 'REGISTRATION_OPEN'))
    return {
      label: 'Manage registrations',
      detail: 'Review entries while registration is open.',
      href: `${base}/registrations`,
    };
  const toLock = live.find((e) => e.status === 'REGISTRATION_CLOSED');
  if (toLock !== undefined)
    return {
      label: `Lock the field for ${toLock.settings.name}`,
      detail: 'Then seed it and generate the structure.',
      href: `${base}/categories/${toLock.id}/structure`,
    };
  return {
    label: 'Structure is set',
    detail: 'Resources, scheduling and match operations come to the web app in a later release.',
  };
}
