/** Generic text canvas. No character templates, subject catalog, or model calls. */
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' })
const MAX_TEXT = 65536
const MAX_OBJECTS = 128
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u
const graphemes = text => Array.from(segmenter.segment(text), item => item.segment)
const hasIndependentMark = text => text.split('\n').some(line => graphemes(line).some(glyph => glyphWidth(glyph) === 0))

/** Width estimate for a monospace canvas; ambiguous Unicode remains font-dependent. */
export function glyphWidth(glyph) {
  if (/^\p{Mark}+$/u.test(glyph)) return 0
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\ufe0f|\u20e3/u.test(glyph)) return 2
  const cp = glyph.codePointAt(0)
  return cp >= 0x1100 && (
    cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1b000 && cp <= 0x1b2ff) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) ? 2 : 1
}

function requireText(value, name = 'text') {
  if (typeof value !== 'string') throw new Error(`${name} 必须是字符串`)
  if (value.length > MAX_TEXT) throw new Error(`${name} 超过 ${MAX_TEXT} 字符；请拆成较小作品`)
  const match = value.match(UNSAFE)
  if (match) throw new Error(`${name} 含不支持的控制字符 U+${match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
  if (/[\ud800-\udfff]/u.test(value)) throw new Error(`${name} 含无效 Unicode 代理码点`)
  return value
}

export function normalizeText(value) {
  const original = requireText(value)
  const text = original.replace(/\r\n?/g, '\n').split('\n').map(line => {
    let column = 0
    let out = ''
    for (const glyph of graphemes(line)) {
      if (glyph === '\t') {
        const spaces = 4 - column % 4
        out += ' '.repeat(spaces)
        column += spaces
      } else {
        out += glyph
        column += glyphWidth(glyph)
      }
    }
    return out
  }).join('\n')
  if (text.length > MAX_TEXT) throw new Error('Tab 展开后的文本过大；请缩小作品')
  return text
}

export function measureText(value, limits = { maxWidth: 120, maxHeight: 80 }) {
  const text = normalizeText(value)
  const lines = text.split('\n')
  const lineWidths = lines.map(line => graphemes(line).reduce((sum, glyph) => sum + glyphWidth(glyph), 0))
  const warnings = []
  if (/[^\x00-\x7f]/u.test(text)) warnings.push('Unicode 宽度为等宽字体下的估计；请确认 DSH 实际显示，需要时改用 ASCII。')
  if (hasIndependentMark(text)) warnings.push('存在独立组合附加符，可能依赖前一个字符显示。')
  const overflowLines = lineWidths.flatMap((width, i) => width > limits.maxWidth ? [i + 1] : [])
  if (overflowLines.length) warnings.push(`第 ${overflowLines.slice(0, 8).join('、')} 行超过 ${limits.maxWidth} 列；调整布局，勿截断图形。`)
  if (lines.length > limits.maxHeight) warnings.push(`共 ${lines.length} 行，超过 ${limits.maxHeight} 行；请缩小或分幅。`)
  if (!text.trim()) warnings.push('画面为空。')
  if (text !== value) warnings.push('已统一换行为 LF，并将 Tab 按 4 列制表位展开；其余空格原样保留。')
  return {
    text, width: Math.max(0, ...lineWidths), height: lines.length,
    lineWidths, warnings,
    fits: overflowLines.length === 0 && lines.length <= limits.maxHeight,
  }
}

export function toMarkdown(text) {
  const runs = text.match(/`+/g) || []
  const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)))
  return `${fence}\n${text}\n${fence}`
}

