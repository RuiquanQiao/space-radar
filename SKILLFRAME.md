# Space Radar, with an agent sidebar

[Space Radar](https://github.com/zz85/space-radar) (MIT, by Joshua Koo) draws what fills a disk as a
sunburst, treemap or flame graph. Like most disk usage viewers it shows the sizes and stops there:
which of those folders you can delete is left to you. This fork adds a
[skillframe](https://github.com/RuiquanQiao/skillframe) sidebar, so the coding agent you already use
(Claude Code, Codex, …) can read the scan, find out what each big folder is, point at it in the
chart, and move what you approve to the Recycle Bin.

It is an existing app given an agent, not an app written for one, and it uses skillframe from npm
the way any other app would. `git diff upstream/master` shows everything the agent took.

```
npm install          # Electron 40, Space Radar's own packages, and skillframe
npm start
npm run smoke        # the checks below, in a real window, without an agent
```

You need Claude Code, Codex or another agent skillframe supports installed and signed in; the
sidebar runs it on your own subscription.

## What you get

- **The sidebar**, on the right of the same window. Drag its left edge to change its width (kept
  for next time), hide it with `»`, the speech-bubble button in the toolbar or Ctrl+Shift+A.
  Its header continues Space Radar's toolbar, and Space Radar's dark mode (Color Options) darkens
  it too.
- **Find space I can free**: once something is scanned, one button asks the agent to go through
  it, biggest first, check what it is unsure of, and list what is safe to remove without moving
  anything yet.
- **Right-click** an item in the chart: Ask the agent about this, Show in Explorer, Open, Move to
  Recycle Bin.
- **What the agent knows**: with every message, the scanned folder, the folder you are looking at
  and its biggest items. Its tools:

| Tool | |
|---|---|
| `current_view` | what is on screen: the scanned folder, the folder shown, its biggest items, the drive's free space |
| `largest(path, count)` | from the scan in memory: a folder's biggest children, and the biggest files anywhere below it |
| `show_in_chart(path)` | opens that folder in the chart (for a file, its folder), so you see what the agent means |
| `scan(path)` | scans a folder or drive and waits for it, up to 10 minutes |
| `move_to_trash(paths, reason)` | asks you first, listing each path, its size and the agent's reason; nothing moves unless you confirm. The space comes back when the Recycle Bin is emptied. |

The agent can still delete with its own shell commands; those go through its own permission
prompt in the sidebar. `move_to_trash` is the safer path the tools steer it to.

## How it is put together

| File | |
|---|---|
| `app/agent/main.js` | main process: starts skillframe, opens each window as two views side by side, the tools, the context menu, the Recycle Bin question |
| `app/agent/bridge.js` | in Space Radar's page: what the tools read and do there (`window.__agent`), the toolbar button, the right-click menu |
| `app/agent/public/index.html` | the sidebar's page: the header, the divider, `<skillframe-chat>` |
| `app/agent/sidebar-preload.js` | the only bridge between the sidebar page and the rest of the app |
| `app/agent/smoke.js` | `npm run smoke` |

Space Radar's page runs with Node enabled, as upstream has it. The sidebar shows what the agent
writes, so it is not put in that page: it is a second, sandboxed view without Node, which only
talks to the main process through `sidebar-preload.js`. Space Radar's charts size themselves to
their window, so a second view (rather than a column inside their page) also needed no change to
the charts.

Upstream files changed: `app/main.js` (start skillframe, open windows through `agent/main.js`, a
View > Agent Sidebar item, dark mode to the sidebar, the folder picker's parent window),
`app/index.html` (loads `agent/bridge.js`), `package.json` (skillframe, `npm run smoke`),
`.gitignore` (the smoke test's folder), `README.md` (a note on top) and one fix in `app/js/du.js`.

## Fixed in Space Radar on the way

- **Whole folders missing from scans on Windows.** Space Radar skips a file or folder whose inode
  it has already seen, to count hard links once. NTFS file IDs pass 2^53, so read as plain numbers
  two different folders could get the same one and the second was skipped with everything in it
  (here, a test folder's only subfolder, every time). `du.js` now reads them as `bigint`.
- **No right-click menu.** It was built with `electron.remote`, which Electron removed, so it never
  appeared; Delete and Open also called `shell.moveItemToTrash` and `shell.openItem`, both removed.
  The menu now comes from the main process and uses `shell.trashItem` and `shell.openPath`.
- **A sideways scrollbar in the footer** when the scan stats don't fit (more often next to the
  sidebar): they are cut with "…", and the whole line is in the tooltip.

## Checks

`npm run smoke` opens the real window on a small folder it makes in `.cache/smoke` and checks: the
two views fill the window and the footer is not cut off; the toolbar stays on one row; the
sidebar's header matches the toolbar's height; each tool's answer, including sizes and errors the
agent can read; `move_to_trash` moving nothing on Cancel and the chart dropping what was moved;
the divider, the toggle, dark mode, and a question from the chart reaching the chat. It leaves the
user's own Space Radar data, settings and Recycle Bin alone and starts no agent.
