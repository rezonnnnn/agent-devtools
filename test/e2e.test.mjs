// End-to-end: the real CLI, the real daemon, real Chrome, a local fixture page.
// Every tool in the default upstream catalogue is invoked at least once; the
// last test checks that claim against the catalogue itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, test} from 'node:test';
import {BROWSER_FLAGS, makeAdt, startFixture, uidOf} from './helpers.mjs';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-devtools-e2e-'));
const adt = makeAdt(`e2e-${process.pid}`, work);
let fixture;
const used = new Set();

// Records which upstream tool a command resolves to, then runs it.
function tool(name, ...args) {
  used.add(name);
  return adt.ok(name, ...args);
}
const outText = () => JSON.parse(adt.ok('eval', 'out.textContent'));
const snap = () => tool('take_snapshot');

before(async () => {
  fixture = await startFixture();
  adt.ok('start', ...BROWSER_FLAGS);
  used.add('navigate_page');
  adt.ok('open', fixture.url);
});

after(() => {
  adt('stop');
  fixture.close();
  fs.rmSync(work, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
});

test('snapshot: compact by default, verbatim with --raw', () => {
  const compact = snap();
  assert.match(compact, /^\S+ RootWebArea "Fixture"/);
  assert.match(compact, /heading "Fixture page"/);
  assert.doesNotMatch(compact, /uid=|## Latest page snapshot/);
  const raw = adt.ok('snap', '--raw');
  assert.match(raw, /^## Latest page snapshot\nuid=\S+ RootWebArea/);
  // Same nodes, same uids: compaction drops syntax, not information.
  const uids = text => [...text.matchAll(/^\s*(?:uid=)?(\d+_\d+)/gm)].map(m => m[1]);
  assert.deepEqual(uids(compact), uids(raw));
});

test('snapshot -i lists only interactive elements, flat', () => {
  const lines = adt.ok('snap', '-i').split('\n');
  assert.ok(lines.length >= 8);
  for (const line of lines) {
    assert.match(line, /^\d+_\d+ (button|textbox|checkbox|combobox|option|link) /);
  }
});

test('fill, click, wait_for', () => {
  const s = snap();
  tool('fill', uidOf(s, /textbox "Name"/), 'Ada');
  tool('click', uidOf(s, /checkbox "Agree"/));
  tool('fill', uidOf(s, /combobox "Color"/), 'blue');
  tool('click', uidOf(s, /button "Submit"/));
  assert.match(tool('wait_for', 'Hello Ada agreed blue'), /found/);
});

test('fill_form takes uid=value pairs', () => {
  const s = snap();
  tool(
    'fill_form',
    `${uidOf(s, /textbox "Name"/)}=Grace`,
    `${uidOf(s, /combobox "Color"/)}=red`,
  );
  adt.ok('click', uidOf(s, /button "Submit"/));
  assert.equal(outText(), 'Hello Grace agreed red');
});

test('type_text and press_key', () => {
  adt.ok('click', uidOf(snap(), /textbox "Keys"/));
  tool('type_text', 'abc');
  tool('press_key', 'Enter');
  assert.equal(outText(), 'enter abc');
});

test('hover and drag', () => {
  const s = snap();
  tool('hover', uidOf(s, /"hover me"/));
  assert.equal(outText(), 'hovered');
  tool('drag', uidOf(s, /"drag source"/), uidOf(s, /"drop target"/));
  assert.equal(outText(), 'dropped');
});

test('upload_file resolves paths against the caller cwd', () => {
  fs.writeFileSync(path.join(work, 'upload.txt'), 'hi');
  tool('upload_file', uidOf(snap(), /button "Upload"/), 'upload.txt');
  assert.equal(outText(), 'file upload.txt');
});

test('handle_dialog', () => {
  adt('click', uidOf(snap(), /button "Ask"/));
  tool('handle_dialog', 'dismiss');
  assert.equal(outText(), 'cancelled');
});

test('console and network inspection', () => {
  adt.ok('click', uidOf(snap(), /button "Load"/));
  adt.ok('wait', 'api 42');
  const messages = tool('list_console_messages');
  const msgid = /msgid=(\d+) .*clicked-log/.exec(messages)?.[1];
  assert.ok(msgid, messages);
  assert.match(tool('get_console_message', msgid), /clicked-log/);
  const requests = tool('list_network_requests');
  const reqid = /reqid=(\d+) GET \S+\/api\/data/.exec(requests)?.[1];
  assert.ok(reqid, requests);
  assert.match(tool('get_network_request', '--reqid', reqid), /"v":42|v":42/);
});

test('evaluate_script: expression, function, stdin, --json', () => {
  used.add('evaluate_script');
  assert.equal(adt.ok('eval', 'document.title'), '"Fixture"');
  assert.equal(adt.ok('eval', '() => [1, {a: 2}]'), '[1,{"a":2}]');
  assert.equal(adt.ok('eval', '-', {input: 'document.querySelectorAll("h1").length\n'}), '1');
  const raw = adt.ok('evaluate_script', '() => 7', '--raw');
  assert.match(raw, /Script ran on page and returned:\n```json\n7\n```/);
});

test('snapshot -d reports only what changed', () => {
  const s = snap();
  adt.ok('click', uidOf(s, /button "Add"/));
  const diff = adt.ok('snap', '-d');
  assert.match(diff, /^\+ \d+_\d+ button "Fresh"$/m);
  assert.ok(diff.split('\n').length <= 3, diff);
  assert.equal(adt.ok('snap', '-d'), '(no changes)');
});

test('screenshots land on disk, never in the output', () => {
  const auto = tool('take_screenshot');
  const file = /saved (.+\.png)$/m.exec(auto)?.[1];
  assert.ok(file && fs.statSync(file).size > 1000, auto);
  adt.ok('shot', '--filePath', 'page.jpeg', '--format', 'jpeg');
  assert.ok(fs.statSync(path.join(work, 'page.jpeg')).size > 1000);
});

test('get_css_styles', () => {
  assert.match(tool('get_css_styles', uidOf(snap(), /"hover me"/)), /background/);
});

test('emulate and resize_page', () => {
  assert.match(tool('emulate', '--colorScheme', 'dark'), /Emulating color scheme: dark/);
  // The engine repeats active emulation on every reply; only emulate shows it.
  assert.doesNotMatch(snap(), /Emulating/);
  assert.match(adt.ok('take_snapshot', '--raw'), /Emulating color scheme/);
  assert.equal(adt.ok('eval', 'matchMedia("(prefers-color-scheme: dark)").matches'), 'true');
  tool('emulate', '--colorScheme', 'auto');
  tool('resize_page', '800', '600');
  assert.equal(adt.ok('eval', 'innerWidth'), '800');
});

test('start keeps AGENT_DEVTOOLS_FLAGS and adds its own after them', () => {
  const q = makeAdt(`flags-${process.pid}`, work, {AGENT_DEVTOOLS_FLAGS: '--headless'});
  try {
    assert.match(q.ok('start', '--isolated'), /flags=\["--headless","--isolated"\]/);
  } finally {
    q('stop');
  }
});

test('pages: new, list, select, --page, close', () => {
  tool('new_page', fixture.url + '?second');
  const pages = tool('list_pages');
  const second = /^(\d+): .*\?second.*\[selected\]$/m.exec(pages)?.[1];
  assert.ok(second, pages);
  const first = /^(\d+): /m.exec(pages)[1];
  assert.match(adt.ok('eval', 'location.search'), /second/);
  assert.equal(adt.ok('eval', 'location.search', '--page', first), '""');
  tool('select_page', first);
  assert.equal(adt.ok('eval', 'location.search'), '""');
  tool('close_page', second);
  assert.doesNotMatch(adt.ok('pages'), /\?second/);
});

test('chains run in one invocation and stop at the first failure', () => {
  const s = snap();
  const out = adt.ok('click', uidOf(s, /button "Submit"/), '+', 'eval', 'out.textContent');
  assert.match(out, /clicked[\s\S]*"Hello /);
  const r = adt('eval', '1', '+', 'click', 'nope', '+', 'eval', '2');
  assert.equal(r.code, 1);
  assert.equal(r.out, '1');
  assert.match(r.err, /not found/);
});

test('usage errors exit 2 and say how to fix the call', () => {
  let r = adt('click');
  assert.equal(r.code, 2);
  assert.match(r.err, /missing uid\nusage: agent-devtools click <uid>/);
  r = adt('snap', '--bogus');
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown option --bogus \(options: --verbose --filePath\)/);
  r = adt('frobnicate');
  assert.equal(r.code, 2);
});

test('--max truncates and keeps the full text on disk', () => {
  const r = adt.ok('snap', '--max', '200');
  const file = /full output: (.+)\]$/.exec(r)?.[1];
  assert.ok(file, r);
  assert.ok(fs.readFileSync(file, 'utf8').length > 200);
});

test('performance trace and insight', () => {
  const started = tool('performance_start_trace', '--reload', '--autoStop');
  assert.match(started, /LCP|insight|trace/i);
  const m = /insightSetId[^\n]*?:\s*(\S+)/i.exec(started) ?? /id: (\S+)/.exec(started);
  const name = /insight name: (\w+)/i.exec(started)?.[1];
  if (m && name) {
    assert.ok(tool('performance_analyze_insight', m[1], name).length > 0);
  } else {
    used.add('performance_analyze_insight');
    const r = adt('performance_analyze_insight', 'nope', 'LCPBreakdown');
    assert.notEqual(r.code, 2, r.err);
  }
  tool('performance_start_trace', '--no-reload', '--no-autoStop');
  assert.ok(tool('performance_stop_trace').length > 0);
});

test('screencast start and stop', () => {
  tool('screencast_start', '--filePath', 'cast.mp4');
  adt.ok('eval', 'new Promise(r => setTimeout(r, 400))');
  tool('screencast_stop');
  assert.ok(fs.statSync(path.join(work, 'cast.mp4')).size > 0);
});

test('heap snapshot', () => {
  tool('take_heapsnapshot', 'heap.heapsnapshot');
  assert.ok(fs.statSync(path.join(work, 'heap.heapsnapshot')).size > 10_000);
});

test('lighthouse audit', () => {
  const report = tool('lighthouse_audit', '--mode', 'snapshot', '--outputDirPath', 'lh');
  assert.match(report, /accessibility/i);
});

test('every tool in the upstream catalogue was exercised above', () => {
  const catalogue = JSON.parse(adt.ok('tools')).map(t => t.name);
  assert.deepEqual(
    catalogue.filter(name => !used.has(name)),
    [],
  );
});

test('eval accepts expressions, functions, IIFEs and default parameters', () => {
  assert.equal(adt.ok('eval', '(() => document.title)()'), '"Fixture"');
  assert.equal(adt.ok('eval', '(a = 5) => a'), '5');
  assert.equal(adt.ok('eval', 'async () => (await fetch("/api/data")).json()'), '{"v":42}');
  const s = adt.ok('snap');
  assert.equal(adt.ok('eval', 'el => el.tagName', '--args', uidOf(s, /button "Submit"/)), '"BUTTON"');
});

test('page text cannot move the selected page', () => {
  const before = adt.ok('eval', 'location.href');
  adt.ok('eval', '"99: evil [selected]"');
  adt.ok('click', uidOf(adt.ok('snap'), /button "Load"/), '+', 'eval', 'console.log("98: evil [selected]")', '+', 'console');
  assert.equal(adt.ok('eval', 'location.href'), before);
});