function integer(value, name, min = 0, max = 10000) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min}–${max} 的整数`)
  return value
}

function brush(value, fallback) {
  if (value === undefined) return fallback
  requireText(value, 'char/fill')
  if (graphemes(value).length !== 1 || glyphWidth(value) !== 1 || /\s/u.test(value) && value !== ' ')
    throw new Error('char/fill 必须是一个单列字符；多列符号请用 text 图层')
  return value
}

function objectOf(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('objects 里的每项必须是对象')
  const id = raw.id ?? `layer-${index + 1}`
  if (typeof id !== 'string' || !id.trim() || id.length > 64) throw new Error('图层 id 必须是 1–64 字符的非空字符串')
  const kind = raw.kind
  if (!['text', 'line', 'box', 'ellipse'].includes(kind)) throw new Error(`图层 ${id} 的 kind 可选 text、line、box、ellipse`)
  const x = integer(raw.x ?? 0, `${id}.x`)
  const y = integer(raw.y ?? 0, `${id}.y`)
  const value = { id, kind, x, y }
  if (kind === 'text') {
    value.text = normalizeText(raw.text)
    value.transparent = raw.transparent !== false
    const metrics = measureText(value.text, { maxWidth: 10000, maxHeight: 10000 })
    if (hasIndependentMark(value.text))
      throw new Error(`${id} 有独立组合附加符；将它与基字符写在同一个字素中`)
    return { ...value, width: metrics.width, height: metrics.height }
  }
  if (kind === 'line') {
    const x2 = integer(raw.x2, `${id}.x2`)
    const y2 = integer(raw.y2, `${id}.y2`)
    const dx = x2 - x, dy = y2 - y
    const fallback = Math.abs(dx) >= Math.abs(dy) * 2 ? '-' : Math.abs(dy) >= Math.abs(dx) * 2 ? '|' : dx * dy >= 0 ? '\\' : '/'
    return { ...value, x2, y2, char: brush(raw.char, fallback) }
  }
  value.width = integer(raw.width, `${id}.width`, 2)
  value.height = integer(raw.height, `${id}.height`, 2)
  if (raw.char !== undefined) value.char = brush(raw.char)
  if (raw.fill !== undefined) value.fill = brush(raw.fill)
  return value
}

function bounds(object) {
  return object.kind === 'line'
    ? { right: Math.max(object.x, object.x2) + 1, bottom: Math.max(object.y, object.y2) + 1 }
    : { right: object.x + object.width, bottom: object.y + object.height }
}

function line(x, y, x2, y2, draw) {
  const dx = Math.abs(x2 - x), dy = -Math.abs(y2 - y)
  const sx = x < x2 ? 1 : -1, sy = y < y2 ? 1 : -1
  let error = dx + dy
  while (true) {
    draw(x, y)
    if (x === x2 && y === y2) break
    const twice = 2 * error
    if (twice >= dy) { error += dy; x += sx }
    if (twice <= dx) { error += dx; y += sy }
  }
}

export function renderCanvas(input, limits) {
  if (!Array.isArray(input.objects) || !input.objects.length || input.objects.length > MAX_OBJECTS)
    throw new Error(`objects 需要 1–${MAX_OBJECTS} 个自绘图层`)
  const objects = input.objects.map(objectOf)
  if (new Set(objects.map(object => object.id)).size !== objects.length) throw new Error('图层 id 不能重复')
  const style = input.style ?? 'ascii'
  if (!['ascii', 'unicode'].includes(style)) throw new Error('style 可选 ascii、unicode')
  const edges = objects.map(bounds)
  const width = integer(input.width ?? Math.max(...edges.map(edge => edge.right)), 'width', 1, limits.maxWidth)
  const height = integer(input.height ?? Math.max(...edges.map(edge => edge.bottom)), 'height', 1, limits.maxHeight)
  const overflow = objects.filter((object, i) => edges[i].right > width || edges[i].bottom > height)
  if (overflow.length) throw new Error(`图层 ${overflow.map(object => object.id).join('、')} 超出 ${width}×${height} 画布；增大画布或移动/缩小图层，不会自动裁切`)
  const grid = Array.from({ length: height }, () => Array(width).fill(null))
  const put = (x, y, text) => {
    const cellWidth = glyphWidth(text)
    const row = grid[y]
    if (!row || x < 0 || x + cellWidth > width) throw new Error('绘制位置超出画布')
    for (let k = x; k < x + cellWidth; k++) {
      const previous = row[k]
      if (previous) for (let c = previous.x; c < previous.x + previous.width; c++) row[c] = null
    }
    const glyph = { x, width: cellWidth, text }
    for (let k = x; k < x + cellWidth; k++) row[k] = glyph
  }
  for (const object of objects) {
    const { x, y, kind } = object
    if (kind === 'text') {
      object.text.split('\n').forEach((row, j) => {
        let column = x
        for (const glyph of graphemes(row)) {
          if (!(object.transparent && glyph === ' ')) put(column, y + j, glyph)
          column += glyphWidth(glyph)
        }
      })
    } else if (kind === 'line') {
      line(x, y, object.x2, object.y2, (a, b) => put(a, b, object.char))
    } else {
      const right = x + object.width - 1, bottom = y + object.height - 1
      if (kind === 'box') {
        if (object.fill !== undefined)
          for (let b = y + 1; b < bottom; b++) for (let a = x + 1; a < right; a++) put(a, b, object.fill)
        const chars = object.char ? Array(6).fill(object.char) : style === 'unicode' ? ['─', '│', '┌', '┐', '└', '┘'] : ['-', '|', '+', '+', '+', '+']
        for (let a = x + 1; a < right; a++) { put(a, y, chars[0]); put(a, bottom, chars[0]) }
        for (let b = y + 1; b < bottom; b++) { put(x, b, chars[1]); put(right, b, chars[1]) }
        put(x, y, chars[2]); put(right, y, chars[3]); put(x, bottom, chars[4]); put(right, bottom, chars[5])
      } else {
        const cx = (x + right) / 2, cy = (y + bottom) / 2
        const rx = (right - x) / 2, ry = (bottom - y) / 2
        if (object.fill !== undefined)
          for (let b = y; b <= bottom; b++) for (let a = x; a <= right; a++)
            if (((a - cx) / rx) ** 2 + ((b - cy) / ry) ** 2 < 1) put(a, b, object.fill)
        const steps = Math.max(object.width, object.height) * 8
        let previous
        for (let i = 0; i <= steps; i++) {
          const angle = i * Math.PI * 2 / steps
          const point = [Math.round(cx + rx * Math.cos(angle)), Math.round(cy + ry * Math.sin(angle))]
          if (previous) line(...previous, ...point, (a, b) => put(a, b, object.char ?? '*'))
          previous = point
        }
      }
    }
  }
  const text = grid.map(row => {
    let out = ''
    for (let x = 0; x < width;) {
      const glyph = row[x]
      if (glyph) { out += glyph.text; x += glyph.width }
      else { out += ' '; x++ }
    }
    return out
  }).join('\n')
  const metrics = measureText(text, limits)
  return { ...metrics, document: { kind: 'canvas', objects, width, height, style } }
}

export function createEngine(config = {}) {
  const limits = { maxWidth: config.maxWidth ?? 120, maxHeight: config.maxHeight ?? 80 }
  const historySize = config.historySize ?? 8
  const byAgent = new WeakMap()
  const fallback = { sequence: 0, works: new Map() }
  const stateFor = execution => {
    const agent = execution?.agent
    if (!agent || !['object', 'function'].includes(typeof agent)) return fallback
    if (!byAgent.has(agent)) byAgent.set(agent, { sequence: 0, works: new Map() })
    return byAgent.get(agent)
  }
  const find = (state, id) => {
    const key = id === 'latest' ? [...state.works.keys()].at(-1) : id
    const work = state.works.get(key)
    if (!work) throw new Error('找不到该 artId（可能已淘汰或属于其他会话）；重新提供原文，或读取已保存的作品')
    return work
  }
  function commit(state, result, parentId) {
    if (!result.text.trim()) throw new Error('不能保存空白作品')
    if (!result.fits) throw new Error(result.warnings.filter(warning => /超过/.test(warning)).join('；'))
    const artId = `art-${++state.sequence}`
    const work = { artId, ...result, ...(parentId ? { parentId } : {}) }
    state.works.set(artId, work)
    while (state.works.size > historySize) state.works.delete(state.works.keys().next().value)
    return publicWork(work)
  }
  return {
    run(args, execution) {
      execution?.signal?.throwIfAborted()
      const action = args.action
      if (action === 'check') return { action, ...measureText(args.text, limits) }
      const state = stateFor(execution)
      if (action === 'inspect') {
        const work = find(state, args.artId ?? 'latest')
        return { action, ...publicWork(work), document: structuredClone(work.document) }
      }
      if (action === 'draw') {
        if ((args.text !== undefined) === (args.objects !== undefined)) throw new Error('draw 只传 text 或 objects 其中一种')
        const result = args.text !== undefined
          ? { ...measureText(args.text, limits), document: { kind: 'raw', text: normalizeText(args.text) } }
          : renderCanvas(args, limits)
        return { action, ...commit(state, result) }
      }
      if (action === 'edit') {
        const base = find(state, args.artId ?? 'latest')
        let result
        if (args.text !== undefined) {
          if (args.changes !== undefined) throw new Error('整幅替换 text 与局部 changes 不能同时使用')
          result = { ...measureText(args.text, limits), document: { kind: 'raw', text: normalizeText(args.text) } }
        } else {
          if (base.document.kind !== 'canvas') throw new Error('原作是原文画；用 text 提交修改后的全文，或新建 objects 图层画布')
          if (!Array.isArray(args.changes) || !args.changes.length || args.changes.length > MAX_OBJECTS) throw new Error(`局部修改需要 1–${MAX_OBJECTS} 项 changes 数组`)
          const objects = structuredClone(base.document.objects)
          const ids = new Set()
          for (const change of args.changes) {
            if (!change || typeof change !== 'object' || typeof change.id !== 'string') throw new Error('每个 change 必须指定图层 id')
            if (ids.has(change.id)) throw new Error('一次 changes 不能重复修改同一 id')
            ids.add(change.id)
            const index = objects.findIndex(object => object.id === change.id)
            if (change.remove === true) {
              if (index < 0) throw new Error(`没有可删除的图层 ${change.id}`)
              if (Object.keys(change).some(key => !['id', 'remove'].includes(key))) throw new Error('remove:true 不能同时修改其他字段')
              objects.splice(index, 1)
            } else {
              const { remove, ...patch } = change
              if (index >= 0) objects[index] = { ...objects[index], ...patch }
              else objects.push(patch)
            }
          }
          result = renderCanvas({ ...base.document, objects, width: args.width ?? base.document.width, height: args.height ?? base.document.height, style: args.style ?? base.document.style }, limits)
        }
        return { action, ...commit(state, result, base.artId) }
      }
      throw new Error('action 可选 guide、draw、edit、check、inspect')
    },
  }
}

function publicWork(work) {
  const { document, ...result } = work
  return { ...structuredClone(result), layers: document.kind === 'canvas' ? document.objects.map(({ id, kind, x, y }) => ({ id, kind, x, y })) : [] }
}
