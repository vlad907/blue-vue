// Blue Vue for the Mac: a window onto a Blue Vue server (usually the media
// server), with a connect screen that finds servers on the local network.
// The panel and admin pages come from the server, so the app never needs
// updating when the server does.

const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require("electron");
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { networkInterfaces } = require("node:os");

const DEFAULT_PORT = 8080;
let win;
let current; // { url, name } of the connected server

// --- Settings: known servers and window size, in the app's own folder -------

const settingsFile = () => join(app.getPath("userData"), "settings.json");
function loadSettings() {
  try {
    return { servers: [], ...JSON.parse(readFileSync(settingsFile(), "utf8")) };
  } catch {
    return { servers: [] };
  }
}
function saveSettings(s) {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

/** "10.0.0.5", "10.0.0.5:9000" or "http://media-server:8080/" -> "http://10.0.0.5:8080" */
function normalize(address) {
  let a = String(address).trim();
  if (!a) throw new Error("Enter the server's address");
  if (!/^https?:\/\//i.test(a)) a = `http://${a}`;
  const u = new URL(a);
  if (!u.port && u.protocol === "http:") u.port = String(DEFAULT_PORT);
  return u.origin;
}

/** Asks a server who it is. Resolves to { url, name, version } or throws. */
async function hello(url, timeoutMs = 3000) {
  let res;
  try {
    res = await fetch(`${url}/api/hello`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const why = err.name === "TimeoutError" ? "it didn't answer" : "nothing answered";
    throw new Error(`Couldn't connect to ${url.replace(/^https?:\/\//, "")}: ${why}. Check the address, that the server is on, and that this Mac is on the same network.`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.app !== "blue-vue") throw new Error("That address answers, but it isn't a Blue Vue server");
  return { url, name: body.name, version: body.version };
}

// --- Finding servers on the local network ------------------------------------

/** Every address on this Mac's private IPv4 networks (each as a /24), probed on port 8080. */
async function scan() {
  const prefixes = new Set();
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ni.address)) continue;
      prefixes.add(ni.address.split(".").slice(0, 3).join("."));
    }
  }
  const targets = [];
  for (const p of prefixes) for (let i = 1; i < 255; i++) targets.push(`http://${p}.${i}:${DEFAULT_PORT}`);
  const found = [];
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const url = targets[next++];
      try {
        found.push(await hello(url, 800));
      } catch {
        // nothing there
      }
    }
  };
  await Promise.all(Array.from({ length: 64 }, worker));
  return { found, networks: [...prefixes].map((p) => `${p}.x`) };
}

// --- Windows -----------------------------------------------------------------

function createWindow() {
  const s = loadSettings();
  win = new BrowserWindow({
    width: s.bounds?.width ?? 1280,
    height: s.bounds?.height ?? 820,
    x: s.bounds?.x,
    y: s.bounds?.y,
    minWidth: 380,
    minHeight: 500,
    backgroundColor: "#0b1220",
    title: "Blue Vue",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.on("close", () => {
    const st = loadSettings();
    st.bounds = win.getBounds();
    saveSettings(st);
  });

  // Links to other sites open in the browser; the window stays on the server.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file:")) return;
    if (current && url.startsWith(current.url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !current || !url.startsWith(current.url)) return; // -3: navigation replaced
    showConnect(`Couldn't reach ${current.name ?? current.url} (${desc}). Is the server on and on this network?`);
  });
  win.webContents.on("page-title-updated", (e) => {
    e.preventDefault();
    win.setTitle(current ? `Blue Vue · ${current.name}` : "Blue Vue");
  });
}

function showConnect(error) {
  current = undefined;
  win.setTitle("Blue Vue");
  win.loadFile(join(__dirname, "connect.html"), { query: error ? { error } : {} });
  buildMenu();
}

function open(server, path = "/") {
  current = server;
  win.setTitle(`Blue Vue · ${server.name}`);
  win.loadURL(server.url + path);
  buildMenu();
}

async function connect(address) {
  const server = await hello(normalize(address));
  const s = loadSettings();
  s.servers = [server, ...s.servers.filter((x) => x.url !== server.url)].slice(0, 10);
  s.last = server.url;
  saveSettings(s);
  open(server);
  return server;
}

function buildMenu() {
  const connected = !!current;
  const template = [
    { role: "appMenu" },
    {
      label: "Server",
      submenu: [
        { label: "Control Panel", accelerator: "CmdOrCtrl+1", enabled: connected, click: () => open(current, "/") },
        { label: "Admin", accelerator: "CmdOrCtrl+2", enabled: connected, click: () => open(current, "/admin") },
        { type: "separator" },
        { label: "Switch Server…", accelerator: "CmdOrCtrl+K", click: () => showConnect() },
        {
          label: "Open in Browser",
          enabled: connected,
          click: () => shell.openExternal(win.webContents.getURL()),
        },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        ...(app.isPackaged ? [] : [{ type: "separator" }, { role: "toggleDevTools" }]),
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Connect screen API (only the local connect page has the preload's bridge) --

const fromConnectPage = (e) => e.senderFrame?.url.startsWith("file:");
const guard = (fn) => async (e, ...args) => {
  if (!fromConnectPage(e)) throw new Error("not allowed");
  return fn(...args);
};
ipcMain.handle("servers", guard(async () => loadSettings().servers));
ipcMain.handle("connect", guard(async (address) => connect(address)));
ipcMain.handle("scan", guard(async () => scan()));
ipcMain.handle("forget", guard(async (url) => {
  const s = loadSettings();
  s.servers = s.servers.filter((x) => x.url !== url);
  if (s.last === url) delete s.last;
  saveSettings(s);
  return s.servers;
}));

// --- Start ---------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    createWindow();
    buildMenu();
    const s = loadSettings();
    const last = s.servers.find((x) => x.url === s.last);
    if (!last) return showConnect();
    try {
      open(await hello(last.url, 2500));
    } catch (err) {
      showConnect(err.message);
    }
  });

  app.on("window-all-closed", () => app.quit());
  process.on("uncaughtException", (err) => dialog.showErrorBox("Blue Vue", err.stack ?? String(err)));
}
