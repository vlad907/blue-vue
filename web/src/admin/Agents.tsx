import { useState } from "react";
import { adminApi, slugify } from "./adminApi.ts";
import { useDraft } from "./draft.tsx";
import { Text } from "./forms.tsx";
import { useLive } from "./live.tsx";

export function Agents() {
  const { site, update, reload, notice, dirty } = useDraft();
  const live = useLive();
  const [shownToken, setShownToken] = useState<{ id: string; token: string }>();
  const [names, setNames] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const pending = Object.entries(live?.agents ?? {}).filter(([, a]) => !a.paired);

  // These actions save on the server directly, so they need a clean draft.
  const direct = async (fn: () => Promise<unknown>, ok: string) => {
    if (dirty) return notice("Save or discard your other changes first", true);
    try {
      await fn();
      await reload();
      notice(ok);
    } catch (err) {
      notice(err instanceof Error ? err.message : String(err), true);
    }
  };

  return (
    <div className="narrow">
      <h2>Wall PCs</h2>
      <p className="help">
        Each video wall PC runs the Blue Vue agent, which connects out to this server. Devices set to be "reached from" a wall PC are controlled through it.
      </p>

      {pending.length > 0 && (
        <section className="card attention">
          <h3>Waiting for approval</h3>
          {pending.map(([id, a]) => (
            <div key={id} className="row-between">
              <div>
                <b>{id}</b> <span className="muted">from {a.host ?? "unknown"} · {a.error}</span>
              </div>
              <div className="row-tight">
                <Text value={names[id] ?? ""} onChange={(v) => setNames({ ...names, [id]: v })} placeholder="Name, e.g. Patio wall PC" />
                <button className="btn primary" onClick={() => direct(() => adminApi.approveAgent(id, names[id] || id), `${id} approved; it connects within 10 seconds`)}>Approve</button>
                <button className="btn" onClick={() => direct(() => adminApi.dismissAgent(id), `Dismissed ${id}`)}>Dismiss</button>
              </div>
            </div>
          ))}
          <p className="help">Only approve PCs you recognize. Approving trusts the token the PC presented.</p>
        </section>
      )}

      <table className="atable">
        <thead>
          <tr><th>Name</th><th>Status</th><th>Wall software</th><th>Devices</th><th /></tr>
        </thead>
        <tbody>
          {site.agents.map((a, i) => {
            const st = live?.agents[a.id];
            const used = site.devices.filter((d) => d.location === a.id).length;
            return (
              <tr key={a.id}>
                <td>
                  <Text value={a.name} onChange={(v) => update((s) => { s.agents[i].name = v; return s; })} />
                  <div className="muted">id: {a.id}</div>
                </td>
                <td>
                  <span className={`pill ${st?.online ? "ok" : "bad"}`}>{st?.online ? "online" : "offline"}</span>
                  {st?.host && <div className="muted">{st.host}</div>}
                </td>
                <td>{st?.apps?.length ? st.apps.map((app) => <div key={app.name}>{app.name}: {app.running ? "running" : "stopped"}</div>) : <span className="muted">—</span>}</td>
                <td>{used}</td>
                <td className="actions">
                  <button
                    className="btn small"
                    onClick={() =>
                      confirm(`Make a new token for ${a.name}? The PC disconnects until you put the new token in its agent.json.`) &&
                      direct(async () => setShownToken({ id: a.id, ...(await adminApi.newToken(a.id)) }), "New token created")
                    }
                  >
                    New token
                  </button>
                  <button
                    className="btn small danger"
                    disabled={used > 0}
                    title={used ? "Move its devices to another location first" : ""}
                    onClick={() => update((s) => { s.agents.splice(i, 1); return s; })}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {shownToken && (
        <section className="card attention">
          <h3>New token for {shownToken.id}</h3>
          <p>Put this in that PC's <code>agent.json</code> as <code>"token"</code>, then restart the agent. It won't be shown again.</p>
          <pre className="state">{shownToken.token}</pre>
          <button className="btn" onClick={() => { void navigator.clipboard?.writeText(shownToken.token); notice("Copied"); }}>Copy</button>
          <button className="btn" onClick={() => setShownToken(undefined)}>Done</button>
        </section>
      )}

      <h3 className="section">Add a wall PC by hand</h3>
      <p className="help">Usually easier: install the agent on the PC, then approve it above when it shows up.</p>
      <div className="row-tight">
        <Text value={newName} onChange={setNewName} placeholder="Name, e.g. Patio wall PC" />
        <button
          className="btn"
          disabled={!newName.trim()}
          onClick={() => {
            update((s) => { s.agents.push({ id: slugify(newName, s.agents.map((a) => a.id)), name: newName.trim() }); return s; });
            setNewName("");
            notice("Added. Save, then use New token to get its token.");
          }}
        >
          + Add
        </button>
      </div>
    </div>
  );
}
