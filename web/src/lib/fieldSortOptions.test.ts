import { describe, expect, it } from 'vitest'
import { fieldSortBy, fieldSortId, isFieldSortBy, type FieldDef } from './types'
import { fieldSortOptions } from './fieldSortOptions'

const field = (id: string, name: string, type: string, deleted_at: number | null = null): FieldDef => ({ id, name, type, deleted_at, project_id: 'p', options: '', position: 0, created_at: 0, _clock: {} })
const SCORE_ID = '11111111-1111-4111-8111-111111111111'
const SCORE_DATE_ID = '22222222-2222-4222-8222-222222222222'
const TEXT_ID = '33333333-3333-4333-8333-333333333333'
const DELETED_ID = '44444444-4444-4444-8444-444444444444'

describe('field sort IDs and choices', () => {
  it('accepts only canonical UUID sort values while sync may preserve unknown strings', () => {
    expect(fieldSortId(fieldSortBy(SCORE_ID))).toBe(SCORE_ID)
    expect(isFieldSortBy(fieldSortBy(SCORE_ID))).toBe(true)
    for (const value of [null, 7, 'title', 'field:', 'field:Score', 'field:' + 'a'.repeat(36), 'field:11111111-1111-0111-8111-111111111111', 'field:11111111-1111-4111-7111-111111111111', 'field:11111111-1111-4111-8111-11111111111Z']) {
      expect(fieldSortId(value)).toBeNull()
      expect(isFieldSortBy(value)).toBe(false)
    }
  })

  it('offers live Number and Date fields once and preserves the selected definition id', () => {
    const fields = [field(SCORE_ID, 'Score', 'number'), field(SCORE_DATE_ID, 'score', 'date'), field(TEXT_ID, 'Words', 'text'), field(DELETED_ID, 'Gone', 'number', 1)]
    expect(fieldSortOptions(fields, 'due', 'Unavailable custom field')).toEqual([{ label: 'Score', value: fieldSortBy(SCORE_ID) }])
    expect(fieldSortOptions(fields, fieldSortBy(SCORE_DATE_ID), 'Unavailable custom field')).toEqual([{ label: 'score', value: fieldSortBy(SCORE_DATE_ID) }])
  })

  it('keeps an unavailable selected ID visible without showing the ID as content', () => {
    const fields = [field(SCORE_ID, 'Score', 'number'), field(DELETED_ID, 'Gone', 'number', 1)]
    expect(fieldSortOptions(fields, fieldSortBy(DELETED_ID), 'Unavailable custom field')).toEqual([
      { label: 'Score', value: fieldSortBy(SCORE_ID) },
      { label: 'Unavailable custom field', value: fieldSortBy(DELETED_ID) },
    ])
    expect(fieldSortOptions([], 'title', 'Unavailable custom field')).toEqual([])
  })
})
