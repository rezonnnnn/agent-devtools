---
name: cdt
description: Use when driving or inspecting a Chrome page from the shell with the cdt CLI - navigate, read the page, click, fill forms, run JavaScript, screenshots, console, network, performance traces, Lighthouse, heap snapshots.
---

# cdt

`cdt <command> [args] [--option value]`. The browser starts on the first command and persists between commands.

## Loop

1. Look: `cdt open <url> + snap -i` prints the interactive elements, one per line, each starting with its uid (`3_14 button "Submit"`).
2. Act on uids, chaining with `+` so one call does the whole step and re-reads only what changed:
   `cdt fill_form 3_9=Ada 3_11=blue + click 3_14 + snap -d`
3. Verify with `snap -d` (changes since the last snapshot), `wait <text>`, or `eval <js expression>`.

A chain stops at the first failing command. uids change after a navigation: take a new snapshot.

## Reading the page

| Need | Command |
|---|---|
| Elements to act on | `snap -i` |
| Full page text and structure | `snap` |
| What changed | `snap -d` (combine: `snap -i -d`) |
| A value | `eval document.title` or `eval "() => ..."`; `eval -` reads the script from stdin |
| Pixels | `shot [--filePath f.png] [--fullPage]` prints the file path |
| Console / network | `console`, `msg <id>`, `net`, `req --reqid <id>` |

## Rules

- Required parameters are positional; everything else is `--name value`. `cdt help` lists every command, `cdt help <command>` its parameters.
- Commands act on the selected page: `pages` lists, `page <n>` selects, `--page <n>` targets one command.
- Exit code 2 means the call was malformed; stderr shows the usage line to copy.
- Cap long output with `--max <chars>`; the full text is saved to the path printed.
- Browser options go to the daemon: `cdt start --headless --isolated` accepts any chrome-devtools-mcp flag. `cdt stop` closes the browser.
