/**
 * Keep the 毛球 preset lightweight when the profile also has the optional
 * workloop package installed globally. This runs in the preset's scoped
 * context, so the restriction cannot affect standard-mode agents.
 */

export const name = 'maoqiu-mode-tools'
export const inject = ['tools']

export const WORKLOOP_TOOL_NAMES = Object.freeze([
  'work_action',
  'work_claim',
  'work_contract',
  'work_evidence',
  'work_learn',
  'work_notice',
  'work_verdict',
])

export function apply(ctx, config = {}) {
  if (config.restrictWorkloop === false) return
  const tools = ctx.tools
  if (!tools || typeof tools.restrict !== 'function') return

  // Let the host validate the complete optional set in one operation. A
  // profile without workloop reports the documented unknown-tool error; that
  // one case is safe to ignore. Other failures must remain visible.
  const restrict = () => tools.restrict({ deny: WORKLOOP_TOOL_NAMES })
  try {
    return typeof ctx.effect === 'function' ? ctx.effect(restrict) : restrict()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('tools.restrict() names unknown global tool')) return
    throw error
  }
}

