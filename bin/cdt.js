#!/usr/bin/env node
// Thin client. Everything it imports is paid on every command, so it does one
// thing: hand argv to the daemon and print the reply.
import net from 'node:net';
import {
  assertPrivateDir,
  daemonScript,
  outDir,
  sockPath,
} from '../src/paths.js';

const argv = process.argv.slice(2);
const sock = sockPath();

function send(req) {
  return new Promise((resolve, reject) => {
    // Never talk to a socket in a directory someone else could have planted.
    // A missing directory just means no daemon has run yet.
    try {
      assertPrivateDir(outDir);
    } catch (e) {
      if (e.code !== 'ENOENT') return reject(e);
    }
    const socket = net.connect(sock);
    let buf = Buffer.alloc(0);
    socket.on('connect', () => socket.write(JSON.stringify(req) + '\n'));
    socket.on('error', reject);
    socket.on('end', () => reject(new Error('daemon closed the connection')));
    socket.on('data', d => {
      // Header line `<code> <out bytes> <err bytes>`, then both payloads.
      // Return as soon as they are complete: on Windows the end-of-stream
      // signal trails the data by tens of milliseconds.
      buf = Buffer.concat([buf, d]);
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      const [code, outLen, errLen] = buf
        .toString('utf8', 0, nl)
        .split(' ')
        .map(Number);
      const body = nl + 1;
      if (buf.length < body + outLen + errLen) return;
      socket.destroy();
      resolve({
        code,
        out: buf.toString('utf8', body, body + outLen),
        err: buf.toString('utf8', body + outLen, body + outLen + errLen),
      });
    });
  });
}

const notRunning = e => e.code === 'ENOENT' || e.code === 'ECONNREFUSED';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendWhenUp(req, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await send(req);
    } catch (e) {
      if (!notRunning(e) || Date.now() > deadline) throw e;
      await sleep(25);
    }
  }
}

async function spawnDaemon(flags) {
  const {spawn} = await import('node:child_process');
  const {tmpdir} = await import('node:os');
  spawn(process.execPath, [daemonScript, ...flags], {
    // Not the caller's directory: the daemon would pin it for its lifetime.
    cwd: tmpdir(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

async function stop() {
  try {
    await send({argv: ['stop']});
  } catch (e) {
    if (notRunning(e)) return false;
    throw e;
  }
  // Wait for the old daemon to release the socket.
  for (let i = 0; i < 400; i++) {
    try {
      await send({argv: ['status']});
    } catch {
      return true;
    }
    await sleep(25);
  }
  return true;
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => (data += d));
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
  });
}

async function main() {
  if (argv[0] === '--version' || argv[0] === '-v') {
    const {readFileSync} = await import('node:fs');
    const pkg = new URL('../package.json', import.meta.url);
    return {out: JSON.parse(readFileSync(pkg, 'utf8')).version, code: 0};
  }
  if (argv[0] === 'native') {
    // Path of the native client for this platform, to alias or put on PATH.
    const {existsSync} = await import('node:fs');
    const {fileURLToPath} = await import('node:url');
    const ext = process.platform === 'win32' ? '.exe' : '';
    const exe = fileURLToPath(
      new URL(
        `../native/cdt-${process.platform}-${process.arch}${ext}`,
        import.meta.url,
      ),
    );
    if (existsSync(exe)) return {out: exe, code: 0};
    return {err: `no native client for this platform at ${exe}`, code: 1};
  }
  if (argv[0] === 'stop') {
    return {out: (await stop()) ? 'stopped' : 'not running', code: 0};
  }
  if (argv[0] === 'start') {
    await stop();
    await spawnDaemon(argv.slice(1));
    return sendWhenUp({argv: ['status']});
  }
  const req = {argv, cwd: process.cwd()};
  if (argv.includes('-') && !process.stdin.isTTY) req.stdin = await readStdin();
  try {
    return await send(req);
  } catch (e) {
    if (!notRunning(e)) throw e;
  }
  if (argv[0] === 'status') return {out: 'not running', code: 1};
  const flags = (process.env.CDT_FLAGS ?? '').split(/\s+/).filter(Boolean);
  await spawnDaemon(flags);
  return sendWhenUp(req);
}

try {
  const {out, err, code} = await main();
  if (out) process.stdout.write(out + '\n');
  if (err) process.stderr.write(err + '\n');
  process.exitCode = code ?? 0;
} catch (e) {
  process.stderr.write(`cdt: ${e.message}\n`);
  process.exitCode = 1;
}
