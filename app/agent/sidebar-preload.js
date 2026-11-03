"use strict";
// The only door between the sidebar page (sandboxed, no Node) and Space Radar's main process:
// the divider's width, opening and closing the sidebar, and messages from the chart.
const { contextBridge, ipcRenderer } = require("electron");

const listen = (channel) => (cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args));

contextBridge.exposeInMainWorld("spaceRadar", {
  setWidth: (width, done) => ipcRenderer.send("agent-width", Number(width), !!done),
  close: () => ipcRenderer.send("agent-toggle", false),
  ask: (prompt, shown) => ipcRenderer.send("agent-ask", String(prompt), String(shown)),
  onAsk: listen("ask"),
  onScanned: listen("scanned"),
  onTheme: listen("theme"),
  onHeader: listen("header"),
});
