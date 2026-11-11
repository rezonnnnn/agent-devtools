#!/usr/bin/env node
// Long-lived process: owns the chrome-devtools-mcp server (and through it the
// browser) and answers one request per client connection.
//
// Wire format:
//   -> one JSON line: {argv: string[], cwd: string, stdin?: string}
//   <- header line `<exit code> <stdout bytes> <stderr bytes>`, then the two
//      UTF-8 payloads back to back. Trivial to read from any language.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  ALIASES,
  parseCommand,
  resolveCommand,
  splitChain,
  usage,
  UsageError,
} from './args.js';
import {formatResult} from './format.js';
import {McpClient, upstreamBin} from './mcp.js';
import {assertPrivateDir, outDir, sockPath} from './paths.js';

const userFlags = process.argv.slice(2);
const flags = [...userFlags];
// Opt out of upstream telemetry unless the user asked for it.
if (!flags.some(f => /^--(no-)?usage-?statistics/i.test(f))) {
  flags.push('--no-usage-statistics');
}

const sock = sockPath();
const startedAt = new Date();
fs.mkdirSync(outDir, {recursive: true, mode: 0o700});
assertPrivateDir(outDir);
const logStream = fs.createWriteStream(path.join(outDir, 'daemon.log'), {
  flags: 'a',
});
const log = msg => logStream.write(`${new Date().toISOString()} ${msg}\n`);

const mcp = new McpClient();
mcp.log = log;
let stopping = false;
mcp.onExit = code => {
  if (stopping) return;
  log(`upstream exited unexpectedly (code ${code})`);
  shutdown(1);
};

let currentPage;
const pageState = new Map();
const stateFor = pageId => {
  if (!pageState.has(pageId)) pageState.set(pageId, {});
  return pageState.get(pageId);
};

const resultText = result =>
  (result.content ?? [])
    .filter(p => p.type === 'text')
    .map(p => p.text)
    .join('\n');

// Only page-management tools print the page list. Text from anywhere else
// (console output, script results, page content) must not move the selection.
const PAGE_LIST_TOOLS = new Set([
  'list_pages',
  'select_page',
  'new_page',
  'close_page',
  'navigate_page',
]);

function trackSelectedPage(text) {
  const m = /^(\d+): .*\[selected\]$/m.exec(text);
  if (m) currentPage = Number(m[1]);
}

async function selectedPage() {
  if (currentPage === undefined) {
    trackSelectedPage(resultText(await mcp.callTool('list_pages', {})));
    currentPage ??= 1;
  }
  return currentPage;
}

async function runCommand(tokens, ctx) {
  const {tool, args, opts} = parseCommand(tokens, mcp.tools, ctx);
  let injected = false;
  if ('pageId' in (tool.inputSchema.properties ?? {}) && !('pageId' in args)) {
    args.pageId = opts.page ?? (await selectedPage());
    injected = opts.page === undefined;
  }
  const result = await mcp.callTool(tool.name, args);
  const text = resultText(result);
  if (result.isError) {
    // The page may be gone; look the selection up again next time.
    if (injected) currentPage = undefined;
    return {err: text, code: 1};
  }
  if (PAGE_LIST_TOOLS.has(tool.name)) trackSelectedPage(text);
  if (tool.name === 'close_page') pageState.delete(args.pageId);
  return {out: formatResult(result, opts, stateFor(args.pageId ?? 0)), code: 0};
}

function help(topic) {
  if (topic) {
    const {tool} = resolveCommand(topic, mcp.tools);
    const props = tool.inputSchema.properties ?? {};
    const lines = [`zli ${usage(tool)}`, tool.description];
    for (const [name, def] of Object.entries(props)) {
      if (name === 'pageId') continue;
      const type = def.enum ? def.enum.join('|') : def.type;
      lines.push(`  ${name} (${type}): ${def.description ?? ''}`);
    }
    return lines.join('\n');
  }
  const aliases = Object.entries(ALIASES)
    .filter(([, [tool]]) => mcp.tools.some(t => t.name === tool))
    .map(([alias, [tool, preset]]) => {
      const fixed = preset.type && preset.type !== 'url' ? ':' + preset.type : '';
      return `${alias}=${tool}${fixed}`;
    });
  return [
    'zli <command> [args] [--option value]    chain commands with +',
    '  e.g. zli open https://example.com + snap -i',
    'Required parameters are positional, in the order shown. Unique prefixes work.',
    'Options on any command: --page N (default: selected page), --raw (upstream',
    'text verbatim), --json, --max N (truncate to N chars). Snapshots: -i',
    'interactive elements only, -d changes since the last snapshot.',
    'A lone - reads that argument from stdin.',
    '',
    'Commands:',
    ...mcp.tools.map(t => '  ' + usage(t)),
    '',
    'Aliases: ' + aliases.join(' '),
    'Daemon: zli start [chrome-devtools-mcp flags] | zli stop | zli status',
    'Details: zli help <command>',
  ].join('\n');
}

