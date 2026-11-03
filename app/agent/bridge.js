"use strict";
// Space Radar's page, seen from the agent (agent/main.js calls window.__agent.* with
// executeJavaScript). It reads the scan already in memory: PluginManager.data, whose folders have
// `children` and files a `size`. The charts filter `children` for drawing and keep the full list in
// `_children`, and add nodes of their own ("Other files", "Free Space"), which are skipped here.
//
// Also on this page: the Agent button in the toolbar, and the right-click menu, which upstream built
// with electron.remote (gone from Electron) and now comes from the main process.
(function () {
  const { ipcRenderer } = require("electron");
  const nodePath = require("path");

  // the scanner also leaves empty nodes for what it skipped (symbolic links, unreadable entries)
  const kids = (n) => ((n._children !== undefined ? n._children : n.children) || []).filter((c) => c.name != null && !c._isOtherFiles && !c._isFreeSpace);
  const isFolder = (n) => !!(n._children || n.children);

  // sizes of folders, computed once per scan
  let sized = new WeakMap();
  function sizeOf(n) {
    if (!isFolder(n)) return n.size || 0;
    let s = sized.get(n);
    if (s === undefined) {
      s = 0;
      for (const c of kids(n)) s += sizeOf(c);
      sized.set(n, s);
    }
    return s;
  }

  const root = () => PluginManager.data || null;
  const norm = (p) => nodePath.resolve(String(p)).replace(/[\\/]+$/, "").toLowerCase();

  /** the node at a filesystem path, with its chart keys ([root name, child, …]); null when outside the scan */
  function find(p) {
    const r = root();
    if (!r) return null;
    const rel = nodePath.relative(nodePath.resolve(r.name), nodePath.resolve(String(p)));
    if (rel.startsWith("..") || nodePath.isAbsolute(rel)) return null;
    const keys = [r.name];
    let n = r;
    for (const part of rel.split(/[\\/]/).filter(Boolean)) {
      n = kids(n).find((c) => c.name.toLowerCase() === part.toLowerCase());
      if (!n) return null;
      keys.push(n.name);
    }
    return { node: n, keys, path: nodePath.join(...keys) };
  }

  const pathOfKeys = (keys) => nodePath.join(...keys);
  const entry = (n, p) => ({ name: n.name, path: p, size: sizeOf(n), kind: isFolder(n) ? "folder" : "file" });
  const bySize = (a, b) => b.size - a.size;

  function children(n, p, count) {
    return kids(n).map((c) => entry(c, nodePath.join(p, c.name))).sort(bySize).slice(0, count);
  }

  function biggestFiles(n, p, count) {
    const out = [];
    (function walk(m, mp) {
      for (const c of kids(m)) {
        const cp = nodePath.join(mp, c.name);
        if (isFolder(c)) walk(c, cp);
        else if (c.size) {
          out.push(entry(c, cp));
          if (out.length > count * 4) out.sort(bySize).length = count;
        }
      }
    })(n, p);
    return out.sort(bySize).slice(0, count);
  }

  let scanWaiters = [];

  window.__agent = {
    view() {
      const r = root();
      if (!r) return { root: null, scanning: isScanning };
      // the deepest folder of the navigation path that is really in the scan (what the chart shows)
      let n = r;
      const shown = [r.name];
      for (const name of Navigation.currentPath().slice(1)) {
        const c = kids(n).find((k) => k.name === name && isFolder(k));
        if (!c) break;
        n = c;
        shown.push(name);
      }
      const folder = pathOfKeys(shown);
      const sel = selection && !selection._isOtherFiles && !selection._isFreeSpace ? pathOfKeys(window.keys(selection)) : null;
      return {
        root: r.name,
        rootSize: sizeOf(r),
        scanning: isScanning,
        folder,
        folderSize: sizeOf(n),
        hovered: sel,
        free: currentDiskInfo ? currentDiskInfo.available : null,
        items: children(n, folder, 15),
      };
    },

    largest(p, count) {
      const f = find(p);
      if (!f) throw new Error(`${p} is not in the scan on screen (${root() ? root().name : "nothing scanned yet"}).`);
      if (!isFolder(f.node)) return { path: f.path, size: f.node.size, kind: "file" };
      count = Math.max(1, Math.min(100, Math.floor(count) || 15));
      return { path: f.path, size: sizeOf(f.node), children: children(f.node, f.path, count), biggestFiles: biggestFiles(f.node, f.path, count) };
    },

    show(p) {
      const f = find(p);
      if (!f) throw new Error(`${p} is not in the scan on screen (${root() ? root().name : "nothing scanned yet"}).`);
      const folderKeys = isFolder(f.node) ? f.keys : f.keys.slice(0, -1);
      State.navigateTo(folderKeys);
      if (!isFolder(f.node)) State.highlightPath(f.keys);
      return `Showing ${f.path} (${format(sizeOf(f.node))}).`;
    },

    scan(p) {
      startScan(p);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(`Still scanning ${p} after 10 minutes; call current_view later.`), 10 * 60 * 1000);
        scanWaiters.push((summary) => {
          clearTimeout(timer);
          resolve(`${summary.cancelled ? "The user cancelled the scan of" : "Scanned"} ${summary.root}: ${summary.size} in ${summary.files} files.`);
        });
      });
    },

    sizes(paths) {
      return paths.map((p) => {
        const f = find(p);
        return { path: f ? f.path : nodePath.resolve(String(p)), size: f ? sizeOf(f.node) : null };
      });
    },

    // after move_to_trash: the scan as saved (lastload), without what was moved, drawn again
    removed(paths) {
      const raw = _loadLast();
      const gone = new Set(paths.map(norm));
      let base = raw.name;
      (function prune(n, p) {
        const list = n.children;
        if (!list) return;
        n.children = list.filter((c) => !gone.has(norm(nodePath.join(p, c.name))));
        for (const c of n.children) prune(c, nodePath.join(p, c.name));
      })(raw, base);
      sized = new WeakMap();
      onJson(null, raw);
      return true;
    },
  };

  // what is on screen, for the sidebar's header: after every load (a scan's progress, its end,
  // a du file, "Last loaded"), and when a scan ends, for whoever waits in scan()
  let summaryTimer = 0;
  function sendSummary() {
    clearTimeout(summaryTimer);
    summaryTimer = setTimeout(() => {
      const r = root();
      ipcRenderer.send("agent-scanned", r ? { root: r.name, size: format(sizeOf(r)), scanning: isScanning } : null);
    }, 50);
  }
  const upstreamComplete = window.complete;
  window.complete = function (json, finalStats) {
    const result = upstreamComplete.apply(this, arguments);
    sized = new WeakMap();
    const r = root();
    if (r) {
      const summary = { root: r.name, size: format(sizeOf(r)), files: finalStats ? finalStats.fileCount : 0, cancelled: !!(finalStats && finalStats.cancelled) };
      scanWaiters.splice(0).forEach((w) => w(summary));
    }
    sendSummary();
    return result;
  };
  const upstreamGenerate = PluginManager.generate.bind(PluginManager);
  PluginManager.generate = (json) => {
    sized = new WeakMap();
    const result = upstreamGenerate(json);
    sendSummary();
    return result;
  };

  // the Agent button, at the right end of the toolbar; an icon like the Up button beside it, so the
  // toolbar still fits on one row next to the sidebar
  const zh = navigator.language.startsWith("zh");
  const button = document.createElement("button");
  button.className = "btn btn-default btn-large pull-right";
  button.id = "agent_button";
  button.title = zh ? "Agent 侧边栏（Ctrl+Shift+A）" : "Agent sidebar (Ctrl+Shift+A)";
  button.setAttribute("aria-label", button.title);
  button.innerHTML = '<span class="icon icon-chat"></span>';
  button.onclick = () => ipcRenderer.send("agent-toggle");
  const modes = document.querySelector(".toolbar-actions .btn-group.pull-right");
  modes.parentNode.insertBefore(button, modes);
  const setActive = (open) => button.classList.toggle("active", !!open);
  ipcRenderer.invoke("agent-state").then(setActive);
  ipcRenderer.on("agent-open", (_e, open) => setActive(open));

  // next to the sidebar the footer's scan stats rarely fit: cut them with "…" instead of a scrollbar
  // across the footer, and keep the whole line in the tooltip
  const status = document.getElementById("bottom_status");
  status.style.overflow = "hidden";
  status.style.textOverflow = "ellipsis";
  status.style.minWidth = "0";
  new MutationObserver(() => (status.title = status.textContent)).observe(status, { childList: true, characterData: true, subtree: true });

  // the sidebar's header matches the toolbar's height
  const header = document.querySelector("header");
  new ResizeObserver(() => ipcRenderer.send("agent-header", header.getBoundingClientRect().height)).observe(header);

  // right-click on the chart: the hovered item's menu, from the main process
  let menuItem = null;
  window.addEventListener(
    "contextmenu",
    (e) => {
      if (!selection || selection._isOtherFiles || selection._isFreeSpace) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const p = pathOfKeys(window.keys(selection));
      menuItem = { path: p, folder: isFolder(selection), size: format(sizeOf(selection)) };
      ipcRenderer.send("agent-context-menu", { path: p, folder: menuItem.folder });
    },
    true,
  );
  ipcRenderer.on("agent-context-command", (_e, cmd) => {
    if (cmd !== "ask" || !menuItem) return;
    const { path: p, folder, size } = menuItem;
    ipcRenderer.send(
      "agent-ask",
      zh
        ? `${folder ? "文件夹" : "文件"} ${p}（${size}）是什么？删掉它安全吗？拿不准就先查清楚再回答。`
        : `What is the ${folder ? "folder" : "file"} ${p} (${size})? Is it safe to remove? Check before you answer if you are unsure.`,
      zh ? `这是什么：${p}` : `What is ${p}?`,
    );
  });
})();
