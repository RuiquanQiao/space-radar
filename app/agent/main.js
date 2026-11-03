"use strict";
// skillframe in Space Radar: the agent sidebar, and the tools that let the agent read the scan,
// point at what it means in the chart, and move things to the Recycle Bin after the user says yes.
//
// Each window is a BaseWindow with two views side by side:
//   - Space Radar's own page (unchanged, Node enabled, as upstream has it), on the left
//   - skillframe's sidebar, a plain web page from skillframe's local server, on the right
// The sidebar never gets Node: it shows what the agent writes, so it stays a sandboxed page and
// talks to this process only through agent/sidebar-preload.js. The chart's page is reached from
// here with executeJavaScript, calling what agent/bridge.js puts on window.__agent.
const path = require("path");
const fs = require("fs");
const { app, BaseWindow, WebContentsView, Menu, dialog, ipcMain, shell, screen } = require("electron");

// npm run smoke (agent/smoke.js): checks this file's work in a real window, on its own data
const smoke = process.argv.includes("--agent-smoke") ? require("./smoke") : null;
if (smoke) smoke.prepare();

const SIDEBAR_MIN = 300;
const CHART_MIN = 480;
const DEFAULT_WIDTH = 360;

let sf = null;
let sfUrl = null;
let lastActive = null; // the window the agent's tools act on
let dark = false;
const windows = new Set();

const settingsFile = () => path.join(app.getPath("userData"), "agent-sidebar.json");
function readSettings() {
  try {
    return { open: true, width: DEFAULT_WIDTH, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) };
  } catch {
    return { open: true, width: DEFAULT_WIDTH };
  }
}
let settings = null;
function saveSettings() {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings));
  } catch {}
}

/** starts skillframe's local server; call once, before opening windows */
async function start() {
  settings = readSettings();
  const { createSkillframe } = await import("skillframe");
  const home = app.getPath("userData");
  sf = createSkillframe({
    appName: "Space Radar",
    workspace: path.join(home, "agent-workspace"),
    dataDir: path.join(home, "skillframe"),
    static: path.join(__dirname, "public"),
    context: () => describeScreen(),
    tools,
  });
  ({ url: sfUrl } = await sf.listen());
  app.on("will-quit", () => sf.close());
}

/** a Space Radar window with the sidebar beside it; returns it with .webContents set to the chart's,
 *  so upstream code written for a BrowserWindow (mainWindow.webContents.send) keeps working */
function openWindow() {
  const size = screen.getPrimaryDisplay().workAreaSize;
  const height = Math.max(size.height * 0.8, 600) | 0;
  const width = Math.min(size.width, Math.max((height * 6) / 8, 880) + (settings.open ? settings.width : 0)) | 0;
  const win = new BaseWindow({ width, height, minWidth: 794, minHeight: 480, title: "Space Radar", icon: path.join(__dirname, "..", "Icon.png") });

  const chart = new WebContentsView({ webPreferences: { nodeIntegration: true, contextIsolation: false } });
  const side = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, "sidebar-preload.js"), sandbox: true, contextIsolation: true },
  });
  win.contentView.addChildView(chart);
  win.contentView.addChildView(side);
  win.webContents = chart.webContents;
  win.chart = chart;
  win.side = side;

  // links the agent writes open in the user's browser, not inside the sidebar
  side.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  side.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(sfUrl)) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  chart.webContents.on("page-title-updated", (e, title) => win.setTitle(title));
  // the application menu is set after the first window opens, which makes the content area shorter
  // without a resize event: lay out again once the page is there
  chart.webContents.on("did-finish-load", () => win.layout());
  side.webContents.on("did-finish-load", () => {
    if (win.header) send(side, "header", win.header);
    if (win.scanned) send(side, "scanned", win.scanned);
  });

  win.layout = () => {
    if (win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    const sw = settings.open ? clampWidth(settings.width, w) : 0;
    chart.setBounds({ x: 0, y: 0, width: w - sw, height: h });
    side.setBounds({ x: w - sw, y: 0, width: sw, height: h });
    side.setVisible(settings.open);
  };
  win.on("resize", win.layout);
  win.on("focus", () => (lastActive = win));
  win.on("closed", () => {
    windows.delete(win);
    if (lastActive === win) lastActive = [...windows].pop() ?? null;
    if (!chart.webContents.isDestroyed()) chart.webContents.close();
    if (!side.webContents.isDestroyed()) side.webContents.close();
  });
  win.layout();

  chart.webContents.loadURL("file://" + path.join(__dirname, "..", "index.html"));
  side.webContents.loadURL(`${sfUrl}?dark=${dark ? 1 : 0}`);
  if (process.env.DEBUG) chart.webContents.openDevTools({ mode: "detach" });

  windows.add(win);
  lastActive = win;
  if (smoke && windows.size === 1) chart.webContents.once("did-finish-load", () => smoke.run(module.exports, win));
  return win;
}

