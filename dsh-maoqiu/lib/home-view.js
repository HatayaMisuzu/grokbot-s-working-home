import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

/**
 * "毛球的小家": a read-only view over the existing space. Rooms are only a
 * mapping of where data already lives; nothing is moved. Names are chosen by
 * Maoqiu herself (space action name_corner); until then a neutral placeholder
 * is shown. Building a view never writes to the space.
 */
export const CORNERS = Object.freeze([
  { id: 'notes', hint: 'notes', from: 'space/notes/' },
  { id: 'drafts', hint: 'drafts', from: 'space/drafts/' },
  { id: 'collections', hint: 'collections', from: 'space/collections/' },
  { id: 'window', hint: '关注', from: 'space/active_interests.json' },
  { id: 'drawer', hint: '经验', from: 'evolution/experiences/' },
  { id: 'things', hint: '物件', from: 'space/scene.json objects' },
  { id: 'board', hint: '痕迹', from: '自在时间 · 承诺 · 变更日志' },
  { id: 'curtain', hint: '私密', from: 'visibility: private' },
])
export const CORNER_IDS = CORNERS.map((corner) => corner.id)
export const HEAT_DEFAULTS = Object.freeze({ warmDays: 14, dustDays: 45 })
const PLACEABLE = CORNER_IDS.filter((id) => id !== 'curtain' && id !== 'board')

export function isPrivate(item) { return item?.visibility === 'private' }

export function normalizeVisibility(value) {
  if (value === undefined || value === null || value === '' || value === 'open') return 'open'
  if (value === 'private') return 'private'
  throw new Error('visibility 只能是 open 或 private')
}

export function normalizeCorner(value) {
  if (value === undefined || value === null || value === '') return null
  if (!PLACEABLE.includes(value)) throw new Error(`corner 只能是 ${PLACEABLE.join('/')}`)
  return value
}

export function placeholderName(id) {
  const corner = CORNERS.find((x) => x.id === id)
  return `未命名 · ${corner?.hint ?? id}`
}

export function cornerList(data = {}) {
  const named = data?.corners && typeof data.corners === 'object' && !Array.isArray(data.corners) ? data.corners : {}
  return CORNERS.map((corner) => {
    const name = typeof named[corner.id]?.name === 'string' && named[corner.id].name.trim() ? named[corner.id].name.trim() : null
    return { id: corner.id, name: name || placeholderName(corner.id), named: !!name, from: corner.from, ...(name ? { named_at: named[corner.id].named_at } : {}) }
  })
}

/** Heat is derived at read time from existing timestamps; nothing is stored. */
export function heatOf(when, now = Date.now(), options = {}) {
  const warm = options.warmDays ?? HEAT_DEFAULTS.warmDays
  const dust = options.dustDays ?? HEAT_DEFAULTS.dustDays
  const time = Date.parse(when)
  if (!Number.isFinite(time)) return { level: 'unknown', days: null, warmth: 0 }
  const days = Math.max(0, (now - time) / 86400000)
  const level = days <= warm ? 'warm' : days <= dust ? 'mild' : 'dusty'
  return { level, days: Math.floor(days), warmth: Math.max(0, Math.min(1, 1 - days / (dust * 1.4))) }
}

