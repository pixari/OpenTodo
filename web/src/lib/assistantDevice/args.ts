// Argument checks of the on-device tools, mirroring internal/agenttools (args,
// argErr, toolErr): the same codes, so a model reads the same answers on the
// device as from the server.

/** A malformed call (the server's ArgError): reported as invalid_arguments. */
export class ArgError extends Error {}

/** A well-formed call refused (the server's ToolError): code, message, data. */
export class ToolError extends Error {
  constructor(public code: string, message: string, public data: Record<string, unknown> = {}) {
    super(message)
  }
  payload(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.data }
  }
}

export const PER_CALL = 50
const MAX_ID = 64

export type Args = Record<string, unknown>

export const present = (a: Args, name: string): boolean => a[name] !== undefined && a[name] !== null

/** Refuses argument names outside allowed (additionalProperties: false). */
export function only(a: Args, prefix: string, ...allowed: string[]): void {
  for (const k of Object.keys(a)) if (!allowed.includes(k)) throw new ArgError(`${prefix}${k}: unknown argument`)
}

export function str(a: Args, name: string): string {
  const v = a[name]
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') throw new ArgError(`${name}: must be a string`)
  return v
}

export function bool(a: Args, name: string): boolean {
  const v = a[name]
  if (v === undefined || v === null) return false
  if (typeof v !== 'boolean') throw new ArgError(`${name}: must be true or false`)
  return v
}

export function int(a: Args, name: string): number | null {
  const v = a[name]
  if (v === undefined || v === null) return null
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ArgError(`${name}: must be an integer`)
  return v
}

export function text(a: Args, name: string, required: boolean, max: number): string | null {
  if (!present(a, name)) {
    if (required) throw new ArgError(`${name}: is required`)
    return null
  }
  const v = a[name]
  if (typeof v !== 'string') throw new ArgError(`${name}: must be a string`)
  if (required && !v.trim()) throw new ArgError(`${name}: must not be empty`)
  if ([...v].length > max) throw new ArgError(`${name}: at most ${max} characters`)
  return v
}

export function calendarDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export function date(a: Args, name: string): string {
  const v = str(a, name)
  if (v && !calendarDate(v)) throw new ArgError(`${name}: must be a date in YYYY-MM-DD form`)
  return v
}

/** An IANA zone argument (default UTC). */
export function zone(a: Args, name = 'timezone'): string {
  const v = str(a, name)
  if (!v) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: v })
  } catch {
    throw new ArgError(`${name}: unknown time zone ${JSON.stringify(v)}`)
  }
  return v
}

export function limit(a: Args, max: number): number {
  const n = int(a, 'limit')
  if (n === null) return max
  if (n < 1 || n > max) throw new ArgError(`limit: must be from 1 to ${max}`)
  return n
}

/** A bounded list of distinct, non-empty ids. */
export function idList(a: Args, name: string): string[] {
  if (!present(a, name)) throw new ArgError(`${name}: is required`)
  const v = a[name]
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ArgError(`${name}: must be an array of strings`)
  if (v.length === 0) throw new ArgError(`${name}: must not be empty`)
  if (v.length > PER_CALL) throw new ArgError(`${name}: at most ${PER_CALL} items per call (got ${v.length}); split the work into several calls`)
  const out: string[] = []
  for (const raw of v as string[]) {
    const id = raw.trim()
    if (!id || id.length > MAX_ID) throw new ArgError(`${name}: ids must be non-empty strings`)
    if (!out.includes(id)) out.push(id)
  }
  return out
}

/** A bounded array of objects. */
export function items(a: Args, name: string): Args[] {
  if (!present(a, name)) throw new ArgError(`${name}: is required`)
  const v = a[name]
  if (!Array.isArray(v)) throw new ArgError(`${name}: must be an array of objects`)
  if (v.length === 0) throw new ArgError(`${name}: must not be empty`)
  if (v.length > PER_CALL) throw new ArgError(`${name}: at most ${PER_CALL} items per call (got ${v.length}); split the work into several calls`)
  v.forEach((it, i) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) throw new ArgError(`${name}[${i}]: must be an object`)
  })
  return v as Args[]
}

export function notFound(entity: string, missing: string[]): ToolError {
  return new ToolError('not_found', `no such ${entity} (unknown, deleted, or not visible to you); nothing was changed`, { ids: missing })
}

export function forbidden(items: Record<string, unknown>[]): ToolError {
  return new ToolError('forbidden', 'your role in a shared project does not allow this change; nothing was changed', { items })
}
