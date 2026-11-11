// Benchmark: the same browser steps through four interfaces.
//
//   agent-devtools        this project
//   official   the `chrome-devtools` CLI shipped inside chrome-devtools-mcp
//   mcp        chrome-devtools-mcp over a persistent MCP stdio connection
//   ab         agent-browser (native binary, called directly)
//
// Usage: node bench/run.mjs [--runs 15]
// Writes bench/results.json and bench/RESULTS.md. All pages are served
// locally, so the numbers are reproducible and no network is involved.
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {encode} from 'gpt-tokenizer';
import {McpClient} from '../src/mcp.js';

const require = createRequire(import.meta.url);
const root = path.join(import.meta.dirname, '..');
const RUNS = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 15;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-devtools-bench-'));
const tokens = text => encode(text).length;
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const upstreamDir = path.dirname(require.resolve('chrome-devtools-mcp/package.json'));
const abDir = path.dirname(require.resolve('agent-browser/package.json'));
const abExe = path.join(
  abDir,
  'bin',
  `agent-browser-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`,
);
const FLAGS = ['--headless', '--isolated', '--no-usage-statistics'];
const TARGET = 'Save product 1'; // a button with no handler: clicking is repeatable

function exec(cmd, args, env = {}) {
  const t = performance.now();
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: tmp,
    env: {...process.env, ...env},
    timeout: 120_000,
  });
  const ms = performance.now() - t;
  if (r.status !== 0) {
    throw new Error(`${path.basename(cmd)} ${args.join(' ')} -> ${r.status}\n${r.stdout}\n${r.stderr}`);
  }
  return {ms, out: r.stdout.trimEnd()};
}

// Each driver maps the abstract steps onto its own syntax.
function cliDriver({name, cmd, pre = [], env, steps, start, stop, uid}) {
  const run = args => exec(cmd, [...pre, ...args], env);
  return {
    name,
    start: () => start && run(start),
    stop: () => {
      try {
        run(stop);
      } catch {}
    },
    step: (step, arg) => run(steps[step](arg)),
    many: list => {
      // One invocation per command.
      let ms = 0;
      const outs = [];
      for (const args of list) {
        const r = run(args);
        ms += r.ms;
        outs.push(r.out);
      }
      return {ms, out: outs.join('\n'), calls: list.length};
    },
    run,
    uid,
  };
}

const adtEnv = {AGENT_DEVTOOLS_SESSION: `bench-${process.pid}`};
const nativeExe = path.join(
  root,
  'native',
  `agent-devtools-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`,
);
const adtDriver = (name, cmd, pre) => cliDriver({
  name,
  cmd,
  pre,
  env: adtEnv,
  start: ['start', ...FLAGS],
  stop: ['stop'],
  steps: {
    open: url => ['open', url],
    snapshot: () => ['snap'],
    interactive: () => ['snap', '-i'],
    eval: () => ['eval', 'document.title'],
    click: uid => ['click', uid],
    screenshot: file => ['shot', '--filePath', file],
  },
  uid: (snapshot, label) => new RegExp(`^\\s*(\\S+) \\w+ "${label}"`, 'm').exec(snapshot)[1],
});
// agent-devtools = the native client, adtNode = bin/agent-devtools.js. Same daemon behind both.
const adt = adtDriver('agent-devtools', nativeExe, []);
const adtNode = adtDriver('adtNode', process.execPath, [path.join(root, 'bin', 'agent-devtools.js')]);

const official = cliDriver({
  name: 'official',
  cmd: process.execPath,
  pre: [path.join(upstreamDir, 'build/src/bin/chrome-devtools.js')],
  start: ['start', ...FLAGS],
  stop: ['stop'],
  steps: {
    open: url => ['navigate_page', '1', '--type', 'url', '--url', url],
    snapshot: () => ['take_snapshot', '1'],
    interactive: () => ['take_snapshot', '1'], // no filter available
    eval: () => ['evaluate_script', '() => document.title', '--pageId', '1'],
    click: uid => ['click', '1', uid],
    screenshot: file => ['take_screenshot', '1', '--filePath', file],
  },
  uid: (snapshot, label) => new RegExp(`uid=(\\S+) \\w+ "${label}"`).exec(snapshot)[1],
});

