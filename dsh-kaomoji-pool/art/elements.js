/**
 * Element review for text_art check: a reminder, not a judge. The tool cannot
 * see meaning in characters, so it turns the model's own list of key elements
 * (taken from the request and caption) into an explicit checklist, plus a few
 * cheap textual signals.
 */
const MAX_ELEMENTS = 12

function cleanList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  return value
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item && !seen.has(item) && seen.add(item))
    .slice(0, MAX_ELEMENTS)
}

/**
 * @param {{ text?: string, elements?: unknown, request?: unknown, caption?: unknown }} input
 * @returns {{ elements: string[], hints: string[] } | undefined}
 */
export function reviewElements({ text = '', elements, request, caption } = {}) {
  const list = cleanList(elements)
  const req = typeof request === 'string' ? request.trim() : ''
  const cap = typeof caption === 'string' ? caption.trim() : ''
  if (list.length === 0 && !req && !cap) return undefined
  const hints = []
  if (list.length === 0) {
    hints.push('没有给出 elements：请从题目和配文里列出必须画出的主体、物件、动作和状态（例如“猫耳”“闭眼”“月亮”“抱”），再次 check。')
    return { elements: list, hints }
  }
  for (const element of list) {
    const labelled = text.includes(element)
    const where = [req.includes(element) && '题目', cap.includes(element) && '配文'].filter(Boolean).join('、')
    hints.push(`□ ${element}${where ? `（${where}提到）` : ''}：在画中指出它在哪几行哪几列；指不出来就补画或重画${labelled ? '。注意：画里直接写了“' + element + '”这几个字，文字标签不能代替画面' : ''}`)
  }
  if (cap) hints.push('配文里描述的每件事画里都要有；没画出来的从配文删掉，不要用文字补救画面。')
  return { elements: list, hints }
}
