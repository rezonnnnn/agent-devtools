// The native client must be indistinguishable from bin/zli.js. Skipped when
// the binary for this platform has not been built (npm run build:native).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {after, before, test} from 'node:test';
import {BROWSER_FLAGS, makeZli} from './helpers.mjs';

const exe = path.join(
  import.meta.dirname,
  '..',
  'native',
  `zli-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`,
);
const skip = !fs.existsSync(exe) && 'native client not built';
const session = `native-${process.pid}`;
const node = makeZli(session);

function native(...args) {
  const r = spawnSync(exe, args, {
    env: {...process.env, ZLI_SESSION: session},
    encoding: 'utf8',
    timeout: 120_000,
  });
  return {out: r.stdout.trimEnd(), err: r.stderr.trimEnd(), code: r.status};
}

before(() => {
  if (!skip) node('stop');
});
after(() => node('stop'));

test('with no daemon it hands over to node, which starts one', {skip}, () => {
  const r = native('start', ...BROWSER_FLAGS);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^zli daemon pid=/);
});

test('same output and exit codes as the node client', {skip}, () => {
  for (const args of [
    ['eval', '1 + 1'],
    ['pages'],
    ['help', 'click'],
    ['click'],
    ['click', 'nope'],
    ['frobnicate'],
    ['eval', '2', '+', 'eval', '3'],
  ]) {
    assert.deepEqual(native(...args), node(...args), args.join(' '));
  }
});

test('arguments survive quoting and non-ASCII text round-trips', {skip}, () => {
  const tricky = 'a "quoted" \\ back\\slash\\" naïve 日本語 🙂 end\\';
  const r = native('eval', `() => ${JSON.stringify(tricky)}`);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out), tricky);
});

test('large output arrives complete', {skip}, () => {
  const r = native('eval', '"x".repeat(300000)');
  assert.equal(r.out.length, 300002);
});
