// Minimal MCP stdio client: just enough of the protocol to drive
// chrome-devtools-mcp (initialize, tools/list, tools/call, roots).
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const PROTOCOL_VERSION = '2025-06-18';

export function upstreamBin() {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('chrome-devtools-mcp/package.json');
  const pkg = require(pkgPath);
  return {
    script: path.join(path.dirname(pkgPath), pkg.bin['chrome-devtools-mcp']),
    version: pkg.version,
  };
}

export class McpClient {
  #child;
  #buf = '';
  #id = 0;
  #pending = new Map();
  #roots = new Set();
  #rootsWaiters = [];
  tools = [];
  serverInfo = {};
  onExit = () => {};
  log = () => {};

  async start(flags, roots) {
    for (const r of roots) this.#roots.add(r);
    const {script} = upstreamBin();
    this.#child = spawn(process.execPath, [script, ...flags], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', d => this.#onData(d));
    this.#child.stderr.on('data', d => this.log(String(d)));
    this.#child.on('exit', code => {
      const err = new Error(`chrome-devtools-mcp exited (code ${code})`);
      for (const p of this.#pending.values()) p.reject(err);
      this.#pending.clear();
      this.onExit(code);
    });
    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {roots: {listChanged: true}},
      clientInfo: {name: 'devtools-qai', version: '0.1.0'},
    });
    this.serverInfo = init.serverInfo ?? {};
    this.#notify('notifications/initialized');
    await this.refreshTools();
  }

  async refreshTools() {
    const tools = [];
    let cursor;
    do {
      const r = await this.request('tools/list', cursor ? {cursor} : {});
      tools.push(...r.tools);
      cursor = r.nextCursor;
    } while (cursor);
    this.tools = tools;
  }

  callTool(name, args) {
    return this.request('tools/call', {name, arguments: args});
  }

  // File tools are confined to the MCP roots. Each directory a command is run
  // from becomes a root, so relative paths behave like any other CLI.
  async addRoot(dir) {
    if (this.#roots.has(dir)) return;
    this.#roots.add(dir);
    const answered = new Promise(resolve => {
      this.#rootsWaiters.push(resolve);
      setTimeout(resolve, 1000);
    });
    this.#notify('notifications/roots/list_changed');
    await answered;
  }

  request(method, params) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, {resolve, reject});
      this.#send({jsonrpc: '2.0', id, method, params});
    });
  }

  close() {
    try {
      this.#child?.stdin.end();
    } catch {}
    const child = this.#child;
    return new Promise(resolve => {
      if (!child || child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #notify(method, params) {
    this.#send({jsonrpc: '2.0', method, params});
  }

  #send(msg) {
    this.#child.stdin.write(JSON.stringify(msg) + '\n');
  }

  #onData(chunk) {
    this.#buf += chunk;
    let nl;
    while ((nl = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.log(`unparseable line from server: ${line.slice(0, 200)}`);
        continue;
      }
      this.#onMessage(msg);
    }
  }

  #onMessage(msg) {
    if (msg.method) {
      if (msg.id === undefined) {
        if (msg.method === 'notifications/tools/list_changed') {
          this.refreshTools().catch(e => this.log(String(e)));
        }
        return;
      }
      // Server-to-client request.
      if (msg.method === 'roots/list') {
        const roots = [...this.#roots].map(dir => ({
          uri: pathToFileURL(dir).href,
          name: path.basename(dir) || dir,
        }));
        this.#send({jsonrpc: '2.0', id: msg.id, result: {roots}});
        // Let the server finish applying the roots before the next tool call.
        const waiters = this.#rootsWaiters.splice(0);
        setTimeout(() => waiters.forEach(w => w()), 20);
      } else if (msg.method === 'ping') {
        this.#send({jsonrpc: '2.0', id: msg.id, result: {}});
      } else {
        this.#send({
          jsonrpc: '2.0',
          id: msg.id,
          error: {code: -32601, message: `Method not found: ${msg.method}`},
        });
      }
      return;
    }
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error'));
    else p.resolve(msg.result);
  }
}
