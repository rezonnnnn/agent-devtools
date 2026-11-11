// Shared by the client and the daemon. Keep this file dependency-light: the
// client loads it on every command.
import os from 'node:os';
import path from 'node:path';

const clean = s => String(s).replace(/[^\w-]/g, '_');

// One daemon per (user, session). CDT_SESSION lets several agents each own a
// separate browser.
export function sockPath(session = process.env.CDT_SESSION || '') {
  let user = 'user';
  try {
    user = os.userInfo().username;
  } catch {}
  const name = `cdt-${clean(user)}${session ? '-' + clean(session) : ''}`;
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}`;
  return path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `${name}.sock`);
}

export const daemonScript = path.join(import.meta.dirname, 'daemon.js');
export const outDir = path.join(os.tmpdir(), 'cdt');
