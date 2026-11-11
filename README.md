# devtools-qai

`qai` is a command-line interface to Chrome DevTools for AI agents. QAI stands for Quick Agent Interface: a CLI with everything an agent does not need removed. It runs the official [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) engine, so it has every capability the MCP server has, and replaces the parts that cost agents time and context: the transport, the argument syntax and the output format.

```sh
qai open https://example.com + snap -i
qai fill_form 3_9=Ada 3_11=blue + click 3_14 + snap -d
```

Measured against chrome-devtools-mcp 1.12.0 and agent-browser 0.42.0 ([full results](bench/RESULTS.md), [method](#benchmark-method)):

| | qai | official `chrome-devtools` CLI | chrome-devtools-mcp (MCP) | agent-browser |
|---|--:|--:|--:|--:|
| Read the page (snapshot) | **73 ms** | 887 ms | 33 ms | 108 ms |
| Tokens to learn the interface | **513** | 2,919 | 6,619 | 3,644 |
| Tokens to see a content-heavy page's controls | **3,110** | 7,734 | 7,734 | 3,896 |
| Form task: output tokens | **157** | 347 | 341 | 175 |
| Form task: calls the agent makes | **2** | 7 | 6 | 2 |
| Tools available | 59 of 59 | 59 of 59 | 59 of 59 | different set |

Where qai does not lead: a persistent MCP connection answers a single call faster because it starts no process, and agent-browser performs clicks and navigations faster. Both are covered in [the comparison](#comparison).

## How it works

```
qai (native client, ~80 KB)  ──pipe──>  qai daemon  ──MCP stdio──>  chrome-devtools-mcp  ──CDP──>  Chrome
```

- The **daemon** starts on the first command and keeps the browser open between commands. It speaks the public MCP protocol to an unmodified chrome-devtools-mcp, and builds the command line from the tool list the server reports. A tool added upstream is a qai command the same day, with no release.
- The **client** only forwards arguments and prints the reply. The native client starts in a few milliseconds; a Node client (`bin/qai.js`) does the same job everywhere Node runs.
- The **output layer** removes syntax that carries no information, filters and diffs snapshots, and writes images to disk instead of the terminal. `--raw` returns the engine's text untouched.

## Install

Requires Node 20.19 or newer and Chrome.

```sh
npm install -g github:rezonnnnn/devtools-qai
qai open https://example.com + snap -i
```

This installs the Node client. For the native client, build it (needs [Zig](https://ziglang.org/download/) on `PATH`) and call it directly:

```sh
npm run build:native -- --host
alias qai="$(node bin/qai.js native)"
```

To teach an agent the tool, give it [`skills/qai/SKILL.md`](skills/qai/SKILL.md) (513 tokens).

## Usage

```
qai <command> [args] [--option value]        chain commands with +
```

Required parameters are positional, the rest are `--name value`. `qai help` lists every command; `qai help <command>` describes one.

| Task | Command |
|---|---|
| Open a page and list what can be acted on | `qai open <url> + snap -i` |
| Act on elements by uid | `qai click 3_14`, `qai fill 3_9 Ada`, `qai fill_form 3_9=Ada 3_11=blue` |
| See only what changed | `qai snap -d` |
| Read a value | `qai eval document.title` |
| Screenshot | `qai shot --fullPage` |
| Console and network | `qai console`, `qai net`, `qai req --reqid 4` |
| Performance trace with insights | `qai performance_start_trace --reload --autoStop` |
| Lighthouse audit | `qai lighthouse_audit` |
| Heap snapshot | `qai take_heapsnapshot heap.heapsnapshot` |
| Pages | `qai pages`, `qai new <url>`, `qai page 2`, `--page 2` on any command |
| Browser options | `qai start --headless --isolated` (any chrome-devtools-mcp flag) |
| Several agents, one browser each | `QAI_SESSION=<name>` |

Options qai adds to every command: `-i` interactive elements only, `-d` changes since the last snapshot, `--max N` cap the output and save the rest to a file, `--json` structured output, `--raw` the engine's text verbatim. A lone `-` reads that argument from stdin, which avoids shell-quoting JavaScript.

Exit codes: 0 success, 1 the tool failed, 2 the call was malformed (stderr shows the usage line).

## Comparison

### Speed

Median of 15 warm runs per step, all against pages served locally.

| Step | qai | qai (Node client) | official CLI | MCP server | agent-browser |
|---|--:|--:|--:|--:|--:|
| snapshot | 73 ms | 87 ms | 887 ms | 33 ms | 108 ms |
| snapshot, interactive only | 67 ms | 86 ms | 869 ms | 30 ms | 85 ms |
| evaluate script | 143 ms | 175 ms | 1,067 ms | 222 ms | 41 ms |
| click | 288 ms | 329 ms | 1,085 ms | 263 ms | 48 ms |
| screenshot to file | 101 ms | 134 ms | 886 ms | 84 ms | 100 ms |
| navigate | 169 ms | 200 ms | 979 ms | 134 ms | 105 ms |
| cold start to first page | 1,253 ms | 1,182 ms | 2,549 ms | 1,236 ms | 2,513 ms |

Reading the numbers:

- **Against the official CLI**, qai is 4 to 13 times faster, step for step. The official client spends about a second starting up on each command; its daemon is as fast as ours because it is the same engine.
- **Against the MCP server**, qai pays roughly 40 ms per command to start a process, which a persistent MCP connection does not. qai's `eval` is faster only because it skips the engine's settle wait, which an MCP caller can also request (`waitForStableDom: false`).
- **Against agent-browser**, qai reads the page as fast or faster and acts on it more slowly. After every click, fill or navigation the DevTools engine watches about 200 ms for a navigation and for the DOM to settle, so the next snapshot reflects the result. agent-browser returns immediately. That wait is the engine's, and qai keeps it.

### Context cost

| | qai | official CLI | MCP server | agent-browser |
|---|--:|--:|--:|--:|
| Learning the interface | 513 (skill file) | 2,919 (skill file) | 6,619 (tool definitions) | 3,644 (`skills get core`) |
| Full snapshot of a 40-product shop page | 7,262 | 7,734 | 7,734 | 7,462 |
| Interactive elements of that page | 3,110 | 7,734 (no filter) | 7,734 (no filter) | 3,896 |
| Form task, all output | 157 | 347 | 341 | 175 |
| Form task plus learning the interface | **670** | 3,266 | 6,960 | 3,819 |

Tokens are counted with the `o200k_base` tokenizer as a neutral proxy; other models' counts differ by a few percent. MCP tool definitions sit in the context of every session whether or not the browser is used; a skill file is read when needed.

### Capability

qai exposes the chrome-devtools-mcp tool list unchanged: 32 tools by default and 59 with every optional category and experiment enabled. The test suite asserts this against the live server on each run.

| | qai | chrome-devtools-mcp | agent-browser |
|---|:-:|:-:|:-:|
| Navigate, click, fill, type, drag, upload, dialogs | yes | yes | yes |
| Accessibility snapshot with element references | yes | yes | yes |
| Interactive-only snapshot | yes | no | yes |
| Snapshot diff | yes | no | yes |
| Several commands in one call | yes (`+`) | no | yes (`batch`) |
| Console messages and network requests | yes | yes | yes |
| Performance trace **with analysed insights** (LCP breakdown, render blocking, ...) | yes | yes | records the trace only |
| Lighthouse audit | yes | yes | no |
| Heap snapshots and memory analysis | yes | yes | no |
| Matched CSS rules for an element | yes | yes | `get styles` |
| CPU and network throttling | yes | yes | offline only |
| Extension install and reload, PWA install | yes | yes | loads extensions at launch |
| Screen recording | yes | yes | yes |
| Network interception and mocking, HAR | no | no | yes |
| Cookie and storage commands | via `eval` | via `evaluate_script` | yes |
| CSS-selector targeting | via `eval` | via `evaluate_script` | yes |
| PDF export, axe audit, React inspector | no | no | yes |
| Cloud browser providers, iOS | no | no | yes |

The agent-browser column reflects its `--help` at 0.42.0.

### Which to use

- **qai**: debugging and performance work from an agent with a shell, where the DevTools-grade tools matter and context is the scarce resource.
- **chrome-devtools-mcp**: clients without a shell, or anything that depends on MCP-native features.
- **agent-browser**: high-volume click-through automation where per-action latency dominates, or when you need request mocking, cloud browsers or iOS.

## Benchmark method

`npm run bench` runs [`bench/run.mjs`](bench/run.mjs): the same steps through each interface, each with its own headless Chrome, against a local server so no network is involved. It writes [`bench/RESULTS.md`](bench/RESULTS.md).

- CLIs are timed as whole processes, from spawn to exit. qai and agent-browser are called as native binaries, the official CLI through `node`. The MCP server is timed per tool call over one open connection.
- The form task (open a page, read it, fill two fields, tick a box, submit, verify the result) is written the shortest way each interface allows, and every run must end with the expected text on the page.
- Results above: Intel Core Ultra 5 235U, Windows 11, Node 24.14, 2026-11-11. Absolute times vary by machine; rerun the script for yours.

## Tests

`npm test` drives the real CLI against real Chrome:

- every tool in the default catalogue is invoked end to end on a fixture page;
- the tool list qai reports is compared with the server's, for default flags and with every category enabled;
- every parameter of every tool (214 across 59 tools) is checked to be reachable from the command line;
- the native client is compared with the Node client on output, exit codes, quoting and Unicode.

## Security

- The daemon accepts commands only from the user who started it. On Linux and macOS its socket and every file qai writes live in a private directory (`qai-<user>`, mode 700) that both clients verify before connecting.
- On Windows the daemon listens on a named pipe whose name includes the user name, the same model the official CLI uses. On a machine shared with users you do not trust, another user could claim that pipe name before your daemon starts; run qai there only inside your own session or container.
- Page content is untrusted. qai prints it but never acts on it: nothing in a page's text can select a page, run a command or change an option.
- Usage statistics that chrome-devtools-mcp would send to Google are off unless you start the daemon with `--usage-statistics`.

## Limits

- qai is as capable and, for actions, as fast as the engine it runs. It adds no browser features of its own.
- Element uids come from the latest snapshot and change after a navigation.
- The npm package is not published yet; install from GitHub.

## License

Apache-2.0. qai depends on chrome-devtools-mcp (Apache-2.0, Google LLC) and is an independent project, not affiliated with or endorsed by Google or the Chrome DevTools team.