async function handle(req) {
  const argv = req.argv ?? [];
  const cmd = argv[0];
  // Stopping must work even if the engine never came up.
  if (cmd === 'stop') {
    setImmediate(() => shutdown(0));
    return {out: 'stopped', code: 0};
  }
  if (stopping) return {err: 'zli daemon is stopping', code: 1};
  await ready;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    return {out: help(argv[1]), code: 0};
  }
  if (cmd === 'status') {
    return {
      out:
        `zli daemon pid=${process.pid} since=${startedAt.toISOString()} ` +
        `engine=chrome-devtools-mcp@${upstreamBin().version} ` +
        `tools=${mcp.tools.length} flags=${JSON.stringify(userFlags)}`,
      code: 0,
    };
  }
  if (cmd === 'tools') {
    return {out: JSON.stringify(mcp.tools), code: 0};
  }
  if (req.cwd) await mcp.addRoot(req.cwd);
  const outs = [];
  for (const tokens of splitChain(argv)) {
    if (tokens.at(-1) === '--help') {
      outs.push(help(tokens[0]));
      continue;
    }
    const r = await runCommand(tokens, {cwd: req.cwd, stdin: req.stdin});
    if (r.code !== 0) return {out: outs.join('\n'), err: r.err, code: r.code};
    if (r.out) outs.push(r.out);
  }
  return {out: outs.join('\n'), code: 0};
}

const server = net.createServer(socket => {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('error', e => log(`socket error: ${e.message}`));
  socket.on('data', async chunk => {
    buf += chunk;
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    const line = buf.slice(0, nl);
    buf = '';
    let reply;
    try {
      reply = await handle(JSON.parse(line));
    } catch (e) {
      if (!(e instanceof UsageError)) log(e.stack ?? String(e));
      reply = {err: e.message, code: e instanceof UsageError ? 2 : 1};
    }
    const out = Buffer.from(reply.out ?? '');
    const err = Buffer.from(reply.err ?? '');
    socket.end(
      Buffer.concat([
        Buffer.from(`${reply.code} ${out.length} ${err.length}\n`),
        out,
        err,
      ]),
    );
  });
});

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  // Close the browser before releasing the socket, so a `zli start` that
  // follows never races the old browser for its profile.
  await mcp.close();
  server.close();
  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(sock);
    } catch {}
  }
  process.exit(code);
}

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => shutdown(0));
}
process.on('uncaughtException', e => {
  log(`uncaught: ${e.stack ?? e}`);
  shutdown(1);
});

// A stale socket file blocks listen() on POSIX; remove it only if nothing
// answers on it.
if (process.platform !== 'win32' && fs.existsSync(sock)) {
  const alive = await new Promise(resolve => {
    const probe = net.connect(sock);
    probe.on('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.on('error', () => resolve(false));
  });
  if (alive) process.exit(0);
  fs.unlinkSync(sock);
}

server.on('error', e => {
  log(`listen failed: ${e.message}`);
  process.exit(1);
});

let ready;
server.listen(sock, () => {
  if (process.platform !== 'win32') fs.chmodSync(sock, 0o600);
  log(`listening on ${sock}, flags ${JSON.stringify(flags)}`);
});
ready = Promise.race([
  mcp.start(flags, [os.tmpdir()]),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error('no response within 60 s')), 60_000).unref(),
  ),
]).catch(e => {
  // Report the failure to whoever is waiting, then exit.
  setTimeout(() => shutdown(1), 200);
  throw new Error(`could not start chrome-devtools-mcp: ${e.message}`);
});
ready.catch(() => {});
