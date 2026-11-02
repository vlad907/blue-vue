import { useEffect, useState } from "react";
import { adminApi } from "./adminApi.ts";
import { Agents } from "./Agents.tsx";
import { Backup, Settings } from "./Backup.tsx";
import { Channels } from "./Channels.tsx";
import { Devices } from "./Devices.tsx";
import { DraftProvider, SaveBar, useDraft } from "./draft.tsx";
import { Groups, Rooms } from "./Layout.tsx";
import { LiveProvider, useLive } from "./live.tsx";
import { Scenes } from "./Scenes.tsx";
import "./admin.css";

const PAGES = [
  { id: "devices", label: "Devices" },
  { id: "walls", label: "Video walls" },
  { id: "rooms", label: "Rooms" },
  { id: "scenes", label: "Scenes" },
  { id: "channels", label: "Channels" },
  { id: "agents", label: "Wall PCs" },
  { id: "backup", label: "Backup" },
  { id: "settings", label: "Settings" },
] as const;

type Session = { authenticated: boolean; setupRequired: boolean };

export function AdminApp() {
  const [session, setSession] = useState<Session>();
  const [error, setError] = useState<string>();
  const check = () => adminApi.session().then(setSession, (err) => setError(err.message));
  useEffect(() => {
    void check();
  }, []);

  if (error) return <p className="empty">Can't reach the control server: {error}</p>;
  if (!session) return <p className="empty">Loading…</p>;
  if (!session.authenticated) return <SignIn setup={session.setupRequired} onDone={check} />;
  return (
    <LiveProvider>
      <DraftProvider>
        <Shell onSignOut={check} />
      </DraftProvider>
    </LiveProvider>
  );
}

function SignIn({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string>();
  const submit = async () => {
    setError(undefined);
    if (setup && password !== confirm) return setError("The passwords don't match");
    try {
      await (setup ? adminApi.setup(password) : adminApi.login(password));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <form className="signin card" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2>{setup ? "Set the admin password" : "Blue Vue admin"}</h2>
      {setup && <p className="help">This is the first visit. Choose the password for changing devices, walls and scenes. At least 8 characters.</p>}
      <input type="password" autoFocus placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {setup && <input type="password" placeholder="Same password again" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
      {error && <p className="err">{error}</p>}
      <button className="btn primary" type="submit" disabled={!password}>{setup ? "Set password" : "Sign in"}</button>
      <a className="muted" href="/">Back to the touch panel</a>
    </form>
  );
}

function readPage() {
  const p = location.hash.slice(1);
  return PAGES.some((x) => x.id === p) ? p : "devices";
}

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const { site } = useDraft();
  const live = useLive();
  const [page, setPage] = useState(readPage);
  useEffect(() => {
    const onHash = () => setPage(readPage());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const pending = Object.values(live?.agents ?? {}).filter((a) => !a.paired).length;

  return (
    <div className="admin">
      <aside className="sidebar">
        <h1>{site.name}</h1>
        <div className="muted">Admin</div>
        <nav className="sidenav">
          {PAGES.map((p) => (
            <a key={p.id} href={`#${p.id}`} className={page === p.id ? "active" : ""}>
              {p.label}
              {p.id === "agents" && pending > 0 && <span className="badge-count">{pending}</span>}
            </a>
          ))}
        </nav>
        <a className="muted back" href="/">← Touch panel</a>
      </aside>
      <main className="admin-main">
        {page === "devices" && <Devices />}
        {page === "walls" && <Groups />}
        {page === "rooms" && <Rooms />}
        {page === "scenes" && <Scenes />}
        {page === "channels" && <Channels />}
        {page === "agents" && <Agents />}
        {page === "backup" && <Backup />}
        {page === "settings" && <Settings onSignOut={onSignOut} />}
      </main>
      <SaveBar />
    </div>
  );
}