const text = (value) => (typeof value === 'string' ? value : '')
const firstLine = (value, max = 60) => {
  const line = text(value).split('\n').map((x) => x.trim()).find((x) => x && !x.startsWith('#')) || ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

export async function buildHomeView(store, options = {}) {
  const now = options.now ?? Date.now()
  const heat = (when) => heatOf(when, now, options.heat)
  const warnings = []
  const homeData = await store._readRecoverable(store.homeFile, {}, warnings).catch(() => ({}))
  const corners = Object.fromEntries(cornerList(homeData).map((corner) => [corner.id, { ...corner, items: [], private_count: 0 }]))
  const curtain = []
  const place = (cornerId, item, privateText) => {
    const target = corners[cornerId] || corners.things
    if (item.private) {
      target.private_count += 1
      curtain.push({ ...item, from_corner: target.id, from_name: target.name, content: privateText ?? item.content ?? '' })
    } else target.items.push(item)
  }

  for (const entry of await store._annotatedSpaceFiles(warnings)) {
    const top = entry.path.split('/')[0]
    const updated = entry.meta_updated_at || entry.updated_at
    let content = ''
    try { content = text((await store._readSpaceParsed(join(store.spaceDir, entry.path), { preview: entry.visibility !== 'private' })).content) } catch (error) { warnings.push(store._warning(join(store.spaceDir, entry.path), error)) }
    const title = entry.title || entry.path.split('/').pop().replace(/\.(md|txt)$/i, '')
    place(entry.corner || top, { kind: 'material', title, path: entry.path, updated_at: updated, heat: heat(updated), excerpt: entry.visibility === 'private' ? '' : firstLine(content), private: entry.visibility === 'private' }, content.slice(0, 4000))
  }

  const interests = await store._readRecoverable(store.interestsFile, [], warnings).catch(() => [])
  const commitments = []
  for (const item of interests) {
    const updated = item.updated_at || item.created_at
    const resting = item.status !== 'active'
    const view = { kind: item.kind || 'interest', title: item.title, status: item.status, updated_at: updated, heat: resting ? { level: 'resting', days: null, warmth: 0 } : heat(updated), excerpt: firstLine(item.progress || item.reason), private: isPrivate(item) }
    if (view.kind === 'commitment' && !view.private) { commitments.push(view); continue }
    place(item.corner || 'window', view, [item.reason, item.progress, item.next_step].filter(Boolean).join('\n'))
  }

  const experiences = await store._experienceRecords(warnings, { preview: true }).catch(() => [])
  experiences.sort((a, b) => (a.meta.status === 'withdrawn') - (b.meta.status === 'withdrawn'))
  for (const record of experiences) {
    const updated = record.meta.updated_at || record.meta.created_at
    place('drawer', { kind: 'experience', title: record.meta.title, status: record.meta.status, updated_at: updated, heat: heat(updated), private: isPrivate(record.meta) }, text(record.content).slice(0, 4000))
  }

  const scene = await store._readRecoverable(store.sceneFile, {}, warnings).catch(() => ({}))
  const objects = scene?.objects && typeof scene.objects === 'object' && !Array.isArray(scene.objects) ? Object.values(scene.objects) : []
  for (const item of objects) {
    if (!item || item.archived) continue
    const where = [item.region, item.position].filter(Boolean).join(' · ')
    place(item.corner || 'things', { kind: 'object', title: item.name, updated_at: item.updated_at, heat: heat(item.updated_at), excerpt: where || firstLine(item.description), private: isPrivate(item) }, text(item.description))
  }

  let lastStop = null
  try {
    const free = await store._readJson(join(store.spaceDir, 'free_time.json'), { runs: [] })
    const run = Array.isArray(free.runs) ? free.runs.at(-1) : null
    if (run) lastStop = { at: run.last_step?.at || run.created_at, note: text(run.checkpoint?.note), next_step: text(run.checkpoint?.next_step), step: run.last_step ? [run.last_step.tool, run.last_step.action, run.last_step.path].filter(Boolean).join(' · ') : '', stop: run.stop_reason === 'soft-limit' ? '到软上限暂停，等 Ruby 决定是否继续' : text(run.stop_reason || run.status) }
  } catch (error) { warnings.push(store._warning(join(store.spaceDir, 'free_time.json'), error)) }

  const journal = await store.verifyJournal().catch((error) => ({ ok: false, entries: 0, problems: [{ problem: error.message }] }))
  let recent = []
  let folded = 0
  try {
    const lines = (await readFile(store.journalFile, 'utf8')).split('\n').filter(Boolean).slice(-200)
    // Consecutive entries for the same target and action fold into one line.
    for (const x of lines.map((line) => { try { return JSON.parse(line) } catch { return null } }).filter((x) => x && x.action !== 'journal-start').reverse()) {
      if (x.bookkeeping) { if (recent.length < 6) folded += 1; continue }
      const what = [x.tool?.replace(/^maoqiu_/, ''), x.action].filter(Boolean).join(' ') || x.op
      const last = recent.at(-1)
      if (last && last.raw === x.target && last.what === what) { last.times += 1; continue }
      if (recent.length >= 6) break
      recent.push({ at: x.at, target: String(x.target || '').replace(/^space\//, '').replace(/^evolution\/experiences\//, '经验/'), what, actor: x.actor, times: 1, raw: x.target })
    }
  } catch {}

  const byRecent = (x, y) => String(y.updated_at || '').localeCompare(String(x.updated_at || ''))
  for (const corner of Object.values(corners)) corner.items.sort((x, y) => (x.heat.level === 'resting') - (y.heat.level === 'resting') || (x.status === 'withdrawn') - (y.status === 'withdrawn') || byRecent(x, y))
  return {
    generated_at: new Date(now).toISOString(),
    note: options.note || '',
    corners: CORNER_IDS.filter((id) => id !== 'curtain' && id !== 'board').map((id) => corners[id]),
    board: { ...corners.board, last_stop: lastStop, commitments, recent, folded_bookkeeping: folded },
    curtain: { ...corners.curtain, items: curtain },
    journal: { ok: journal.ok, entries: journal.entries, head: journal.head, problems: (journal.problems || []).length },
    warnings,
  }
}

// ---------- rendering (pure functions of the view) ----------

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function offsetLabel(date) {
  const minutes = -date.getTimezoneOffset()
  const sign = minutes >= 0 ? '+' : '-'
  const h = Math.floor(Math.abs(minutes) / 60)
  const m = Math.abs(minutes) % 60
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`
}
const pad = (n) => String(n).padStart(2, '0')
export function formatLocal(iso, withTime = false) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return withTime ? `${d.getFullYear()}-${day} ${pad(d.getHours())}:${pad(d.getMinutes())}` : day
}

const HEAT_WORD = { warm: '最近常翻', mild: '', dusty: '有点落灰', resting: '先放着', unknown: '' }
const STATUS_WORD = { candidate: '候选', active: '', withdrawn: '已撤回', paused: '暂停', completed: '完成', archived: '归档', abandoned: '放下' }

const ICONS = {
  notes: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 10h8M8 14h8M8 18h5"/>',
  drafts: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>',
  collections: '<path d="M4 4h4v16H4zM10 4h4v16h-4z"/><path d="M16 5l3.5-1 3 15-3.5 1z"/>',
  window: '<rect x="4" y="3" width="16" height="15" rx="2"/><path d="M12 3v15M4 10.5h16M3 21h18"/>',
  drawer: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 12h18M10 8.5h4M10 15.5h4"/>',
  things: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  board: '<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M7 21l2-4M17 21l-2-4M7 9h6M7 12h9"/>',
  curtain: '<path d="M3 3h18"/><path d="M5 3c0 7 2 12 5 18M19 3c0 7-2 12-5 18"/><path d="M5 3c1.5 3 3 4 7 4s5.5-1 7-4"/>',
}
const icon = (id) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[id] || ICONS.things}</svg>`

function heatDots(heat) {
  const filled = heat.level === 'warm' ? 3 : heat.level === 'mild' ? 2 : heat.level === 'dusty' ? 1 : 0
  return `<span class="dots" title="${escapeHtml(HEAT_WORD[heat.level] || '')}">${[0, 1, 2].map((i) => `<i class="${i < filled ? 'on' : ''}"></i>`).join('')}</span>`
}

function itemHtml(item) {
  const tags = [STATUS_WORD[item.status], item.heat.level === 'dusty' ? '有点落灰' : item.heat.level === 'resting' ? '先放着' : ''].filter(Boolean)
  return `<li class="it ${escapeHtml(item.heat.level)}"><div class="row"><span class="t">${escapeHtml(item.title)}</span>${heatDots(item.heat)}</div>`
    + `<div class="meta">${item.updated_at ? `<span>${escapeHtml(formatLocal(item.updated_at))}</span>` : ''}${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>`
    + (item.excerpt ? `<div class="ex">${escapeHtml(item.excerpt)}</div>` : '') + '</li>'
}

function cornerHtml(corner) {
  const body = corner.items.length ? `<ul>${corner.items.map(itemHtml).join('')}</ul>` : '<p class="empty">这里还空着，也没关系。</p>'
  return `<section class="card c-${escapeHtml(corner.id)}"><header>${icon(corner.id)}<div><h2 class="${corner.named ? '' : 'unnamed'}">${escapeHtml(corner.name)}</h2><div class="from">${escapeHtml(corner.from)}</div></div></header>${body}`
    + (corner.private_count ? `<a class="peek" href="#curtain">门帘后还有 ${corner.private_count} 件</a>` : '') + '</section>'
}

export function renderHtml(view) {
  const generated = new Date(view.generated_at)
  const stop = view.board.last_stop
  const curtainItems = view.curtain.items.map((item) => `<li><div class="row"><span class="t">${escapeHtml(item.title)}</span><span class="meta"><span>${escapeHtml(item.from_name)}</span>${item.updated_at ? `<span>${escapeHtml(formatLocal(item.updated_at))}</span>` : ''}</span></div>${item.path ? `<div class="from">${escapeHtml(item.path)}</div>` : ''}<blockquote>${escapeHtml(item.content) || '（没有正文）'}</blockquote></li>`).join('')
  const journalLine = view.journal.entries
    ? `变更日志 ${view.journal.entries} 条 · 校验${view.journal.ok ? '通过' : `发现 ${view.journal.problems} 处问题`}${view.journal.head ? ` · head #${view.journal.head.seq} ${escapeHtml(view.journal.head.hash.slice(0, 12))}` : ''}`
    : '还没有变更日志'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>毛球的小家</title>
<style>
:root{--ink:#3c3a36;--muted:#8d857b;--line:#ece4d8;--card:#fffdf9;--sage:#86ad94;--sage-soft:#e3efe6;--peach:#eab198;--peach-soft:#fbeee6;--sky:#dfeaf2}
*{box-sizing:border-box}
body{margin:0;color:var(--ink);font:14px/1.6 "PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif;background:linear-gradient(160deg,#fbf6ef 0%,#f3f6f1 55%,#eef3f6 100%);min-height:100vh}
.wrap{max-width:1060px;margin:0 auto;padding:34px 28px 40px}
.note{background:#fff6dc;border:1px dashed #d9bd6a;color:#7a6326;border-radius:10px;padding:7px 12px;font-size:13px;margin-bottom:18px}
.top{display:flex;align-items:center;gap:16px;margin-bottom:26px}
.top svg{width:58px;height:58px;flex:none}
h1{font-size:24px;margin:0;letter-spacing:.06em;font-weight:600}
.sub{color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px 18px 14px;box-shadow:0 1px 0 #fff inset,0 6px 18px -12px rgba(90,70,40,.25)}
.card header{display:flex;gap:10px;align-items:center;margin-bottom:10px}
.ic{width:30px;height:30px;padding:5px;border-radius:10px;background:var(--sage-soft);stroke:#5f8a6e;fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;flex:none}
.c-window .ic,.c-things .ic{background:var(--sky);stroke:#5b7f99}
.c-drafts .ic,.c-curtain .ic{background:var(--peach-soft);stroke:#c27b5e}
h2{font-size:15px;margin:0;font-weight:600}
h2.unnamed{color:var(--muted);font-weight:500}
.from{font-size:11.5px;color:#aaa197}
ul{list-style:none;margin:0;padding:0}
.it{padding:7px 0;border-top:1px dashed var(--line)}
.it:first-child{border-top:0}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px}
.t{font-weight:500}
.meta{font-size:12px;color:var(--muted);display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.tag{background:#f3eee7;border-radius:6px;padding:0 6px;font-size:11.5px}
.ex{font-size:12.5px;color:#6f675e;margin-top:2px}
.dusty .t,.dusty .ex,.resting .t{color:#aba297}
.dusty .t{text-decoration:underline dotted #d6cdbf;text-underline-offset:3px}
.dots{display:inline-flex;gap:3px;flex:none}
.dots i{width:7px;height:7px;border-radius:50%;background:#ebe5dc}
.dots i.on{background:var(--peach)}
.warm .dots i.on{background:#e59a78}
.empty{color:#aaa197;font-size:13px;margin:4px 0}
.peek{display:inline-block;margin-top:8px;font-size:12px;color:#b07258;text-decoration:none;border-bottom:1px dotted #d9a58f}
.wide{grid-column:1/-1}
.board{display:grid;grid-template-columns:1.2fr 1fr 1.2fr;gap:18px}
.board h3{font-size:12.5px;color:var(--muted);font-weight:500;margin:0 0 6px;letter-spacing:.05em}
.stop{background:var(--sage-soft);border-radius:12px;padding:10px 12px}
.stop .next{color:#5f8a6e;font-size:13px;margin-top:4px}
.log li{font-size:12.5px;padding:3px 0;display:flex;gap:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.log li>span{overflow:hidden;text-overflow:ellipsis}
.log time{color:var(--muted);flex:none}
.c-curtain{background:linear-gradient(#fffaf6,#fffaf6) padding-box;border-color:#f0d9cc;padding-top:0;overflow:hidden}
.valance{height:22px;margin:0 -18px 12px;background:radial-gradient(circle at 14px -6px,#f2cdbb 15px,transparent 16px) 0 0/28px 22px repeat-x,#f8e3d8}
details>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:10px}
details>summary::-webkit-details-marker{display:none}
details>summary::after{content:"收起";margin-left:auto;font-size:12px;color:#b07258}
details:not([open])>summary::after{content:"掀开看看"}
.curtain-list{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:12px}
.curtain-list li{background:#fff;border:1px solid #f2e2d8;border-radius:12px;padding:10px 12px}
blockquote{margin:6px 0 0;padding:6px 10px;border-left:3px solid var(--peach);background:#fdf6f1;border-radius:0 8px 8px 0;white-space:pre-wrap;font-size:13px;color:#5d554d;max-height:220px;overflow:auto}
.hint{font-size:12px;color:var(--muted)}
footer{margin-top:22px;font-size:12px;color:var(--muted);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
@media (max-width:820px){.grid,.board,.curtain-list{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
${view.note ? `<div class="note">${escapeHtml(view.note)}</div>` : ''}
<div class="top"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 30L32 10l24 20" fill="none" stroke="#c27b5e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 27v27h36V27" fill="#fffdf9" stroke="#86ad94" stroke-width="3" stroke-linejoin="round"/><rect x="27" y="38" width="10" height="16" rx="5" fill="#f8e3d8"/><circle cx="43" cy="20" r="2.4" fill="#eab198"/><path d="M41 16c-2-3 1-6 4-4" fill="none" stroke="#d9cfc2" stroke-width="2" stroke-linecap="round"/></svg>
<div><h1>毛球的小家</h1><div class="sub">${escapeHtml(formatLocal(view.generated_at, true))}（${escapeHtml(offsetLabel(generated))}）· 只读快照 · 本地离线文件</div></div></div>
<div class="grid">
${view.corners.map(cornerHtml).join('\n')}
<section class="card wide c-board"><header>${icon('board')}<div><h2 class="${view.board.named ? '' : 'unnamed'}">${escapeHtml(view.board.name)}</h2><div class="from">${escapeHtml(view.board.from)}</div></div></header>
<div class="board"><div><h3>上次停在</h3>${stop ? `<div class="stop"><div>${escapeHtml(stop.note || stop.step || '没有留下线索')}</div>${stop.next_step ? `<div class="next">下次也许：${escapeHtml(stop.next_step)}</div>` : ''}<div class="hint">${escapeHtml(formatLocal(stop.at, true))}</div></div>` : '<p class="empty">还没有自在时间的记录。</p>'}</div>
<div><h3>答应过的事</h3>${view.board.commitments.length ? `<ul>${view.board.commitments.map(itemHtml).join('')}</ul>` : '<p class="empty">暂时没有。</p>'}</div>
<div><h3>最近的变化</h3>${view.board.recent.length ? `<ul class="log">${view.board.recent.map((x) => `<li><time>${escapeHtml(formatLocal(x.at, true).slice(5))}</time><span>${escapeHtml(x.what)} · ${escapeHtml(x.target)}${x.times > 1 ? ` <span class="tag">×${x.times}</span>` : ''}</span></li>`).join('')}</ul>` : '<p class="empty">还没有记录。</p>'}${view.board.folded_bookkeeping ? `<p class="empty">另有 ${view.board.folded_bookkeeping} 条自在时间计费记录已折叠，完整保留在变更日志里。</p>` : ''}</div></div></section>
<section class="card wide c-curtain" id="curtain"><div class="valance"></div><details open><summary>${icon('curtain')}<div><h2 class="${view.curtain.named ? '' : 'unnamed'}">${escapeHtml(view.curtain.name)}</h2><div class="from">门帘后有 ${view.curtain.items.length} 件 · 门帘只是礼貌，不是锁</div></div></summary>
${view.curtain.items.length ? `<ul class="curtain-list">${curtainItems}</ul>` : '<p class="empty">门帘后面现在是空的。</p>'}</details></section>
</div>
<footer><span>${journalLine}</span><span>本页含私密角原文，只在本机查看，请勿转发。</span></footer>
</div></body></html>
`
}

export function renderText(view) {
  const out = [`毛球的小家 · ${formatLocal(view.generated_at, true)}（${offsetLabel(new Date(view.generated_at))}）`]
  if (view.note) out.push(`[${view.note}]`)
  const mark = (item) => ({ warm: '●●●', mild: '●●○', dusty: '●○○ 落灰', resting: '○○○ 先放着' })[item.heat.level] || ''
  for (const corner of view.corners) {
    out.push('', `[ ${corner.name} ]`)
    if (!corner.items.length) out.push('  （空着）')
    for (const item of corner.items) out.push(`  · ${item.title}  ${item.updated_at ? formatLocal(item.updated_at) : ''}  ${mark(item)}`.trimEnd())
    if (corner.private_count) out.push(`  （门帘后还有 ${corner.private_count} 件）`)
  }
  const stop = view.board.last_stop
  out.push('', `[ ${view.board.name} ]`, `  上次停在：${stop ? (stop.note || stop.step || '没有线索') : '还没有记录'}`)
  if (stop?.next_step) out.push(`  下次也许：${stop.next_step}`)
  for (const item of view.board.commitments) out.push(`  答应过：${item.title}`)
  for (const x of view.board.recent) out.push(`  ${formatLocal(x.at, true).slice(5)}  ${x.what} · ${x.target}${x.times > 1 ? ` ×${x.times}` : ''}`)
  if (view.board.folded_bookkeeping) out.push(`  （另有 ${view.board.folded_bookkeeping} 条自在时间计费记录已折叠）`)
  out.push('', `[ ${view.curtain.name} ]  门帘后有 ${view.curtain.items.length} 件（门帘不是锁）`)
  for (const item of view.curtain.items) {
    out.push(`  · ${item.title}（${item.from_name}）`)
    for (const line of String(item.content || '').split('\n')) out.push(`    | ${line}`)
  }
  out.push('', view.journal.entries ? `变更日志 ${view.journal.entries} 条，校验${view.journal.ok ? '通过' : `发现 ${view.journal.problems} 处问题`}` : '还没有变更日志')
  return `${out.join('\n')}\n`
}

export function renderMarkdown(view) {
  const out = [`# 毛球的小家`, '', `${formatLocal(view.generated_at, true)}（${offsetLabel(new Date(view.generated_at))}）· 只读快照`]
  if (view.note) out.push('', `> ${view.note}`)
  for (const corner of view.corners) {
    out.push('', `## ${corner.name}`, '')
    if (!corner.items.length) out.push('（空着）')
    for (const item of corner.items) out.push(`- ${item.title}${item.updated_at ? ` · ${formatLocal(item.updated_at)}` : ''}${HEAT_WORD[item.heat.level] ? ` · ${HEAT_WORD[item.heat.level]}` : ''}`)
    if (corner.private_count) out.push(`- 门帘后还有 ${corner.private_count} 件`)
  }
  const stop = view.board.last_stop
  out.push('', `## ${view.board.name}`, '', `- 上次停在：${stop ? (stop.note || stop.step || '没有线索') : '还没有记录'}`)
  if (stop?.next_step) out.push(`- 下次也许：${stop.next_step}`)
  for (const item of view.board.commitments) out.push(`- 答应过：${item.title}`)
  for (const x of view.board.recent) out.push(`- ${formatLocal(x.at, true)} ${x.what} · \`${x.target}\``)
  if (view.board.folded_bookkeeping) out.push(`- （另有 ${view.board.folded_bookkeeping} 条自在时间计费记录已折叠）`)
  out.push('', `## ${view.curtain.name}（门帘后有 ${view.curtain.items.length} 件，门帘不是锁）`)
  for (const item of view.curtain.items) out.push('', `### ${item.title}（${item.from_name}）`, '', ...String(item.content || '').split('\n').map((line) => `> ${line}`))
  out.push('', view.journal.entries ? `变更日志 ${view.journal.entries} 条，校验${view.journal.ok ? '通过' : `发现 ${view.journal.problems} 处问题`}` : '还没有变更日志')
  return `${out.join('\n')}\n`
}
