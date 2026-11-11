// Parity: whatever tool catalogue chrome-devtools-mcp reports for a set of
// flags, cdt exposes exactly that catalogue, and can build a call for each.
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {parseCommand, splitChain, usage} from '../src/args.js';
import {McpClient} from '../src/mcp.js';
import {BROWSER_FLAGS, makeCdt} from './helpers.mjs';

const BASE = [...BROWSER_FLAGS, '--no-usage-statistics'];
// Every opt-in category and experiment upstream documents.
const EVERYTHING = [
  ...BASE,
  '--categoryExtensions',
  '--categoryExperimentalThirdParty',
  '--categoryExperimentalWebmcp',
  '--categoryPwa',
  '--experimentalVision',
  '--experimentalDevtools',
  '--memoryDebugging',
];

async function upstreamCatalogue(flags) {
  const mcp = new McpClient();
  await mcp.start(flags, []);
  const tools = mcp.tools;
  await mcp.close();
  return tools;
}

const cdt = makeCdt(`parity-${process.pid}`);
after(() => cdt('stop'));

for (const [label, flags] of [
  ['default flags', BASE],
  ['all categories and experiments', EVERYTHING],
]) {
  test(`catalogue matches upstream: ${label}`, async () => {
    const upstream = await upstreamCatalogue(flags);
    cdt.ok('start', ...flags);
    const ours = JSON.parse(cdt.ok('tools'));
    assert.deepEqual(
      ours.map(t => t.name),
      upstream.map(t => t.name),
    );
    assert.deepEqual(ours, upstream);
    console.log(`  ${label}: ${ours.length} tools`);
    for (const t of ours) {
      assert.equal(cdt('help', t.name).code, 0, t.name);
    }
  });
}

test('every parameter of every tool is reachable from the command line', async () => {
  const tools = await upstreamCatalogue(EVERYTHING);
  const sample = def => {
    if (def.enum) return def.enum[0];
    if (def.type === 'number' || def.type === 'integer') return '3';
    if (def.type === 'boolean') return 'true';
    if (def.type === 'object') return '{"k":"v"}';
    return 'x';
  };
  let params = 0;
  for (const t of tools) {
    const props = t.inputSchema.properties ?? {};
    const tokens = [t.name];
    const expected = {};
    for (const [name, def] of Object.entries(props)) {
      if (def.type === 'array') {
        const items = def.items ?? {};
        const value =
          items.type === 'object'
            ? JSON.stringify(
                Object.fromEntries(
                  (items.required ?? Object.keys(items.properties ?? {})).map(
                    k => [k, 'x'],
                  ),
                ),
              )
            : sample(items);
        tokens.push(`--${name}=${value}`);
        expected[name] = [items.type === 'object' ? JSON.parse(value) : coerced(items, value)];
      } else {
        const value = sample(def);
        tokens.push(`--${name}=${value}`);
        expected[name] = coerced(def, value);
      }
      params++;
    }
    const {tool, args} = parseCommand(tokens, tools);
    assert.equal(tool.name, t.name);
    assert.deepEqual(args, expected, `${t.name}: ${usage(t)}`);
  }
  console.log(`  ${tools.length} tools, ${params} parameters`);
});

function coerced(def, value) {
  if (def.type === 'number' || def.type === 'integer') return Number(value);
  if (def.type === 'boolean') return value === 'true';
  if (def.type === 'object') return JSON.parse(value);
  return value;
}

test('argument edge cases', async () => {
  const tools = await upstreamCatalogue(BASE);
  const parse = (...tokens) => parseCommand(tokens, tools).args;
  // A boolean flag never swallows the word after it.
  assert.deepEqual(parse('click', '--dblClick', 'true'), {dblClick: true, uid: 'true'});
  assert.deepEqual(parse('click', 'u1', '--no-dblClick'), {dblClick: false, uid: 'u1'});
  assert.deepEqual(parse('click', 'u1', '--dblClick=false'), {dblClick: false, uid: 'u1'});
  assert.throws(() => parse('click', 'u1', '--no-dblClick=maybe'), /takes no value/);
  // `--` ends option parsing and chaining, so any literal can be passed.
  assert.deepEqual(splitChain(['press_key', '--', '+']), [['press_key', '--', '+']]);
  assert.deepEqual(parse('press_key', '--', '+'), {key: '+'});
  assert.deepEqual(parse('type_text', '--', '-d'), {text: '-d'});
  assert.deepEqual(splitChain(['a', '1', '+', 'b']), [['a', '1'], ['b']]);
  // Arrays: repeated values, one JSON list, or a literal that only looks like JSON.
  assert.deepEqual(parse('wait_for', 'a', 'b'), {text: ['a', 'b']});
  assert.deepEqual(parse('wait_for', '["a","b"]'), {text: ['a', 'b']});
  assert.deepEqual(parse('wait_for', '[draft] saved'), {text: ['[draft] saved']});
  // Only file parameters are resolved against the working directory.
  const {args} = parseCommand(['take_screenshot', '--filePath', 'a.png', '--uid', 'path'], tools, {cwd: process.cwd()});
  assert.ok(args.filePath.endsWith('a.png') && args.filePath !== 'a.png');
  assert.equal(args.uid, 'path');
});