function clampWidth(width, total) {
  return Math.max(SIDEBAR_MIN, Math.min(width, total - CHART_MIN));
}

function setOpen(open) {
  settings.open = open;
  saveSettings();
  for (const win of windows) {
    win.layout();
    send(win.chart, "agent-open", open);
  }
}

/** Space Radar's dark mode (its Color Options menu) also darkens the sidebar */
function setDark(on) {
  dark = !!on;
  for (const win of windows) send(win.side, "theme", dark ? "dark" : "light");
}

function send(view, channel, ...args) {
  if (!view.webContents.isDestroyed()) view.webContents.send(channel, ...args);
}

const fromSidebar = (e) => [...windows].find((w) => w.side.webContents === e.sender);
const fromChart = (e) => [...windows].find((w) => w.chart.webContents === e.sender);

// the divider on the sidebar's left edge: the width it asks for, while dragging and at the end
ipcMain.on("agent-width", (e, width, done) => {
  const win = fromSidebar(e);
  if (!win) return;
  settings.width = clampWidth(width, win.getContentSize()[0]);
  for (const w of windows) w.layout();
  if (done) saveSettings();
});
ipcMain.on("agent-toggle", (e, open) => setOpen(typeof open === "boolean" ? open : !settings.open));
ipcMain.handle("agent-state", () => settings.open);

// "Ask the agent" from the chart's context menu, and "Find space to free" after a scan
ipcMain.on("agent-ask", (e, prompt, shown) => {
  const win = fromChart(e) ?? fromSidebar(e);
  if (!win) return;
  if (!settings.open) setOpen(true);
  send(win.side, "ask", prompt, shown);
});
// what the chart shows and how tall its toolbar is: kept, and sent again when the sidebar (re)loads
ipcMain.on("agent-scanned", (e, summary) => {
  const win = fromChart(e);
  if (!win) return;
  win.scanned = summary;
  send(win.side, "scanned", summary);
});
ipcMain.on("agent-header", (e, height) => {
  const win = fromChart(e);
  if (!win) return;
  win.header = height;
  send(win.side, "header", height);
});

// the chart's right-click menu (upstream built it with electron.remote, which Electron removed)
ipcMain.on("agent-context-menu", (e, item) => {
  const win = fromChart(e);
  if (!win || !item) return;
  const zh = app.getLocale().startsWith("zh");
  const t = (en, cn) => (zh ? cn : en);
  const run = (cmd) => send(win.chart, "agent-context-command", cmd);
  Menu.buildFromTemplate([
    { label: t("Ask the agent about this", "问 agent 这是什么"), click: () => run("ask") },
    { type: "separator" },
    { label: t("Show in Explorer", "在资源管理器中显示"), click: () => shell.showItemInFolder(item.path) },
    { label: t("Open", "打开"), enabled: !item.folder, click: () => shell.openPath(item.path) },
    { type: "separator" },
    { label: t("Move to Recycle Bin…", "移到回收站…"), click: () => trash(win, [item.path], "") },
  ]).popup({ window: win });
});

/** asks first, then moves to the Recycle Bin; returns what happened, in words */
async function trash(win, paths, reason) {
  const zh = app.getLocale().startsWith("zh");
  const t = (en, cn) => (zh ? cn : en);
  const items = await call(win, "sizes", paths);
  const missing = items.filter((i) => !fs.existsSync(i.path));
  if (missing.length) return `Not found, nothing was moved: ${missing.map((i) => i.path).join(", ")}`;
  const total = items.reduce((s, i) => s + (i.size ?? 0), 0);
  const list = items.map((i) => `${i.path}  (${i.size == null ? t("not in the scan", "不在扫描结果里") : formatSize(i.size)})`).join("\n");
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    title: "Space Radar",
    message: t(`Move ${items.length} item(s), ${formatSize(total)}, to the Recycle Bin?`, `把这 ${items.length} 项（共 ${formatSize(total)}）移到回收站？`),
    detail: `${list}${reason ? `\n\n${t("Why", "理由")}: ${reason}` : ""}\n\n${t("You can restore them from the Recycle Bin. The space comes back when the Recycle Bin is emptied.", "移到回收站后还可以还原；清空回收站后空间才真正腾出来。")}`,
    buttons: [t("Move to Recycle Bin", "移到回收站"), t("Cancel", "取消")],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return "The user said no. Nothing was moved.";
  const done = [];
  const failed = [];
  for (const i of items) {
    try {
      await shell.trashItem(i.path);
      done.push(i.path);
    } catch (err) {
      failed.push(`${i.path}: ${err.message}`);
    }
  }
  if (done.length) await call(win, "removed", done);
  return [
    done.length
      ? `Moved to the Recycle Bin (${formatSize(items.filter((i) => done.includes(i.path)).reduce((s, i) => s + (i.size ?? 0), 0))}): ${done.join(", ")}. ` +
        "The chart no longer shows them. The disk space comes back only when the Recycle Bin is emptied; tell the user so."
      : "",
    failed.length ? `Failed: ${failed.join("; ")}` : "",
  ].filter(Boolean).join("\n");
}

