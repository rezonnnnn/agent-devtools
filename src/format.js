// Presentation layer: turns MCP tool results into the smallest text that still
// carries the same information. `--raw` bypasses all of it.
import fs from 'node:fs';
import path from 'node:path';
import {outDir} from './paths.js';

const SNAPSHOT_LINE = /^(\s*)uid=(\S+)(.*)$/;
const SCRIPT_RESULT =
  /^Script ran on page and returned:\n```json\n([\s\S]*?)\n```/;

// Roles an agent can act on. Used by `snap -i`.
const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
]);

const EXT = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'};

function saveBinary(part) {
  fs.mkdirSync(outDir, {recursive: true});
  const ext = EXT[part.mimeType] ?? 'bin';
  const file = path.join(
    outDir,
    `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`,
  );
  fs.writeFileSync(file, Buffer.from(part.data, 'base64'));
  return file;
}

const isInteractive = n => INTERACTIVE.has(n.rest.trim().split(' ')[0]);
const flat = n => `${n.uid}${n.rest}`;

function diffLines(nodes, prev, next, opts) {
  const out = [];
  for (const n of nodes) {
    const old = prev.get(n.uid);
    if (!old) out.push(`+ ${flat(n)}`);
    else if (old.rest !== n.rest) out.push(`~ ${flat(n)}`);
  }
  for (const [uid, old] of prev) {
    if (next.has(uid)) continue;
    if (!opts.interactive || isInteractive(old)) out.push(`- ${flat(old)}`);
  }
  return out.length ? out : ['(no changes)'];
}

function compact(text, opts, state) {
  // `Script ran on page and returned:` + fenced JSON -> the JSON itself.
  text = text.replace(SCRIPT_RESULT, '$1');
  // Snapshot lines become nodes; every other line passes through in place, so
  // a snapshot embedded in another tool's reply (--includeSnapshot) gets the
  // same treatment.
  const parsed = text
    .split('\n')
    .filter(l => l !== '## Latest page snapshot' && l !== '## Pages')
    .map(line => {
      const m = SNAPSHOT_LINE.exec(line);
      return m ? {depth: m[1].length / 2, uid: m[2], rest: m[3]} : line;
    });
  const nodes = parsed.filter(x => typeof x !== 'string');
  if (!nodes.length) return parsed.join('\n');

  // The diff baseline is always the full tree, whatever view is printed.
  const prev = state.lastSnapshot ?? new Map();
  state.lastSnapshot = new Map(nodes.map(n => [n.uid, n]));
  const shown = n => !opts.interactive || isInteractive(n);
  const out = [];
  let diffPrinted = false;
  for (const x of parsed) {
    if (typeof x === 'string') out.push(x);
    else if (opts.diff) {
      if (diffPrinted) continue;
      out.push(...diffLines(nodes.filter(shown), prev, state.lastSnapshot, opts));
      diffPrinted = true;
    } else if (shown(x)) {
      out.push(opts.interactive ? flat(x) : ' '.repeat(x.depth) + flat(x));
    }
  }
  return out.join('\n');
}

// state: per-page object owned by the daemon ({lastSnapshot}).
export function formatResult(result, opts, state) {
  if (opts.json) {
    return JSON.stringify(result.structuredContent ?? result.content);
  }
  const parts = [];
  for (const part of result.content ?? []) {
    if (part.type === 'text') {
      parts.push(opts.raw ? part.text : compact(part.text, opts, state));
    } else if (part.data) {
      parts.push(`saved ${saveBinary(part)}`);
    }
  }
  let text = parts.join('\n').trimEnd();
  if (opts.max && text.length > opts.max) {
    fs.mkdirSync(outDir, {recursive: true});
    const file = path.join(outDir, `${Date.now()}-full.txt`);
    fs.writeFileSync(file, text);
    text =
      text.slice(0, opts.max) +
      `\n[truncated ${text.length - opts.max} chars; full output: ${file}]`;
  }
  return text;
}
