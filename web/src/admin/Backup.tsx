import { useEffect, useState } from "react";
import { ApiError, adminApi, type NetworkInfo } from "./adminApi.ts";
import { useDraft } from "./draft.tsx";
import { Field, Text } from "./forms.tsx";

export function Backup() {
  const { reload, notice, dirty } = useDraft();
  const [snapshots, setSnapshots] = useState<string[]>([]);
  const refresh = () => adminApi.snapshots().then(setSnapshots, () => {});
  useEffect(() => {
    void refresh();
  }, []);

  const when = (name: string) => {
    // site-2026-11-02T00-17-10-001Z.json
    const m = /site-(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)/.exec(name);
    return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`).toLocaleString() : name;
  };

  return (
    <div className="narrow">
      <h2>Backup</h2>
      <section className="card">
        <h3>Download a backup</h3>
        <p className="help">The whole site plus your custom device profiles, in one file. Keep a copy off this PC.</p>
        <a className="btn primary" href="/api/admin/export" download>Download backup</a>
      </section>

      <section className="card">
        <h3>Restore from a backup file</h3>
        <p className="help">Replaces the current site. The current version is kept as a snapshot below, so you can undo.</p>
        <input
          type="file"
          accept="application/json,.json"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (dirty) return notice("Save or discard your changes first", true);
            if (!confirm(`Replace the site with ${file.name}?`)) return;
            try {
              await adminApi.importBackup(JSON.parse(await file.text()));
              await reload();
              await refresh();
              notice("Backup restored");
            } catch (err) {
              notice(err instanceof Error ? err.message : String(err), true);
            }
          }}
        />
      </section>

      <section className="card">
        <h3>Earlier versions</h3>
        <p className="help">Every save keeps the version before it (the last 50).</p>
        <table className="atable compact">
          <tbody>
            {snapshots.map((s) => (
              <tr key={s}>
                <td>{when(s)}</td>
                <td className="actions">
                  <button
                    className="btn small"
                    onClick={async () => {
                      if (dirty) return notice("Save or discard your changes first", true);
                      if (!confirm(`Go back to the version from ${when(s)}?`)) return;
                      try {
                        await adminApi.restore(s);
                        await reload();
                        await refresh();
                        notice("Restored");
                      } catch (err) {
                        notice(err instanceof Error ? err.message : String(err), true);
                      }
                    }}
                  >
                    Restore
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!snapshots.length && <p className="muted">No earlier versions yet.</p>}
      </section>
    </div>
  );
}

export function Settings({ onSignOut }: { onSignOut: () => void }) {
  const { site, update, notice } = useDraft();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");

  return (
    <div className="narrow">
      <h2>Settings</h2>
      <section className="card">
        <div className="aform">
          <Field label="Venue name" help="Shown at the top of the touch panel.">
            <Text value={site.name} onChange={(v) => update((s) => { s.name = v; return s; })} />
          </Field>
        </div>
      </section>
      <NetworkCards />
      <section className="card">
        <h3>Admin password</h3>
        <div className="aform two">
          <Field label="Current password"><input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
          <Field label="New password" help="At least 8 characters."><input type="password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        </div>
        <button
          className="btn"
          disabled={!current || next.length < 8}
          onClick={() =>
            adminApi.changePassword(current, next).then(
              () => { setCurrent(""); setNext(""); notice("Password changed; other sessions are signed out"); },
              (err) => notice(err.message, true),
            )
          }
        >
          Change password
        </button>
      </section>
      <button className="btn" onClick={() => adminApi.logout().then(onSignOut)}>Sign out</button>
    </div>
  );
}

/**
 * Which of the PC's network cards Blue Vue answers on: every network, or only
 * some (e.g. the AV network, not the office one). Applies right away.
 */
function NetworkCards() {
  const { notice } = useDraft();
  const [info, setInfo] = useState<NetworkInfo>();
  const [chosen, setChosen] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const load = () =>
    adminApi.network().then((i) => {
      setInfo(i);
      setChosen(i.status?.interfaces ?? []);
    }, () => {});
  useEffect(() => {
    void load();
  }, []);
  if (!info) return null;
  if (!info.status) return null; // tests and older setups that don't control listening

  const all = chosen.length === 0;
  const saved = info.status.interfaces;
  const changed = JSON.stringify([...chosen].sort()) !== JSON.stringify([...saved].sort());
  // Cards that are configured but not present right now still show, so they can be unticked.
  const names = [...new Set([...info.nics.map((n) => n.name), ...saved.filter((s) => !info.nics.some((n) => n.name === s || n.addresses.includes(s)))])];

  const save = async (force = false) => {
    setSaving(true);
    try {
      await adminApi.setNetwork(chosen, force);
      notice(all ? "Blue Vue now answers on every network" : `Blue Vue now answers only on ${chosen.join(", ")}`);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && !force && confirm(err.message)) return save(true);
      notice((err as Error).message, true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card">
      <h3>Network cards</h3>
      <p className="help">
        Choose which of this PC's networks panels, laptops and wall PCs reach Blue Vue on (port {info.status.port}). Devices are
        still controlled on whichever network they're on. The PC itself can always open Blue Vue at http://localhost:{info.status.port}.
      </p>
      <label className="acheck">
        <input type="radio" checked={all} onChange={() => setChosen([])} />
        Every network
      </label>
      <label className="acheck">
        <input type="radio" checked={!all} onChange={() => setChosen(all ? [info.nics.find((n) => n.addresses.includes(info.via))?.name ?? info.nics[0]?.name].filter(Boolean) as string[] : chosen)} />
        Only these:
      </label>
      {!all && (
        <div className="nic-list">
          {names.map((name) => {
            const nic = info.nics.find((n) => n.name === name);
            const here = nic?.addresses.includes(info.via);
            return (
              <label key={name} className="acheck">
                <input type="checkbox" checked={chosen.includes(name)} onChange={(e) => setChosen(e.target.checked ? [...chosen, name] : chosen.filter((c) => c !== name))} />
                <b>{name}</b>
                <span className="muted">{nic ? nic.addresses.join(", ") : "not connected now"}</span>
                {here && <span className="pill ok">this browser</span>}
              </label>
            );
          })}
        </div>
      )}
      <p className="help">
        Answering on: {info.status.listening.map((a) => (a === "0.0.0.0" ? "every network" : a)).join(", ") || "nothing"}
        {info.status.problems.map((p) => <span key={p} className="bad-text"><br />{p}</span>)}
      </p>
      <button className="btn" disabled={!changed || saving || (!all && !chosen.length)} onClick={() => void save()}>
        {saving ? "Applying…" : "Apply"}
      </button>
    </section>
  );
}
