// Turns `zli <command> ...` tokens into an MCP tool call, driven entirely by
// the tool schemas the server reports. No tool is hard-coded here except the
// short aliases, so new upstream tools work without a release.
import path from 'node:path';

// alias -> [tool, preset arguments]
export const ALIASES = {
  open: ['navigate_page', {type: 'url'}],
  nav: ['navigate_page', {type: 'url'}],
  goto: ['navigate_page', {type: 'url'}],
  back: ['navigate_page', {type: 'back'}],
  forward: ['navigate_page', {type: 'forward'}],
  reload: ['navigate_page', {type: 'reload'}],
  snap: ['take_snapshot', {}],
  shot: ['take_screenshot', {}],
  // Reads a value, so it skips the engine's wait for the DOM to settle.
  // `evaluate_script` keeps the upstream default for scripts that mutate.
  eval: ['evaluate_script', {waitForStableDom: false}],
  js: ['evaluate_script', {waitForStableDom: false}],
  pages: ['list_pages', {}],
  page: ['select_page', {}],
  new: ['new_page', {}],
  close: ['close_page', {}],
  key: ['press_key', {}],
  press: ['press_key', {}],
  type: ['type_text', {}],
  wait: ['wait_for', {}],
  console: ['list_console_messages', {}],
  msg: ['get_console_message', {}],
  net: ['list_network_requests', {}],
  req: ['get_network_request', {}],
  dialog: ['handle_dialog', {}],
  resize: ['resize_page', {}],
};

// Options handled by zli itself. A tool parameter with the same name wins.
const OWN_OPTS = {
  raw: 'boolean',
  json: 'boolean',
  interactive: 'boolean',
  diff: 'boolean',
  page: 'number',
  max: 'number',
};
const SHORT = {'-i': 'interactive', '-d': 'diff'};

const norm = s => s.replace(/[-_]/g, '').toLowerCase();

export class UsageError extends Error {}

export function resolveCommand(name, tools) {
  const byName = new Map(tools.map(t => [t.name, t]));
  const snake = name.replace(/-/g, '_');
  if (byName.has(snake)) return {tool: byName.get(snake), preset: {}};
  const alias = ALIASES[name];
  if (alias && byName.has(alias[0])) {
    return {tool: byName.get(alias[0]), preset: {...alias[1]}};
  }
  const matches = tools.filter(t => t.name.startsWith(snake));
  if (matches.length === 1) return {tool: matches[0], preset: {}};
  const hint = matches.length
    ? `ambiguous: ${matches.map(t => t.name).join(', ')}`
    : 'run `zli help` for the command list';
  throw new UsageError(`unknown command "${name}" (${hint})`);
}

// For these two the page is the subject of the command: `zli page 2`.
const PAGE_IS_ARG = new Set(['select_page', 'close_page']);
const hidesPageId = tool => !PAGE_IS_ARG.has(tool.name);

// Positional order: required parameters first, then the rest, as declared.
// Elsewhere pageId is not positional: it defaults to the selected page
// (--page N overrides).
function positionalOrder(tool) {
  const props = Object.keys(tool.inputSchema.properties ?? {});
  const required = tool.inputSchema.required ?? [];
  return [
    ...required,
    ...props.filter(p => !required.includes(p)),
  ].filter(p => p !== 'pageId' || !hidesPageId(tool));
}

export function usage(tool) {
  const props = tool.inputSchema.properties ?? {};
  const required = (tool.inputSchema.required ?? []).filter(
    p => p !== 'pageId',
  );
  const parts = [tool.name];
  if (!hidesPageId(tool)) parts.push('[pageId]');
  for (const p of required) {
    parts.push(props[p].type === 'array' ? `<${p}...>` : `<${p}>`);
  }
  const optional = Object.keys(props).filter(
    p => p !== 'pageId' && !required.includes(p),
  );
  if (optional.length) parts.push(`[${optional.map(p => '--' + p).join(' ')}]`);
  return parts.join(' ');
}

function coerce(value, def, name) {
  const type = def.type;
  if (type === 'number' || type === 'integer') {
    const n = Number(value);
    if (value === '' || Number.isNaN(n)) {
      throw new UsageError(`${name}: expected a number, got "${value}"`);
    }
    return n;
  }
  if (type === 'boolean') {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    throw new UsageError(`${name}: expected true or false, got "${value}"`);
  }
  if (type === 'object') return parseJson(value, name);
  return value;
}

function parseJson(value, name) {
  try {
    return JSON.parse(value);
  } catch {
    throw new UsageError(`${name}: expected JSON, got "${value}"`);
  }
}

// One array element. Object items accept JSON or `a=b`, mapped onto the item's
// required properties in order (fill_form: `1_4=alice 1_5=secret`).
function coerceItem(value, def, name) {
  const items = def.items ?? {};
  if (items.type !== 'object') return coerce(value, items, name);
  if (value.trimStart().startsWith('{')) return parseJson(value, name);
  const keys = items.required ?? Object.keys(items.properties ?? {});
  const eq = value.indexOf('=');
  if (keys.length !== 2 || eq < 0) {
    throw new UsageError(`${name}: expected JSON or ${keys.join('=')}`);
  }
  return {[keys[0]]: value.slice(0, eq), [keys[1]]: value.slice(eq + 1)};
}

