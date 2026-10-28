/**
 * Scoped helper for the 毛球模式 preset (merged from @local/dsh-maoqiu-mode).
 * It runs inside the preset's own scope, so denying the optional workloop
 * tools never affects standard-mode agents, and maoqiu_* tools registered by
 * the host-level `maoqiu` row stay visible.
 *
 * The preset scope can activate before the workloop plugin registers its
 * tools (DSH rejects restricting names it does not know yet). The helper
 * therefore denies whichever work_* tools exist now and re-applies on
 * `tools/change`, so later registrations are hidden as well.
 */

export const name = 'maoqiu-mode-tools';
export const inject = ['tools'];

export const WORKLOOP_TOOL_NAMES = Object.freeze([
  'work_action',
  'work_claim',
  'work_contract',
  'work_evidence',
  'work_learn',
  'work_notice',
  'work_verdict',
]);

const UNKNOWN = 'tools.restrict() names unknown global tool';
const knownFrom = (error) => {
  const match = /known global tools: (.*)$/s.exec(error instanceof Error ? error.message : String(error));
  return match ? match[1].split(',').map((item) => item.trim()).filter(Boolean) : [];
};
const isUnknown = (error) => (error instanceof Error ? error.message : String(error)).startsWith(UNKNOWN);

export function apply(ctx, config = {}) {
  if (config.restrictWorkloop === false) return;
  const tools = ctx.tools;
  if (!tools || typeof tools.restrict !== 'function') return;

  let dispose;
  let appliedKey = '';
  const release = () => {
    const current = dispose;
    dispose = undefined;
    appliedKey = '';
    if (typeof current === 'function') current();
  };
  const deny = (names) => {
    const key = names.join(',');
    if (key === appliedKey) return;
    // Install the wider mask before releasing the narrower one: no gap.
    const next = names.length ? tools.restrict({ deny: names }) : undefined;
    const previous = dispose;
    dispose = next;
    appliedKey = key;
    if (typeof previous === 'function') previous();
  };
  let syncing = false;
  const sync = () => {
    // Restricting emits tools/change synchronously; ignore our own echoes.
    if (syncing) return;
    syncing = true;
    try {
      // Let the host validate the complete set in one operation first.
      try { return deny([...WORKLOOP_TOOL_NAMES]); } catch (error) {
        if (!isUnknown(error)) throw error;
        // The host lists the names it knows; deny the workloop subset only.
        const known = new Set(knownFrom(error));
        deny(WORKLOOP_TOOL_NAMES.filter((toolName) => known.has(toolName)));
      }
    } finally { syncing = false; }
  };

  const start = () => {
    sync();
    return release;
  };
  if (typeof ctx.effect === 'function') ctx.effect(start);
  else start();
  if (typeof ctx.on === 'function') {
    ctx.on('tools/change', () => {
      try { sync(); } catch { /* a later change retries; never break the host event */ }
    });
  }
}
