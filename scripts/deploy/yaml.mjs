// The one strict YAML subset parser behind every deploy template check (OpenSpec changes
// platform-catalogs and contributor-docs-and-template-checks). It replaced four hand-written
// parsers (Coolify, CasaOS, TrueNAS and the Umbrel manifest) that accepted different things.
//
// Always supported: block maps (plain or quoted keys), block sequences, plain, single- and
// double-quoted scalars, plain scalars folded over several lines, flow sequences
// ([a, "b", [c]]), the empty map {}, and comments. Always refused, with a line number:
// anchors, aliases, tags, flow maps, directives, tabs, CR line endings, duplicate keys, odd
// indentation and the `|+`/`>+` block scalars.
// A file the checker reads is a file it understood.
//
// A profile narrows the subset to what a platform's file may use:
//   strings          true: every scalar stays a string (a compose file's `8080` is "8080"),
//                    false: plain scalars resolve like YAML 1.2 core (bool, null, int, float)
//   blockScalars     the block scalar headers allowed (`|`, `|-`, `>`, `>-`)
//   mapsInSequences  whether `- key: value` items are allowed
//   quoteDates       true: refuse unquoted dates (YAML 1.1 parsers read them as timestamps)

/** TrueNAS, Easypanel, CapRover, Render, Synology, Helm: everything the parser reads. */
export const YAML_FULL = Object.freeze({ strings: false, blockScalars: Object.freeze(['|', '|-', '>', '>-']), mapsInSequences: true, quoteDates: false })
/** Coolify-style compose files (Coolify, Dokploy, Runtipi, Umbrel's compose): strings, no block scalars, no maps in sequences. */
export const YAML_COMPOSE = Object.freeze({ strings: true, blockScalars: Object.freeze([]), mapsInSequences: false, quoteDates: false })
/** The CasaOS compose file: typed scalars, literal block scalars only, quoted dates. */
export const YAML_CASAOS = Object.freeze({ strings: false, blockScalars: Object.freeze(['|', '|-']), mapsInSequences: true, quoteDates: true })
/** The Umbrel manifest (umbrel-app.yml): strings, folded `>-` text only. */
export const YAML_UMBREL_MANIFEST = Object.freeze({ strings: true, blockScalars: Object.freeze(['>-']), mapsInSequences: true, quoteDates: false })

const PLAIN_KEY = /^([A-Za-z0-9_$][A-Za-z0-9_$./-]*|"[^"\\]*"|'[^']*'):(?:[ ]+(.*))?$/

/**
 * Splits a trailing ` # comment` off a line, outside quotes: [text, comment | null].
 * A quote only opens a string at the start of a token, so `it's` in a plain scalar is text.
 */
export function splitComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s[,:-]/.test(line[i - 1])) quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return [line.slice(0, i).trimEnd(), line.slice(i + 1).trim()]
    }
  }
  return [line, null]
}

const stripComment = (s) => splitComment(s)[0].trimEnd()

