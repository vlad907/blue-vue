// Gives the local connect screen (and nothing loaded from a server) a small
// API for listing, finding and connecting to servers.
const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "file:") {
  const call = async (channel, ...args) => {
    try {
      return await ipcRenderer.invoke(channel, ...args);
    } catch (err) {
      // Electron prefixes "Error invoking remote method '...': Error: ".
      throw new Error(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };
  contextBridge.exposeInMainWorld("bluevue", {
    servers: () => call("servers"),
    connect: (address) => call("connect", address),
    scan: () => call("scan"),
    forget: (url) => call("forget", url),
  });
}