const ab = cliDriver({
  name: 'ab',
  cmd: abExe,
  env: {AGENT_BROWSER_SESSION: `adtbench${process.pid}`},
  stop: ['close'],
  steps: {
    open: url => ['open', url],
    snapshot: () => ['snapshot'],
    interactive: () => ['snapshot', '-i'],
    eval: () => ['eval', 'document.title'],
    click: ref => ['click', '@' + ref],
    screenshot: file => ['screenshot', file],
  },
  uid: (snapshot, label) => new RegExp(`"${label}" \\[[^\\]]*ref=(\\w+)\\]`).exec(snapshot)[1],
});

// MCP: one long-lived connection, as an MCP client holds it. Output is the
// text content the model receives.
function mcpDriver() {
  let client;
  const call = async (name, args) => {
    const t = performance.now();
    const r = await client.callTool(name, args);
    const ms = performance.now() - t;
    const out = (r.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
    if (r.isError) throw new Error(`mcp ${name}: ${out}`);
    return {ms, out};
  };
  const steps = {
    open: url => ['navigate_page', {pageId: 1, type: 'url', url}],
    snapshot: () => ['take_snapshot', {pageId: 1}],
    interactive: () => ['take_snapshot', {pageId: 1}],
    eval: () => ['evaluate_script', {pageId: 1, function: '() => document.title'}],
    click: uid => ['click', {pageId: 1, uid}],
    screenshot: file => ['take_screenshot', {pageId: 1, filePath: file}],
  };
  return {
    name: 'mcp',
    start: async () => {
      client = new McpClient();
      await client.start(FLAGS, [tmp]);
    },
    stop: () => client?.close(),
    step: (step, arg) => call(...steps[step](arg)),
    many: async list => {
      let ms = 0;
      const outs = [];
      for (const [name, args] of list) {
        const r = await call(name, args);
        ms += r.ms;
        outs.push(r.out);
      }
      return {ms, out: outs.join('\n'), calls: list.length};
    },
    tools: () => client.tools,
    uid: official.uid,
  };
}
const mcp = mcpDriver();

function startFixture() {
  const child = spawn(process.execPath, [path.join(root, 'test/fixture/server.mjs')], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise(resolve => {
    child.stdout.once('data', d => resolve({url: String(d).trim(), close: () => child.kill()}));
  });
}

// The form task, written the most compact way each interface allows.
const FORM_DONE = 'Hello Ada agreed blue';
const adtForm = d => async url => {
    const look = d.run(['open', url, '+', 'snap', '-i']);
    const u = l => d.uid(look.out, l);
    const act = d.run([
      'fill_form', `${u('Name')}=Ada`, `${u('Color')}=blue`,
      '+', 'click', u('Agree'),
      '+', 'click', u('Submit'),
      '+', 'eval', 'out.textContent',
    ]);
    return {ms: look.ms + act.ms, out: look.out + '\n' + act.out, calls: 2};
};
const formTask = {
  'agent-devtools': adtForm(adt),
  adtNode: adtForm(adtNode),
  async official(url) {
    const look = official.many([
      ['navigate_page', '1', '--type', 'url', '--url', url],
      ['take_snapshot', '1'],
    ]);
    const u = l => official.uid(look.out, l);
    const act = official.many([
      ['fill', '1', u('Name'), 'Ada'],
      ['fill', '1', u('Color'), 'blue'],
      ['click', '1', u('Agree')],
      ['click', '1', u('Submit')],
      ['evaluate_script', '() => out.textContent', '--pageId', '1'],
    ]);
    return {ms: look.ms + act.ms, out: look.out + '\n' + act.out, calls: look.calls + act.calls};
  },
  async mcp(url) {
    const look = await mcp.many([
      ['navigate_page', {pageId: 1, type: 'url', url}],
      ['take_snapshot', {pageId: 1}],
    ]);
    const u = l => mcp.uid(look.out, l);
    const act = await mcp.many([
      ['fill_form', {pageId: 1, elements: [{uid: u('Name'), value: 'Ada'}, {uid: u('Color'), value: 'blue'}]}],
      ['click', {pageId: 1, uid: u('Agree')}],
      ['click', {pageId: 1, uid: u('Submit')}],
      ['evaluate_script', {pageId: 1, function: '() => out.textContent'}],
    ]);
    return {ms: look.ms + act.ms, out: look.out + '\n' + act.out, calls: look.calls + act.calls};
  },
  async ab(url) {
    const look = ab.run(['batch', '--bail', `open ${url}`, 'snapshot -i']);
    const u = l => '@' + ab.uid(look.out, l);
    const act = ab.run([
      'batch', '--bail',
      `fill ${u('Name')} Ada`,
      `select ${u('Color')} blue`,
      `check ${u('Agree')}`,
      `click ${u('Submit')}`,
      'get text #out',
    ]);
    return {ms: look.ms + act.ms, out: look.out + '\n' + act.out, calls: 2};
  },
};

const drivers = [adt, adtNode, official, mcp, ab];
const results = {
  date: new Date().toISOString(),
  machine: `${os.cpus()[0].model.trim()}, ${os.platform()} ${os.release()}, Node ${process.version}`,
  runs: RUNS,
  versions: {
    'agent-devtools': require('../package.json').version,
    'chrome-devtools-mcp': require('chrome-devtools-mcp/package.json').version,
    'agent-browser': require('agent-browser/package.json').version,
  },
  tokenizer: 'o200k_base (gpt-tokenizer)',
  cold: {},
  warm: {},
  snapshot: {},
  form: {},
  context: {},
};

const fixture = await startFixture();
const shop = fixture.url + 'shop';
try {
  for (const d of drivers) {
    process.stderr.write(`\n[${d.name}] `);
    // Cold: nothing running -> first page loaded.
    d.stop && (await d.stop());
    let t = performance.now();
    await d.start();
    await d.step('open', shop);
    results.cold[d.name] = performance.now() - t;

    // Warm latency, median of RUNS.
    const snapshot = (await d.step('snapshot')).out;
    const target = d.uid(snapshot, TARGET);
    const warm = {};
    for (const [step, arg] of [
      ['snapshot'],
      ['interactive'],
      ['eval'],
      ['click', target],
      ['screenshot', path.join(tmp, `${d.name}.png`)],
      ['open', shop],
    ]) {
      const times = [];
      for (let i = 0; i < RUNS; i++) times.push((await d.step(step, arg)).ms);
      warm[step] = median(times);
      process.stderr.write(`${step} `);
    }
    results.warm[d.name] = warm;

    // What one look at the page costs in context.
    const full = (await d.step('snapshot')).out;
    const inter = (await d.step('interactive')).out;
    results.snapshot[d.name] = {
      full: {chars: full.length, tokens: tokens(full)},
      interactive: {chars: inter.length, tokens: tokens(inter)},
    };

    // The form task end to end.
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const r = await formTask[d.name](fixture.url);
      if (!r.out.includes(FORM_DONE)) throw new Error(`${d.name} form task failed:\n${r.out}`);
      runs.push(r);
    }
    results.form[d.name] = {
      ms: median(runs.map(r => r.ms)),
      calls: runs[0].calls,
      tokens: tokens(runs[0].out),
    };
    process.stderr.write('form ');

    if (d.name === 'mcp') {
      const schema = JSON.stringify(d.tools());
      results.context.mcp = {what: 'tool definitions, loaded into every session', tokens: tokens(schema), chars: schema.length};
    }
    if (d.name === 'agent-devtools') {
      const help = adt.run(['help']).out;
      const skill = fs.readFileSync(path.join(root, 'skills/agent-devtools/SKILL.md'), 'utf8');
      results.context['agent-devtools'] = {what: 'skills/agent-devtools/SKILL.md', tokens: tokens(skill), chars: skill.length};
      results.context['agent-devtools help'] = {what: '`agent-devtools help`, on demand', tokens: tokens(help), chars: help.length};
    }
    await d.stop();
  }
  const officialSkill = fs.readFileSync(path.join(upstreamDir, 'skills/chrome-devtools-cli/SKILL.md'), 'utf8');
  results.context.official = {what: 'skills/chrome-devtools-cli/SKILL.md', tokens: tokens(officialSkill), chars: officialSkill.length};
  const abSkill = exec(abExe, ['skills', 'get', 'core']).out;
  results.context.ab = {what: '`agent-browser skills get core`', tokens: tokens(abSkill), chars: abSkill.length};
} finally {
  for (const d of drivers) {
    try {
      await d.stop();
    } catch {}
  }
  fixture.close();
}

fs.writeFileSync(path.join(import.meta.dirname, 'results.json'), JSON.stringify(results, null, 2) + '\n');

// ---- report ----
const names = {'agent-devtools': 'agent-devtools', adtNode: 'agent-devtools (Node client)', official: 'official CLI', mcp: 'MCP server', ab: 'agent-browser'};
const order = ['agent-devtools', 'adtNode', 'official', 'mcp', 'ab'];
const ms = v => `${Math.round(v)} ms`;
const row = cells => `| ${cells.join(' | ')} |`;
const head = cols => [row(cols), row(cols.map((_, i) => (i ? '--:' : '---')))];
const stepLabel = {
  snapshot: 'snapshot',
  interactive: 'snapshot, interactive only',
  eval: 'evaluate script',
  click: 'click',
  screenshot: 'screenshot to file',
  open: 'navigate',
};
const md = [
  '# Benchmark results',
  '',
  `Generated by \`npm run bench\` on ${results.date.slice(0, 10)}. ${results.machine}.`,
  `agent-devtools ${results.versions['agent-devtools']}, chrome-devtools-mcp ${results.versions['chrome-devtools-mcp']}, agent-browser ${results.versions['agent-browser']}. Tokens: ${results.tokenizer}.`,
  '',
  `## Warm latency per command (median of ${RUNS})`,
  '',
  ...head(['step', ...order.map(n => names[n])]),
  ...Object.keys(stepLabel).map(s => row([stepLabel[s], ...order.map(n => ms(results.warm[n][s]))])),
  '',
  '## Cold start (nothing running to first page loaded)',
  '',
  ...head(['', ...order.map(n => names[n])]),
  row(['cold start', ...order.map(n => ms(results.cold[n]))]),
  '',
  '## Tokens for one look at a content-heavy page',
  '',
  ...head(['view', ...order.map(n => names[n])]),
  row(['full snapshot', ...order.map(n => results.snapshot[n].full.tokens)]),
  row(['interactive only', ...order.map(n => results.snapshot[n].interactive.tokens)]),
  '',
  '## Form task (open, read, fill two fields, tick a box, submit, verify)',
  '',
  ...head(['', ...order.map(n => names[n])]),
  row(['invocations', ...order.map(n => results.form[n].calls)]),
  row(['wall time', ...order.map(n => ms(results.form[n].ms))]),
  row(['output tokens', ...order.map(n => results.form[n].tokens)]),
  '',
  '## Fixed context cost',
  '',
  ...head(['interface', 'what the agent loads', 'tokens']),
  ...['agent-devtools', 'agent-devtools help', 'official', 'mcp', 'ab'].map(n => row([names[n] ?? n, results.context[n].what, results.context[n].tokens])),
  '',
].join('\n');
fs.writeFileSync(path.join(import.meta.dirname, 'RESULTS.md'), md);
console.log(md);
fs.rmSync(tmp, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
