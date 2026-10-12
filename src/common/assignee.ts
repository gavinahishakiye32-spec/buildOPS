/**
 * The one shape an assignee is ever reported in.
 *
 * Assignment points at people in two places (`tasks.assignee_id` and
 * `subtasks.assigned_to`) and every read of either has to render a name, so the
 * summary is defined once rather than inlined per entity. It deliberately
 * carries no email on the "other people's work" paths -- see
 * {@link AssigneeSummary} vs. what `MemberSummary` exposes -- because a task
 * board is a much wider surface than the members administration screen, and
 * the address is not needed to draw an avatar.
 */
export interface AssigneeSummary {
  id: string;
  name: string | null;
}

/** Anything with the three user columns the summary reads. */
export interface AssigneeUser {
  id: string;
  name: string | null;
}

/**
 * Reduces a loaded user to the assignable summary, or `null` when there is no
 * assignee.
 *
 * Written to tolerate an unpopulated relation rather than throw: a query that
 * did not join `assignee` yields `undefined`, and that has to render as
 * "unassigned" rather than crash the list it appears in.
 */
export function assigneeSummary(
  user: AssigneeUser | null | undefined,
): AssigneeSummary | null {
  return user ? { id: user.id, name: user.name } : null;
}

/**
 * What a task's subtasks add up to, computed by one aggregate query rather than
 * by reading them.
 *
 * A board shows "3 of 7 done" and a stack of faces per card, and doing that per
 * card would mean one extra round trip per task on the page. It is passed into
 * `toResponse` rather than hung off the entity because it is not a column and
 * has no business being loaded onto the entity graph.
 */
export interface TaskRollup {
  subtaskTotal: number;
  subtaskDone: number;
  /** Distinct people with work on this task, in name order. */
  assignees: AssigneeSummary[];
}

/**
 * The rollup a task with no subtasks reports.
 *
 * Zero rather than absent, so the response shape does not depend on whether the
 * aggregate happened to return a row: a client rendering "0 of 0" needs the
 * fields, and one that checks `subtaskTotal === undefined` would be reading a
 * distinction the database cannot make.
 */
export const EMPTY_ROLLUP: TaskRollup = {
  subtaskTotal: 0,
  subtaskDone: 0,
  assignees: [],
};