// Parity: whatever tool catalogue chrome-devtools-mcp reports for a set of
// flags, cdt exposes exactly that catalogue, and can build a call for each.
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {parseCommand, usage} from '../src/args.js';
import {McpClient} from '../src/mcp.js';
import {makeCdt} from './helpers.mjs';

const BASE = ['--headless', '--isolated', '--no-usage-statistics'];
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
        tokens.push(`--${name}`, value);
        expected[name] = [items.type === 'object' ? JSON.parse(value) : coerced(items, value)];
      } else {
        const value = sample(def);
        tokens.push(`--${name}`, value);
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