/** runs window.__agent[fn](...args) in the chart's page; its errors keep their message (executeJavaScript
 *  alone turns a thrown error into a generic one, and the agent needs to read why) */
async function call(win, fn, ...args) {
  if (!win || win.isDestroyed()) throw new Error("Space Radar's window is closed.");
  const r = await win.chart.webContents.executeJavaScript(
    `(async () => { try { return { ok: await window.__agent.${fn}(...${JSON.stringify(args)}) }; } catch (e) { return { error: String(e && e.message || e) }; } })()`,
    true,
  );
  if (r.error) throw new Error(r.error);
  return r.ok;
}

function target() {
  if (!lastActive || lastActive.isDestroyed()) throw new Error("No Space Radar window is open.");
  return lastActive;
}

async function describeScreen() {
  let v;
  try {
    v = await call(target(), "view");
  } catch {
    return "";
  }
  if (!v.root) return "The user is in Space Radar, a disk usage viewer, and has not scanned anything yet.";
  const lines = [
    `The user is in Space Radar, a disk usage viewer. Scanned: ${v.root} (${formatSize(v.rootSize)})${v.scanning ? ", scan still running" : ""}.`,
    `They are looking at ${v.folder} (${formatSize(v.folderSize)}). Its biggest items: ${v.items.slice(0, 5).map((i) => `${i.name} ${formatSize(i.size)}`).join(", ") || "none"}.`,
  ];
  if (v.free != null) lines.push(`Free space on that drive: ${formatSize(v.free)}.`);
  lines.push("Use the space_radar tools to read the scan (not a new scan of your own), show_in_chart to point at what you talk about, and move_to_trash to delete: it asks the user first.");
  return lines.join("\n");
}

const tools = {
  current_view: {
    description: "What Space Radar shows now: the scanned folder, the folder the user is looking at, its biggest items with their sizes, and the drive's free space. Read from the scan already in memory; nothing is scanned again.",
    input: {},
    run: async () => JSON.stringify(await call(target(), "view"), null, 1),
  },
  largest: {
    description: "From the scan in memory: the biggest direct children of a folder, and the biggest files anywhere below it. Sizes are in bytes, as allocated on disk by the scan.",
    input: { path: "string", count: "number" },
    optional: ["count"],
    run: async ({ path: p, count }) => JSON.stringify(await call(target(), "largest", p, count ?? 15), null, 1),
  },
  show_in_chart: {
    description: "Point at a file or folder in Space Radar's chart: the chart opens that folder (for a file, its folder) so the user sees what you are talking about. Use it whenever you name a specific place.",
    input: { path: "string" },
    run: async ({ path: p }) => call(target(), "show", p),
  },
  scan: {
    description: "Scan a folder or drive (for example C:\\ or C:\\Users\\name) and wait until it is done, up to 10 minutes. Replaces the scan on screen.",
    input: { path: "string" },
    run: async ({ path: p }) => {
      if (!fs.existsSync(p)) throw new Error(`${p} does not exist.`);
      return call(target(), "scan", p);
    },
  },
  move_to_trash: {
    description: "Move files or folders to the Windows Recycle Bin. Space Radar first shows the user each path with its size and your reason, and nothing moves unless they confirm. Prefer this over deleting with shell commands.",
    input: { paths: { type: "array", items: { type: "string" } }, reason: "string" },
    run: async ({ paths, reason }) => {
      if (!paths?.length) throw new Error("No paths given.");
      return trash(target(), paths, reason);
    },
  },
};

function formatSize(bytes) {
  if (bytes == null) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : n >= 100 ? 0 : 1)} ${units[i]}`;
}

module.exports = { start, openWindow, setOpen, isOpen: () => settings.open, setDark, tools, describeScreen, formatSize };
