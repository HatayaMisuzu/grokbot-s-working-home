/**
 * Working rhythm for one drawing: draw once → check once → at most two edits → deliver.
 * The tool cannot stop the model, so it only returns a short next-step hint and counters.
 */
export const MAX_EDITS = 2

export const PACE_RULE = '节奏：draw 1 次 → check 1 次 → 最多 edit 2 次 → 交付。'

export const TOOL_ONLY = '字符画只用 text_art 的 draw/check/edit；禁止用 bash、python 或其他方式画字符画。'

export function advancePace(state, action) {
  let pace = state.pace
  if (action === 'draw') {
    // A new draw before any check is a redraw of the same piece, not a new piece.
    if (pace && pace.checks === 0 && pace.edits === 0) pace.redraws += 1
    else pace = state.pace = { draws: 1, redraws: 0, checks: 0, edits: 0 }
  } else if (!pace) {
    pace = state.pace = { draws: 0, redraws: 0, checks: 0, edits: 0 }
  }
  if (action === 'check') pace.checks += 1
  if (action === 'edit') pace.edits += 1
  return { ...pace, hint: paceHint(action, pace) }
}

function paceHint(action, pace) {
  if (action === 'draw') {
    const redraw = pace.redraws > 0 ? `已整幅重画 ${pace.redraws} 次且还没有 check，不要再重画；` : ''
    return `${redraw}交付前先调用 check(text=这幅画, elements=[题目和配文里必须画出的要素], request=用户原话, caption=准备附的配文) 核对要素。${PACE_RULE}${TOOL_ONLY}`
  }
  if (action === 'check') {
    return pace.edits >= MAX_EDITS
      ? `修改次数已用完（${MAX_EDITS} 次），直接交付当前画面。${TOOL_ONLY}`
      : `按上面的要素逐项指认；缺的用 edit 补（还可 edit ${MAX_EDITS - pace.edits} 次），都在就直接交付。${TOOL_ONLY}`
  }
  if (action === 'edit') {
    return pace.edits >= MAX_EDITS
      ? `已修改 ${pace.edits} 次，达到上限，现在交付这一版，不要再画或改。${TOOL_ONLY}`
      : `已修改 ${pace.edits} 次，还可再改 ${MAX_EDITS - pace.edits} 次；没有明显缺失就直接交付。${TOOL_ONLY}`
  }
  return ''
}
