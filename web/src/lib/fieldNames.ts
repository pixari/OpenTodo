// Names of custom field definitions this device has seen (OpenSpec custom-fields),
// live and deleted, so history and activity can say "Cost" for a `fields.<id>`
// change and fall back to the id otherwise. No imports: activity.ts and
// history.ts read it without pulling in the data layer.

const knownNames = new Map<string, string>()

/** The op field prefix of a task's custom field values. */
const PREFIX = 'fields.'

/** Remember definition names (live and deleted). */
export function rememberFieldNames(defs: readonly { id: string; name: string }[]): void {
  for (const d of defs) knownNames.set(d.id, d.name)
}

/** The name of a definition this device has seen, if any. */
export function fieldNameOf(id: string): string | undefined {
  return knownNames.get(id)
}

/** The label of a `fields.<id>` op field ("Cost", else the id), or null for any other field. */
export function fieldValueLabel(field: string): string | null {
  if (!field.startsWith(PREFIX) || field.length === PREFIX.length) return null
  const id = field.slice(PREFIX.length)
  return knownNames.get(id) ?? id
}

/** Shared field-name matching for filters, sort values and display choices. */
export function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase()
}
