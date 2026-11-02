import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, useLiveState, type Ui } from "./api.ts";
import { AdminApp } from "./admin/AdminApp.tsx";
import { AppProvider } from "./context.tsx";
import { Guide } from "./views/Guide.tsx";
import { Rooms } from "./views/Rooms.tsx";
import { Scenes } from "./views/Scenes.tsx";
import { Walls } from "./views/Walls.tsx";
import "./styles.css";

const TABS = [
  { id: "scenes", label: "Scenes", view: Scenes },
  { id: "walls", label: "Video Walls", view: Walls },
  { id: "rooms", label: "Rooms", view: Rooms },
  { id: "guide", label: "TV Guide", view: Guide },
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

  if (loadError) return <p className="empty">Can't reach the control server: {loadError}</p>;
  if (!ui || !state) return <p className="empty">Loading…</p>;

  const View = TABS.find((t) => t.id === tab)!.view;
  const agents = Object.values(state.agents).filter((a) => a.paired);
  const agentsOnline = agents.filter((a) => a.online).length;
  const offline = Object.values(state.devices).filter((d) => !d.online && !d.problem).length;
  const problems = Object.values(state.devices).filter((d) => d.problem && d.problem !== "disabled").length;

  return (
    <AppProvider ui={ui} state={state}>
      <header className="top">
        <h1>{ui.name}</h1>
        <div className="status">
          {ui.simulate && <span className="pill warn">SIMULATION</span>}
          {!connected && <span className="pill bad">Server offline</span>}
          {agents.length > 0 && (
            <span className={`pill ${agentsOnline === agents.length ? "ok" : agentsOnline ? "warn" : "bad"}`}>
              Wall PCs {agentsOnline}/{agents.length}
            </span>
          )}
          {offline > 0 && <span className="pill warn">{offline} offline</span>}
          {problems > 0 && <span className="pill bad">{problems} need setup</span>}
          {state.busy && <span className="pill warn">Running…</span>}
          <a className="pill" href="/admin" title="Set up devices, walls and scenes">⚙ Admin</a>
        </div>
      </header>
      <nav>
        {TABS.map((t) => (
          <a key={t.id} href={`#${t.id}`} className={tab === t.id ? "active" : ""}>
            {t.label}
          </a>
        ))}
      </nav>
      <main>
        <View />
      </main>
    </AppProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>{location.pathname.startsWith("/admin") ? <AdminApp /> : <App />}</StrictMode>,
);
