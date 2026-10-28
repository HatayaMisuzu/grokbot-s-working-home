import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const WINDOWS_DEFAULT_HOME = 'E:/maoqiu_home';

/**
 * Default Maoqiu home. Priority: plugin config `home` (handled by the caller),
 * then MAOQIU_HOME, then a platform default. Windows keeps E:\maoqiu_home for
 * existing installs; other platforms use $XDG_DATA_HOME/maoqiu_home, falling
 * back to ~/.local/share/maoqiu_home. All candidates stay outside ~/.dsh.
 */
export function defaultHome({ env = process.env, platform = process.platform, home = homedir } = {}) {
  if (env.MAOQIU_HOME) return env.MAOQIU_HOME;
  if (platform === 'win32') return WINDOWS_DEFAULT_HOME;
  const xdg = env.XDG_DATA_HOME;
  if (typeof xdg === 'string' && isAbsolute(xdg)) return join(xdg, 'maoqiu_home');
  return join(typeof home === 'function' ? home() : home, '.local', 'share', 'maoqiu_home');
}
