import {spawn, spawnSync} from 'node:child_process';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const bin = path.join(root, 'bin', 'agent-devtools.js');

// Each test file drives its own daemon and browser.
export function makeAdt(session, cwd = root, extraEnv = {}) {
  const env = {...process.env, AGENT_DEVTOOLS_SESSION: session, ...extraEnv};
  const run = (...args) => {
    const input = typeof args.at(-1) === 'object' ? args.pop().input : undefined;
    const r = spawnSync(process.execPath, [bin, ...args], {
      env,
      cwd,
      input,
      encoding: 'utf8',
      timeout: 120_000,
    });
    return {out: r.stdout.trimEnd(), err: r.stderr.trimEnd(), code: r.status};
  };
  // Runs a command that must succeed and returns its stdout.
  run.ok = (...args) => {
    const r = run(...args);
    if (r.code !== 0) {
      throw new Error(`agent-devtools ${args.join(' ')} -> ${r.code}\n${r.out}\n${r.err}`);
    }
    return r.out;
  };
  return run;
}

export function startFixture() {
  const child = spawn(
    process.execPath,
    [path.join(import.meta.dirname, 'fixture', 'server.mjs')],
    {stdio: ['ignore', 'pipe', 'inherit']},
  );
  return new Promise(resolve => {
    child.stdout.once('data', d => {
      resolve({url: String(d).trim(), close: () => child.kill()});
    });
  });
}

// uid of the first snapshot line matching `pattern`.
export function uidOf(snapshot, pattern) {
  for (const line of snapshot.split('\n')) {
    if (pattern.test(line)) return line.trim().split(' ')[0];
  }
  throw new Error(`no snapshot line matches ${pattern}\n${snapshot}`);
}

// Flags every test daemon starts with. CI adds to them (see ci.yml).
export const BROWSER_FLAGS = [
  '--headless',
  '--isolated',
  ...(process.env.AGENT_DEVTOOLS_TEST_FLAGS ?? '').split(' ').filter(Boolean),
];
