import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, useLiveState, type Ui } from "./api.ts";
import { AdminApp } from "./admin/AdminApp.tsx";
import { AppProvider } from "./context.tsx";
import { Audio, audioDevices } from "./views/Audio.tsx";
import { Guide } from "./views/Guide.tsx";
import { Remote } from "./views/Remote.tsx";
import { Rooms } from "./views/Rooms.tsx";
import { Scenes } from "./views/Scenes.tsx";
import { TABS } from "./tabs.ts";
import { Walls } from "./views/Walls.tsx";
import "./styles.css";

const VIEWS = { scenes: Scenes, walls: Walls, rooms: Rooms, audio: Audio, remote: Remote, guide: Guide };

// "#walls/centre" is the Video Walls tab with one wall picked (the view reads the rest).
function readTab() {
  return location.hash.slice(1).split("/")[0];
}

function App() {
  const [ui, setUi] = useState<Ui>();
  const [loadError, setLoadError] = useState<string>();
  const [tab, setTab] = useState(readTab);
  const { state, connected } = useLiveState();

  useEffect(() => {
    api.ui().then(setUi, (err) => setLoadError(err.message));
  }, []);
  // Reload the layout when the server comes back (it may have a new site).
  useEffect(() => {
    if (connected && ui) api.ui().then(setUi, () => {});
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onHash = () => setTab(readTab());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  // A new tab starts at its top, not wherever the last one was scrolled to.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab]);

  if (loadError) return <p className="empty splash">Can't reach the control server: {loadError}</p>;
  if (!ui || !state) return <p className="empty splash">Loading…</p>;

  // The admin can leave menu items off; a link to a hidden one lands on the first that's shown.
  // Audio only appears at a venue that has an audio device.
  const tabs = TABS.filter((t) => !ui.hiddenTabs.includes(t.id) && (t.id !== "audio" || audioDevices(ui).length > 0));
  const current = (tabs.find((t) => t.id === tab) ?? tabs[0] ?? TABS[0]).id;
  const View = VIEWS[current];
  const agents = Object.values(state.agents).filter((a) => a.paired);
  const agentsOnline = agents.filter((a) => a.online).length;
  const offline = Object.values(state.devices).filter((d) => !d.online && !d.problem).length;
  const problems = Object.values(state.devices).filter((d) => d.problem && d.problem !== "disabled").length;

  return (
    <AppProvider ui={ui} state={state}>
      <header className="appbar">
        <h1 className="brand">{ui.name}</h1>
        <nav className="tabbar">
          {tabs.map((t) => (
            <a key={t.id} href={`#${t.id}`} className={current === t.id ? "active" : ""} aria-current={current === t.id ? "page" : undefined}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d={t.icon} /></svg>
              <span>{t.label}</span>
            </a>
          ))}
        </nav>
        <div className="status">
          {ui.simulate && <span className="pill warn">Simulation</span>}
          {!connected && <span className="pill bad">Server offline</span>}
          {agents.length > 0 && (
            <span className={`pill ${agentsOnline === agents.length ? "ok" : agentsOnline ? "warn" : "bad"}`}>
              Wall PCs {agentsOnline}/{agents.length}
            </span>
          )}
          {offline > 0 && <span className="pill warn">{offline} offline</span>}
          {problems > 0 && <span className="pill bad">{problems} need setup</span>}
          {state.busy && <span className="pill warn">Running…</span>}
          <a className="admin-link" href="/admin" title="Set up devices, walls and scenes">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4.500v5M6 14.500v5" /></svg>
            <span>Admin</span>
          </a>
        </div>
      </header>
      <main className="view">
        <View />
      </main>
    </AppProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>{location.pathname.startsWith("/admin") ? <AdminApp /> : <App />}</StrictMode>,
);
