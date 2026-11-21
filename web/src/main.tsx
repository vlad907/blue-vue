import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, useLiveState, type Ui } from "./api.ts";
import { AdminApp } from "./admin/AdminApp.tsx";
import { AppProvider } from "./context.tsx";
import { Guide } from "./views/Guide.tsx";
import { Remote } from "./views/Remote.tsx";
import { Rooms } from "./views/Rooms.tsx";
import { Scenes } from "./views/Scenes.tsx";
import { Walls } from "./views/Walls.tsx";
import "./styles.css";

// Each tab's icon is the `d` of one 24x24 stroked path.
const TABS = [
  { id: "scenes", label: "Scenes", view: Scenes, icon: "M12 3l2.3 6.2L20.5 11.5l-6.2 2.3L12 20l-2.3-6.2L3.5 11.5l6.2-2.3z" },
  { id: "walls", label: "Video Walls", view: Walls, icon: "M3 5h18v13H3zM12 5v13M3 11.5h18" },
  { id: "rooms", label: "Rooms", view: Rooms, icon: "M4 11l8-6.5 8 6.5v8.5H4zM10 19.5v-5h4v5" },
  { id: "remote", label: "Remote", view: Remote, icon: "M9 2.5h6a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.500 20V4A1.5 1.5 0 0 1 9 2.500zM12 6.500v3M10.500 8h3M10.500 14h.01M13.500 14h.01M10.500 17.500h.01M13.500 17.500h.01" },
  { id: "guide", label: "TV Guide", view: Guide, icon: "M3 5h18v14H3zM3 10h18M9 10v9M3 14.500h18" },
] as const;

function readTab() {
  const t = location.hash.slice(1);
  return TABS.some((x) => x.id === t) ? t : "scenes";
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

  const View = TABS.find((t) => t.id === tab)!.view;
  const agents = Object.values(state.agents).filter((a) => a.paired);
  const agentsOnline = agents.filter((a) => a.online).length;
  const offline = Object.values(state.devices).filter((d) => !d.online && !d.problem).length;
  const problems = Object.values(state.devices).filter((d) => d.problem && d.problem !== "disabled").length;

  return (
    <AppProvider ui={ui} state={state}>
      <header className="appbar">
        <h1 className="brand">{ui.name}</h1>
        <nav className="tabbar">
          {TABS.map((t) => (
            <a key={t.id} href={`#${t.id}`} className={tab === t.id ? "active" : ""} aria-current={tab === t.id ? "page" : undefined}>
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
