"use strict";
// npm run smoke: the retrofitted Space Radar in a real Electron window, checked end to end without
// an agent (no agent is started, nothing is spent): the two views' layout, the toolbar, the
// sidebar's divider and toggle, dark mode, and every tool on a small folder made for the test.
// Everything it writes goes to examples/space-radar/.cache/smoke (git-ignored); the user's own
// Space Radar data, settings and Recycle Bin are not touched (trashing is swapped for a delete).
const path = require("path");
const fs = require("fs");
const { app, dialog, shell } = require("electron");

const dir = path.join(__dirname, "..", "..", ".cache", "smoke");

/** before app ready: the app's data goes to the test folder (renderers inherit APPDATA) */
function prepare() {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "appdata"), { recursive: true });
  process.env.APPDATA = path.join(dir, "appdata");
  app.setPath("userData", path.join(dir, "appdata", "SpaceRadar"));
  // Space Radar opens a folder picker on start; the test answers it with Cancel, unseen
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
}

async function run(agent, win) {
  const failures = [];
  const check = (ok, what) => {
    if (!ok) failures.push(what);
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const chart = (js) => win.chart.webContents.executeJavaScript(js, true);
  const side = (js) => win.side.webContents.executeJavaScript(js, true);
  async function until(fn, ms = 10000) {
    for (let t = 0; t < ms; t += 100) {
      try {
        if (await fn()) return true;
      } catch {}
      await wait(100);
    }
    return false;
  }
  const tool = (name, args) => agent.tools[name].run(args, { chatId: "smoke" });

  try {
    // the folder the tools work on
    const root = path.join(dir, "disk");
    fs.mkdirSync(path.join(root, "sub", "deeper"), { recursive: true });
    fs.writeFileSync(path.join(root, "big.bin"), Buffer.alloc(300_000));
    fs.writeFileSync(path.join(root, "small.txt"), "hello");
    fs.writeFileSync(path.join(root, "sub", "nested.bin"), Buffer.alloc(120_000));
    fs.writeFileSync(path.join(root, "sub", "deeper", "tiny.txt"), "x".repeat(100));

    await until(() => chart("!!window.__agent"));
    await until(() => side("!!document.querySelector('skillframe-chat')?.shadowRoot?.querySelector('textarea')"));
    await wait(300);

    // layout: the two views fill the window's content area, side by side
    const [w, h] = win.getContentSize();
    const cb = win.chart.getBounds();
    const sb = win.side.getBounds();
    check(cb.x === 0 && cb.width + sb.width === w && sb.x === cb.width, `views fill the width (${cb.width} + ${sb.width} = ${w})`);
    check(cb.height === h && sb.height === h, `views are as tall as the content area (${cb.height}, ${h})`);
    const page = await chart("({ ih: innerHeight, footer: document.querySelector('footer').getBoundingClientRect().bottom })");
    check(Math.abs(page.footer - page.ih) < 1, `Space Radar's footer is at the bottom of its view (${page.footer} of ${page.ih})`);
    const tops = await chart("[...document.querySelectorAll('header .toolbar-actions > .btn, header .toolbar-actions > .btn-group')].filter(c => c.offsetWidth).map(c => Math.round(c.getBoundingClientRect().top))");
    check(Math.max(...tops) - Math.min(...tops) <= 2, `the toolbar is one row next to the sidebar (${tops.join(",")})`);
    check(await chart("!!document.querySelector('#agent_button.active')"), "the Agent button shows the sidebar is open");
    const heights = await until(async () => Math.abs((await side("document.querySelector('#sr-header').getBoundingClientRect().height")) - (await chart("document.querySelector('header').getBoundingClientRect().height"))) < 1);
    check(heights, "the sidebar's header is as tall as Space Radar's toolbar");
    check(await side("document.querySelector('#sr-analyze').disabled"), "with nothing scanned, the analyze button is off");

    // nothing scanned yet
    const empty = JSON.parse(await tool("current_view", {}));
    check(empty.root === null, "current_view before a scan says nothing is scanned");

    // scan, and read it back
    const scanned = await tool("scan", { path: root });
    check(/^Scanned /.test(scanned) && scanned.includes(root), `scan waits for the scan: "${scanned}"`);
    const view = JSON.parse(await tool("current_view", {}));
    const expected = 300_000 + 5 + 120_000 + 100;
    check(view.root === root && view.folder === root, "current_view names the scanned folder");
    check(view.rootSize === expected, `sizes add up (${view.rootSize} = ${expected})`);
    check(view.items.map((i) => i.name).join(",") === "big.bin,sub,small.txt", `items biggest first (${view.items.map((i) => i.name)})`);
    check(await until(() => side("!document.querySelector('#sr-analyze').disabled")), "after a scan, the analyze button is on");
    // as long as a real drive's stats with the folder after them (what made the scrollbar appear);
    // set and measured in one go, before Space Radar writes its own status again
    const scrollers = await chart(`(() => {
      document.getElementById("disk_space_info").textContent = "Total: 1.86 TB | Free: 1.00 TB | Used: 879.72 GB (46.11%)";
      document.getElementById("bottom_status").textContent = "Scanned: 1,234,567 files | 234,567 dirs | 812.31 GB in 9.7m (2,119 items/sec, 1.40 GB/sec)C:/Users/someone/AppData/Local";
      return [...document.querySelectorAll("footer *")].filter((e) => ["auto", "scroll"].includes(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth).map((e) => e.id || e.className);
    })()`);
    check(scrollers.length === 0, `the footer has no sideways scrollbar after a scan (${scrollers})`);
    check((await side("document.querySelector('#sr-scanned').textContent")).includes(root), "the sidebar's header names the scanned folder");
    const context = await agent.describeScreen();
    check(context.includes(root) && context.includes("big.bin"), "the agent's context says what is on screen");

    const largest = JSON.parse(await tool("largest", { path: path.join(root, "sub") }));
    check(largest.children.map((c) => c.name).join(",") === "nested.bin,deeper", "largest lists a folder's children by size");
    check(largest.biggestFiles[0].path === path.join(root, "sub", "nested.bin"), "largest finds the biggest file below");

    // pointing at things in the chart
    await tool("show_in_chart", { path: path.join(root, "sub", "deeper").toUpperCase() + "\\" });
    check((await chart("Navigation.currentPath().slice(1).join('/')")) === "sub/deeper", "show_in_chart opens a folder (any case, trailing slash)");
    await tool("show_in_chart", { path: path.join(root, "big.bin") });
    check((await chart("Navigation.currentPath().length")) === 1, "show_in_chart on a file opens its folder");
    let outside = null;
    await tool("show_in_chart", { path: "C:\\Windows" }).catch((e) => (outside = e.message));
    check(/not in the scan/.test(outside ?? ""), "show_in_chart outside the scan is an error the agent can read");
    await chart("State.navigateTo(['nowhere', 'x'])");
    check(JSON.parse(await tool("current_view", {})).folder === root, "a navigation path not in the scan falls back to what is shown");

    // move_to_trash: nothing moves without a yes
    const realBox = dialog.showMessageBox;
    const realTrash = shell.trashItem;
    let asked = null;
    shell.trashItem = async (p) => fs.rmSync(p, { recursive: true });
    dialog.showMessageBox = async (_w, o) => ((asked = o), { response: 1 });
    const no = await tool("move_to_trash", { paths: [path.join(root, "big.bin")], reason: "test" });
    check(/said no/.test(no) && fs.existsSync(path.join(root, "big.bin")), "move_to_trash: a No moves nothing");
    check(asked && asked.detail.includes(path.join(root, "big.bin")) && asked.detail.includes("test") && asked.defaultId === asked.cancelId, "the question lists the path and the reason, and defaults to Cancel");
    dialog.showMessageBox = async () => ({ response: 0 });
    const yes = await tool("move_to_trash", { paths: [path.join(root, "big.bin"), path.join(root, "sub")], reason: "test" });
    check(/Moved to the Recycle Bin/.test(yes) && !fs.existsSync(path.join(root, "big.bin")) && !fs.existsSync(path.join(root, "sub")), "move_to_trash: a Yes moves them");
    const after = JSON.parse(await tool("current_view", {}));
    check(after.items.map((i) => i.name).join(",") === "small.txt" && after.rootSize === 5, "the chart drops what was moved, without a rescan");
    const missing = await tool("move_to_trash", { paths: [path.join(root, "gone.bin")], reason: "" });
    check(/Not found/.test(missing), "move_to_trash on a missing path moves nothing");
    dialog.showMessageBox = realBox;
    shell.trashItem = realTrash;

    // the divider, the toggle, dark mode
    await side("spaceRadar.setWidth(520, true)");
    check(await until(() => win.side.getBounds().width === 520), `dragging the divider sets the width (${win.side.getBounds().width})`);
    check(JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "agent-sidebar.json"), "utf8")).width === 520, "the width is kept for next time");
    await side("spaceRadar.setWidth(99999, true)");
    check(win.chart.getBounds().width >= 480, "the chart keeps at least 480 px");
    await side("spaceRadar.close()");
    check(await until(() => win.chart.getBounds().width === w), "hiding the sidebar gives the chart the whole window");
    check(await until(() => chart("!document.querySelector('#agent_button.active')")), "the Agent button shows the sidebar is hidden");
    await chart("document.querySelector('#agent_button').click()");
    check(await until(() => win.side.getBounds().width > 0 && win.chart.getBounds().width < w), "the Agent button brings it back");
    agent.setDark(true);
    check(await until(async () => (await side("document.documentElement.dataset.theme")) === "dark"), "Space Radar's dark mode darkens the sidebar");
    agent.setDark(false);

    // "Ask the agent about this" reaches the sidebar's chat
    await side("window.__asked = null; document.querySelector('skillframe-chat').ask = (a) => (window.__asked = a, Promise.resolve({ ok: true })); 1");
    await chart("require('electron').ipcRenderer.send('agent-ask', 'What is X?', 'X?')");
    check(await until(async () => (await side("window.__asked?.prompt")) === "What is X?"), "a question from the chart reaches the sidebar's chat");
  } catch (e) {
    failures.push(e.stack);
    console.log("FAIL", e.stack);
  }
  console.log(failures.length ? `SMOKE FAILED: ${failures.length} failed` : "SMOKE OK");
  app.exit(failures.length ? 1 : 0);
}

module.exports = { prepare, run };
