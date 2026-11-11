// Shared by the client and the daemon. Keep this file dependency-light: the
// client loads it on every command. native/qai.c mirrors these paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const clean = s => String(s).replace(/[^\w-]/g, '_');

function userName() {
  try {
    return clean(os.userInfo().username);
  } catch {
    return 'user';
  }
}

// A directory only this user can enter. It holds the socket (POSIX) and every
// file qai writes, so nothing lives directly in a shared temp directory.
export function runtimeDir() {
  const base =
    process.platform === 'win32'
      ? os.tmpdir()
      : process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(base, `qai-${userName()}`);
}

// Throws unless `dir` is a real directory owned by this user and closed to
// everyone else. Another local user could otherwise plant it first.
export function assertPrivateDir(dir) {
  if (process.platform === 'win32') return;
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.geteuid() || st.mode & 0o077) {
    throw new Error(
      `${dir} must be a directory owned by you with mode 700; remove it and retry`,
    );
  }
}

// One daemon per (user, session). QAI_SESSION lets several agents each own a
// separate browser.
export function sockPath(session = process.env.QAI_SESSION || '') {
  const suffix = session ? '-' + clean(session) : '';
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\qai-${userName()}${suffix}`;
  }
  return path.join(runtimeDir(), `daemon${suffix}.sock`);
}

export const daemonScript = path.join(import.meta.dirname, 'daemon.js');
export const outDir = runtimeDir();