/** One scalar or flow sequence written on one line. */
export function parseScalar(s, no = 0, profile = YAML_FULL) {
  const fail = (m) => { throw new Error(`line ${no}: ${m}: ${s}`) }
  if (s.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(s)) fail('unterminated or trailing text after a double-quoted string')
    try { return JSON.parse(s) } catch { fail('unsupported escape in a double-quoted string') }
  }
  if (s.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(s)) fail('unterminated or trailing text after a single-quoted string')
    return s.slice(1, -1).replace(/''/g, "'")
  }
  if (s.startsWith('[')) {
    let pos = 0
    const flow = () => {
      if (s[pos] !== '[') fail('expected [')
      pos++
      const out = []
      const ws = () => { while (s[pos] === ' ') pos++ }
      ws()
      if (s[pos] === ']') { pos++; return out }
      for (;;) {
        ws()
        if (s[pos] === '[') out.push(flow())
        else {
          const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,[\]{}]+)/.exec(s.slice(pos))
          if (!m) fail('unsupported flow sequence item')
          pos += m[0].length
          out.push(parseScalar(m[0].trim(), no, profile))
        }
        ws()
        if (s[pos] === ',') { pos++; continue }
        if (s[pos] === ']') { pos++; return out }
        fail('expected , or ] in a flow sequence')
      }
    }
    const v = flow()
    if (pos !== s.length) fail('trailing text after a flow sequence')
    return v
  }
  if (s === '{}') return {}
  if (/^[{&*!|>%@`]/.test(s)) fail('unsupported YAML (anchors, aliases, tags, flow maps and block scalars here are not in the supported YAML subset)')
  if (/: |:$/.test(s)) fail('a plain scalar may not contain ": " (quote it)')
  if (profile.quoteDates && /^\d{4}-\d{2}-\d{2}/.test(s)) fail('quote dates, other parsers read them as timestamps')
  if (profile.strings) return s
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return null
  if (/^[-+]?\d+$/.test(s)) return Number(s)
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s)
  return s
}

/** Parses `text` in the subset `profile` allows; throws with a line number on anything else. */
export function parseYaml(text, profile = YAML_FULL) {
  const raw = text.split('\n')
  raw.forEach((l, i) => {
    if (l.includes('\t')) throw new Error(`line ${i + 1}: tabs are not allowed`)
    if (l.includes('\r')) throw new Error(`line ${i + 1}: use \\n line endings`)
  })
  const blank = (l) => l.trim() === '' || l.trim().startsWith('#')
  const indentOf = (l) => l.length - l.trimStart().length
  let i = 0
  const skip = () => { while (i < raw.length && blank(raw[i])) i++ }
  const peek = () => { skip(); return i < raw.length ? { indent: indentOf(raw[i]), text: stripComment(raw[i].trim()), no: i + 1 } : null }
  const isItem = (t) => t === '-' || t.startsWith('- ')
  const scalar = (s, no) => parseScalar(s, no, profile)

  function node(indent) {
    const p = peek()
    return isItem(p.text) ? seq(indent) : map(indent)
  }

  function seq(indent) {
    const out = []
    for (let p = peek(); p && p.indent === indent && isItem(p.text); p = peek()) {
      if (p.text === '-') {
        i++
        const n = peek()
        if (!n || n.indent <= indent) throw new Error(`line ${p.no}: empty sequence item`)
        if (!profile.mapsInSequences && !isItem(n.text)) throw new Error(`line ${n.no}: maps inside sequences are not supported in this file`)
        out.push(node(n.indent))
        continue
      }
      const rest = p.text.slice(1).trimStart()
      const col = indent + (p.text.length - rest.length)
      if (PLAIN_KEY.test(rest)) {
        if (!profile.mapsInSequences) throw new Error(`line ${p.no}: maps inside sequences are not supported in this file`)
        raw[i] = ' '.repeat(col) + rest // the item is a map starting at the item's column
        out.push(map(col))
      } else {
        i++
        out.push(value(rest, p.no, indent))
      }
    }
    return out
  }

  function map(indent) {
    const out = {}
    for (let p = peek(); p && p.indent === indent && !isItem(p.text); p = peek()) {
      const m = PLAIN_KEY.exec(p.text)
      if (!m) throw new Error(`line ${p.no}: expected "key:" or "key: value", got: ${p.text}`)
      const key = /^["']/.test(m[1]) ? m[1].slice(1, -1) : m[1]
      if (Object.hasOwn(out, key)) throw new Error(`line ${p.no}: duplicate key ${key}`)
      i++
      const v = m[2] ?? ''
      if (v === '') {
        const n = peek()
        if (n && n.indent > indent && !isItem(n.text) && !PLAIN_KEY.test(n.text)) {
          i++
          out[key] = /^["'[{]/.test(n.text) ? scalar(n.text, n.no) : value(n.text, n.no, indent, true)
        } else if (n && n.indent > indent) out[key] = node(n.indent)
        else if (n && n.indent === indent && isItem(n.text)) out[key] = seq(indent)
        else out[key] = null
      } else if (/^[|>][-+]?$/.test(v)) {
        if (!profile.blockScalars.includes(v)) {
          const allowed = profile.blockScalars.length ? `only ${profile.blockScalars.join(', ')}` : 'none'
          throw new Error(`line ${p.no}: unsupported YAML: block scalar ${v} (this file may use ${allowed})`)
        }
        out[key] = blockScalar(v, indent)
      } else {
        out[key] = value(v, p.no, indent)
      }
      const n = peek()
      if (n && n.indent > indent) throw new Error(`line ${n.no}: unexpected indentation`)
    }
    return out
  }

  /** A scalar, folding the more-indented plain lines that follow it. */
  function value(v, no, indent, forcePlain = false) {
    if (/^["'[{]/.test(v)) return scalar(v, no)
    if (forcePlain && /: |:$| #/.test(v)) throw new Error(`line ${no}: a plain scalar may not contain ": " or " #"`)
    let out = v
    let more = false
    for (;;) {
      const from = i
      const n = peek()
      if (!n || n.indent <= indent || isItem(n.text) || PLAIN_KEY.test(n.text)) { i = from; break }
      if (/: |:$| #/.test(n.text)) throw new Error(`line ${n.no}: a plain scalar may not contain ": " or " #"`)
      if (raw.slice(from, i).some((l) => l.trim().startsWith('#'))) throw new Error(`line ${n.no}: comment inside a plain scalar`)
      const empties = i - from
      out += empties ? '\n'.repeat(empties) + n.text : ' ' + n.text
      more = true
      i++
    }
    if (!more) return scalar(v, no)
    scalar(v, no) // the first line must be a valid plain scalar on its own
    return out
  }

  /** `|` keeps line breaks, `>` folds single breaks to spaces (each blank line is a newline); `-` strips the final one. */
  function blockScalar(style, indent) {
    const lines = []
    let blockIndent = null
    while (i < raw.length) {
      const l = raw[i]
      if (l.trim() === '') { lines.push(''); i++; continue }
      const ind = indentOf(l)
      if (ind <= indent) break
      if (blockIndent === null) blockIndent = ind
      if (ind < blockIndent) throw new Error(`line ${i + 1}: block scalar line is less indented than its first line`)
      lines.push(l.slice(blockIndent))
      i++
    }
    while (lines.length && lines.at(-1) === '') lines.pop()
    const body = style[0] === '|' ? lines.join('\n') : fold(lines)
    return style.endsWith('-') ? body : body + '\n'
  }

  const first = peek()
  if (!first) return {}
  if (first.indent !== 0) throw new Error(`line ${first.no}: document must start at column 0`)
  const doc = node(0)
  const left = peek()
  if (left) throw new Error(`line ${left.no}: could not parse (check the indentation)`)
  return doc
}

/** YAML folding: lines join with a space, each blank line between them is a newline. */
function fold(lines) {
  let out = ''
  let blanks = 0
  for (const l of lines) {
    if (l === '') { blanks++; continue }
    if (out) out += blanks ? '\n'.repeat(blanks) : ' '
    out += l
    blanks = 0
  }
  return out
}
