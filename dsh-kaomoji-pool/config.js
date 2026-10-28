/** Shared, dependency-free row config reader for the bridge and the kaomoji tool. */

/** Finite numbers are floored then clamped; anything else falls back. */
export function clampInteger(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/** Compact kaomoji usage rules, injected whenever the kaomoji tool is mounted. */
export const KAOMOJI_RULES = [
  '颜文字只在轻松、日常或陪伴式回复里自然点缀，每条回复至多 1–2 个，可以不用；正式说明、报错、代码、命令、配置和严肃话题不用。',
  '♡ ♪ ✿ 等文字符号可以作为颜文字的一部分；彩色 Emoji（彩色笑脸、红心、点赞手势等图标）一律不用，它们不是颜文字。需要新候选时可调用 kaomoji 按情绪取样。',
]

/**
 * Read the row config without a Config schema: every field is optional and the
 * plugin stays usable when a value is missing or has the wrong type.
 * @param {unknown} raw the row config from cordis.patch.yml.
 */
export function readConfig(raw = {}) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const int = (key, fallback, min, max) => clampInteger(value[key], fallback, min, max)
  return {
    ...value,
    enabled: value.enabled !== false,
    activation: value.activation === 'scoped' ? 'scoped' : 'auto',
    chatPresets: Array.isArray(value.chatPresets)
      ? value.chatPresets.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim())
      : ['maoqiu'],
    includeSubagents: value.includeSubagents === true,
    art: value.art !== false,
    tool: value.tool !== false,
    prompt: value.prompt !== false,
    maxWidth: int('maxWidth', 120, 16, 240),
    maxHeight: int('maxHeight', 80, 8, 160),
    historySize: int('historySize', 8, 1, 32),
    defaultCount: int('defaultCount', 8, 1, 50),
    maxCount: int('maxCount', 24, 1, 100),
    avoidRecent: int('avoidRecent', 24, 0, 100),
    inlinePerCategory: int('inlinePerCategory', 1, 0, 10),
    inlineCategories: Array.isArray(value.inlineCategories) ? value.inlineCategories : undefined,
    sectionOrder: typeof value.sectionOrder === 'number' && Number.isFinite(value.sectionOrder) ? value.sectionOrder : 10300,
  }
}

/**
 * Colour emoji detector: pictographs, default-emoji-presentation characters,
 * emoji presentation selector VS16, keycap, ZWJ sequences, regional-indicator
 * flags and skin-tone modifiers. Text symbols such as ♡ ♪ ✿ ✧ stay allowed.
 */
export const COLOR_EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F|\u20E3|\u200D|[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]/u

export function hasColorEmoji(text) {
  return COLOR_EMOJI.test(String(text))
}
