// Display options of a project's list and a label's page (OpenSpec change
// list-display-options): the grouping, the order and its direction, the same
// choices a saved view offers, stored per project (in the user's personal
// project_prefs row) and per label (on the label, which is personal), so the
// choice follows the user to every device and never reaches other members of a
// shared project. Read-time fallback like a view's: "" or a value this build does
// not know reads as the page's default and is never rewritten.
import { mutate } from './ops'
import { rowLayoutOf, type RowLayout } from './rowLayout'
import { isFieldSortBy, type GroupBy, type Label, type ProjectPrefs, type SortBy, type SortDir } from './types'

/** A list page's grouping: a view's choices plus the project's sections. */
export type ListGroupBy = GroupBy | 'section'

export interface ListDisplay {
  groupBy: ListGroupBy
  sortBy: SortBy
  sortDir: SortDir
  /** The rows' layout (row-layouts): the page's own choice, else the account's. */
  rowLayout: RowLayout
}

/** Which page the options belong to. */
export type DisplayScope = { kind: 'project' | 'label'; id: string }

/** Order by, as the panel lists them on a project or label page: manual first. */
export const LIST_SORT_OPTIONS: readonly SortBy[] = ['position', 'priority', 'due', 'created', 'deadline', 'title']
/** A project groups by its sections by default; projects make no sense inside one project. */
export const PROJECT_GROUP_OPTIONS: readonly ListGroupBy[] = ['section', 'none', 'due', 'priority', 'label']
/** A label page groups by project by default; its own label would be the only group. */
export const LABEL_GROUP_OPTIONS: readonly ListGroupBy[] = ['project', 'none', 'due', 'priority']

const SORT_DIRS: readonly SortDir[] = ['asc', 'desc']

/** The defaults: what the page showed before it had options. */
export function defaultListDisplay(kind: DisplayScope['kind'], rowLayout: RowLayout = 'line'): ListDisplay {
  return { groupBy: kind === 'project' ? 'section' : 'project', sortBy: 'position', sortDir: 'asc', rowLayout }
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/** The options of a project's prefs row or a label row; missing or unknown values read as the default. */
export function listDisplayOf(kind: DisplayScope['kind'], row: Pick<ProjectPrefs | Label, 'group_by' | 'sort_by' | 'sort_dir' | 'row_layout'> | null | undefined, account: RowLayout = 'line'): ListDisplay {
  const d = defaultListDisplay(kind)
  return {
    rowLayout: rowLayoutOf(row?.row_layout, account),
    groupBy: pick(row?.group_by, kind === 'project' ? PROJECT_GROUP_OPTIONS : LABEL_GROUP_OPTIONS, d.groupBy),
    sortBy: isFieldSortBy(row?.sort_by) ? row.sort_by : pick(row?.sort_by, LIST_SORT_OPTIONS, d.sortBy),
    sortDir: pick(row?.sort_dir, SORT_DIRS, d.sortDir),
  }
}

/** The page shows what it showed before options existed: its own grouping, in manual order. */
export function isDefaultDisplay(kind: DisplayScope['kind'], d: ListDisplay): boolean {
  const def = defaultListDisplay(kind)
  return d.groupBy === def.groupBy && d.sortBy === 'position' && d.sortDir === 'asc'
}

/**
 * Writes the changed options as ops (one per field, so a grouping changed on one
 * device and an order on another both survive). Works offline.
 */
export async function setListDisplay(scope: DisplayScope, patch: Partial<ListDisplay>): Promise<void> {
  const out: Record<string, string> = {}
  if (patch.groupBy !== undefined) out.group_by = patch.groupBy
  if (patch.sortBy !== undefined) out.sort_by = patch.sortBy
  if (patch.sortDir !== undefined) out.sort_dir = patch.sortDir
  if (patch.rowLayout !== undefined) out.row_layout = patch.rowLayout
  if (Object.keys(out).length === 0) return
  await mutate(scope.kind === 'project' ? 'project_prefs' : 'label', scope.id, out)
}
