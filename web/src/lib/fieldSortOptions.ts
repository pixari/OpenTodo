import { nameKey } from './fieldNames'
import { fieldSortBy, fieldSortId, type FieldDef, type SortBy } from './types'

export function fieldSortOptions(fields: readonly FieldDef[], selected: SortBy, unavailableLabel: string): { value: SortBy; label: string }[] {
  const selectedId = fieldSortId(selected)
  const byName = new Map<string, FieldDef>()
  for (const field of fields) {
    if (!field.deleted_at && (field.type === 'number' || field.type === 'date')) {
      const key = nameKey(field.name)
      const current = byName.get(key)
      if (!current || field.id === selectedId) byName.set(key, field)
    }
  }
  const selectedField = selectedId && fields.find((field) => field.id === selectedId && !field.deleted_at)
  if (selectedField && (selectedField.type === 'number' || selectedField.type === 'date')) {
    byName.set(nameKey(selectedField.name), selectedField)
  }
  const options = [...byName.values()].map((field) => ({ value: fieldSortBy(field.id), label: field.name }))
  if (selectedId && !options.some((option) => option.value === selected)) {
    options.push({ value: fieldSortBy(selectedId), label: unavailableLabel })
  }
  return options
}