// A value that is a JSON array supplies the whole list; anything else is one
// element.
function addArrayValue(args, name, value, def) {
  const list = (args[name] ??= []);
  if (value.trimStart().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return void list.push(...parsed);
    } catch {}
  }
  list.push(coerceItem(value, def, name));
}

export function parseCommand(tokens, tools, {cwd, stdin} = {}) {
  const [name, ...rest] = tokens;
  const {tool, preset} = resolveCommand(name, tools);
  const props = tool.inputSchema.properties ?? {};
  const propByNorm = new Map(Object.keys(props).map(p => [norm(p), p]));
  const args = {...preset};
  const opts = {};
  const positionals = [];
  const text = v => (v === '-' && stdin !== undefined ? stdin : v);

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--') {
      positionals.push(...rest.slice(i + 1).map(text));
      break;
    }
    if (SHORT[tok] && !propByNorm.has(SHORT[tok])) {
      opts[SHORT[tok]] = true;
      continue;
    }
    if (!tok.startsWith('--')) {
      positionals.push(text(tok));
      continue;
    }
    const eq = tok.indexOf('=');
    let flag = eq < 0 ? tok.slice(2) : tok.slice(2, eq);
    let inline = eq < 0 ? undefined : tok.slice(eq + 1);
    let prop = propByNorm.get(norm(flag));
    let negated = false;
    if (!prop && flag.startsWith('no-') && propByNorm.has(norm(flag.slice(3)))) {
      prop = propByNorm.get(norm(flag.slice(3)));
      negated = true;
    }
    const own = !prop && OWN_OPTS[norm(flag)] ? norm(flag) : undefined;
    if (!prop && !own) {
      const valid = Object.keys(props)
        .filter(p => p !== 'pageId')
        .map(p => '--' + p);
      throw new UsageError(
        `${tool.name}: unknown option --${flag}` +
          (valid.length ? ` (options: ${valid.join(' ')})` : ''),
      );
    }
    const type = prop ? props[prop].type : OWN_OPTS[own];
    let value;
    if (type === 'boolean') {
      // --flag, --no-flag or --flag=false. A following word is never
      // consumed: it may be a positional argument.
      value = inline ?? 'true';
      if (negated) {
        if (inline !== undefined) {
          throw new UsageError(`${tool.name}: --${flag} takes no value`);
        }
        value = 'false';
      }
    } else {
      value = inline ?? rest[++i];
      if (value === undefined) {
        throw new UsageError(`${tool.name}: --${flag} needs a value`);
      }
      value = text(value);
    }
    if (own) opts[own] = coerce(value, {type}, flag);
    else if (type === 'array') addArrayValue(args, prop, value, props[prop]);
    else args[prop] = coerce(value, props[prop], prop);
  }

  const queue = [...positionals];
  for (const p of positionalOrder(tool)) {
    if (!queue.length) break;
    if (p in args) continue;
    if (props[p].type === 'array') {
      while (queue.length) addArrayValue(args, p, queue.shift(), props[p]);
    } else {
      args[p] = coerce(queue.shift(), props[p], p);
    }
  }
  if (queue.length) {
    throw new UsageError(
      `${tool.name}: unexpected argument "${queue[0]}"\nusage: zli ${usage(tool)}`,
    );
  }
  const missing = (tool.inputSchema.required ?? []).filter(
    p => p !== 'pageId' && !(p in args),
  );
  if (missing.length) {
    throw new UsageError(
      `${tool.name}: missing ${missing.join(', ')}\nusage: zli ${usage(tool)}`,
    );
  }

  // The tool expects a function. Accept a bare expression too
  // (`zli eval document.title`): evaluate the source, and call the result only
  // if it is a function. Deciding at run time needs no guessing from the text.
  if (
    tool.name === 'evaluate_script' &&
    typeof args.function === 'string' &&
    args.format === undefined
  ) {
    args.function =
      `async (...args) => { const v = (${args.function}\n); ` +
      `return typeof v === 'function' ? v(...args) : v; }`;
  }

  // Relative file paths are relative to where the command was run.
  if (cwd) {
    for (const [p, v] of Object.entries(args)) {
      if (!/Paths?$/.test(p)) continue;
      const abs = f => (typeof f === 'string' ? path.resolve(cwd, f) : f);
      args[p] = Array.isArray(v) ? v.map(abs) : abs(v);
    }
  }
  return {tool, args, opts};
}

// Splits `a 1 + b 2` into [[a, 1], [b, 2]]. After `--` everything belongs to
// the current command, so a literal + can be passed: `zli press_key -- +`.
export function splitChain(argv) {
  const chain = [[]];
  let literal = false;
  for (const tok of argv) {
    if (tok === '+' && !literal) {
      chain.push([]);
      continue;
    }
    if (tok === '--') literal = true;
    chain.at(-1).push(tok);
  }
  return chain.filter(c => c.length);
}
