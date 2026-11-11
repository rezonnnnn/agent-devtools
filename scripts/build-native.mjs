// Cross-compiles native/zli.c for every supported platform with `zig cc`.
// Usage: node scripts/build-native.mjs [--host]   (--host: this platform only)
// Zig is found on PATH or through the ZIG environment variable.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const zig = process.env.ZIG || 'zig';

// Node's `${process.platform}-${process.arch}` -> zig target
const TARGETS = {
  'win32-x64': 'x86_64-windows-gnu',
  'win32-arm64': 'aarch64-windows-gnu',
  'linux-x64': 'x86_64-linux-musl',
  'linux-arm64': 'aarch64-linux-musl',
  'darwin-x64': 'x86_64-macos',
  'darwin-arm64': 'aarch64-macos',
};

const host = `${process.platform}-${process.arch}`;
const wanted = process.argv.includes('--host') ? [host] : Object.keys(TARGETS);

for (const name of wanted) {
  const target = TARGETS[name];
  if (!target) throw new Error(`unsupported platform ${name}`);
  const out = path.join(
    root,
    'native',
    `zli-${name}${name.startsWith('win32') ? '.exe' : ''}`,
  );
  const args = ['cc', '-target', target, '-O2', '-s', '-o', out];
  if (name.startsWith('win32')) args.push('-municode');
  args.push(path.join(root, 'native', 'zli.c'));
  const r = spawnSync(zig, args, {stdio: 'inherit'});
  if (r.status !== 0) process.exit(r.status ?? 1);
  if (out.endsWith('.exe')) {
    // Linker by-products.
    fs.rmSync(out.replace(/\.exe$/, '.pdb'), {force: true});
    fs.rmSync(out.replace(/\.exe$/, '.lib'), {force: true});
  }
  console.log(`${name}: ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}
