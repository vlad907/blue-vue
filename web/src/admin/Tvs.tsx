import { useMemo, useState } from "react";
import { adminApi, slugify, type FoundTv, type SiteDevice } from "./adminApi.ts";
import { useDraft } from "./draft.tsx";
import { Field, Pick, Text } from "./forms.tsx";
import { useLive } from "./live.tsx";

// Setting up many TVs at once: find them on the network (or type their
// addresses), add them in one go, then pair each from one checklist.

const NEW_WALL = "__new__";

/** "192.168.1.145-164", "192.168.1.170" and lists of them -> addresses. */
export function parseAddresses(text: string): { hosts: string[]; bad: string[] } {
  const hosts: string[] = [];
  const bad: string[] = [];
  for (const part of text.split(/[\s,;]+/).filter(Boolean)) {
    const m = part.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})(?:-(\d{1,3}))?$/);
    const from = m ? Number(m[2]) : NaN;
    const to = m?.[3] ? Number(m[3]) : from;
    if (!m || from > 255 || to > 255 || to < from || to - from > 254) bad.push(part);
    else for (let i = from; i <= to; i++) hosts.push(`${m[1]}.${i}`);
  }
  return { hosts: [...new Set(hosts)], bad };
}

const rank = (p: { discover?: string }) => (p.discover === "androidtv" ? 2 : p.discover ? 1 : 0);
const KIND_LABEL: Record<string, string> = { appletv: "Apple TV", androidtv: "Google TV", roku: "Roku TV", adb: "Fire TV / Android with network debugging on" };

export function AddTvs({ onClose }: { onClose: () => void }) {
  const { site, update, profiles, notice } = useDraft();
  const remoteProfiles = useMemo(
    // Ones that can be found on the network first, Google TV remote first of those.
    () => Object.values(profiles).filter((p) => p.category === "display").sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name)),
    [profiles],
  );
  const [profile, setProfile] = useState(remoteProfiles[0]?.id);
  const kind = profile ? profiles[profile]?.discover : undefined;
  const [location, setLocation] = useState("server");
  const [mode, setMode] = useState<"scan" | "type">("scan");
  const [subnet, setSubnet] = useState("");
  const [typed, setTyped] = useState("");
  const [found, setFound] = useState<FoundTv[]>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string>();
  const [naming, setNaming] = useState<"tv" | "pattern">("pattern");
  const [pattern, setPattern] = useState("TV {n}");
  // Carry on after the highest "TV n" already in the site.
  const [start, setStart] = useState(() => 1 + Math.max(0, ...site.devices.map((d) => Number(d.name.match(/^TV (\d+)$/)?.[1] ?? 0))));
  const [room, setRoom] = useState<string>();
  const [wall, setWall] = useState<string>();
  const [wallName, setWallName] = useState("");

  const usedHosts = new Map(site.devices.map((d) => [String(d.settings.host ?? ""), d.name]));
  const typedResult = parseAddresses(typed);
  const scanMode = mode === "scan" && !!kind;
  const chosen: FoundTv[] =
    scanMode ? (found ?? []).filter((t) => picked.has(t.host)) : typedResult.hosts.filter((h) => !usedHosts.has(h)).map((host) => ({ host }));
  const skipped = !scanMode ? typedResult.hosts.filter((h) => usedHosts.has(h)) : [];

  const scan = async () => {
    setScanning(true);
    setScanNote(undefined);
    try {
      const r = await adminApi.discoverTvs(location, kind!, subnet || undefined);
      setFound(r.found);
      setPicked(new Set(r.found.filter((t) => !t.existing && !usedHosts.has(t.host)).map((t) => t.host)));
      setScanNote(
        `${r.found.length} found${r.subnets.length ? ` on ${r.subnets.map((s) => `${s}.x`).join(", ")}` : ""}${r.simulated ? " (simulated)" : ""}.` +
          (r.found.length ? "" : " Check the TVs are on and on this network, or type their addresses instead."),
      );
    } catch (err) {
      setScanNote((err as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const add = () => {
    const prof = profiles[profile!];
    update((s) => {
      const taken = s.devices.map((d) => d.id);
      const added: SiteDevice[] = chosen.map((tv, i) => {
        const name = scanMode && naming === "tv" && tv.name ? tv.name : pattern.replace("{n}", String(start + i));
        const id = slugify(name, taken);
        taken.push(id);
        const settings: Record<string, unknown> = { host: tv.host };
        if (tv.mac && prof.settings.some((f) => f.key === "mac")) settings.mac = tv.mac;
        return { id, name, profile: prof.id, location, room, enabled: true, settings };
      });
      s.devices.push(...added);
      const ids = added.map((d) => d.id);
      if (wall === NEW_WALL && wallName.trim()) {
        s.groups.push({ id: slugify(wallName, s.groups.map((g) => g.id)), name: wallName.trim(), kind: "wall", devices: ids, staggerMs: 250 });
      } else if (wall) {
        const g = s.groups.find((x) => x.id === wall);
        if (g) g.devices.push(...ids);
      }
      return s;
    });
    const next = ["androidtv", "appletv"].includes(prof.transport.type) ? ", then pair them on the TV pairing page" : prof.transport.type === "adb" ? `, then press Allow on each TV's "Allow debugging" prompt` : "";
    notice(`Added ${chosen.length} TVs. Press Save & apply${next}.`);
    onClose();
  };

  const allPicked = found?.filter((t) => !t.existing).every((t) => picked.has(t.host));
  return (
    <aside className="drawer wide">
      <div className="row-between">
        <h2>Add TVs</h2>
        <button className="icon" onClick={onClose}>✕</button>
      </div>
      <div className="aform">
        <Field label="Device type">
          <Pick value={profile} options={remoteProfiles.map((p) => ({ value: p.id, label: p.name }))} onChange={(p) => { setProfile(p); setFound(undefined); setScanNote(undefined); }} />
        </Field>
        <Field label="Reached from" help="The machine on the TVs' network. Pairing and control run from there.">
          <Pick value={location} options={[{ value: "server", label: "Control server" }, ...site.agents.map((a) => ({ value: a.id, label: a.name }))]} onChange={(l) => { setLocation(l); setFound(undefined); }} />
        </Field>
      </div>

      <div className="seg">
        <button className={scanMode ? "active" : ""} disabled={!kind} title={kind ? "" : "This device type can't be found automatically"} onClick={() => setMode("scan")}>Find on the network</button>
        <button className={!scanMode ? "active" : ""} onClick={() => setMode("type")}>Type addresses</button>
      </div>

      {scanMode ? (
        <>
          <div className="row-tight">
            <Text value={subnet} onChange={setSubnet} placeholder="Network, e.g. 192.168.1 (blank: all of this machine's)" />
            <button className="btn" disabled={scanning} onClick={scan}>{scanning ? "Searching…" : "Find TVs"}</button>
          </div>
          {scanNote && <p className="help">{scanNote}</p>}
          {found && found.length > 0 && (
            <table className="atable compact">
              <thead>
                <tr>
                  <th>
                    <input type="checkbox" checked={!!allPicked} onChange={(e) => setPicked(new Set(e.target.checked ? found.filter((t) => !t.existing).map((t) => t.host) : []))} />
                  </th>
                  <th>Address</th><th>TV</th>
                </tr>
              </thead>
              <tbody>
                {found.map((t) => {
                  const existing = t.existing ? site.devices.find((d) => d.id === t.existing)?.name ?? t.existing : usedHosts.get(t.host);
                  return (
                    <tr key={t.host} className={existing ? "muted" : ""}>
                      <td>
                        <input
                          type="checkbox"
                          disabled={!!existing}
                          checked={picked.has(t.host)}
                          onChange={(e) => {
                            const next = new Set(picked);
                            if (e.target.checked) next.add(t.host);
                            else next.delete(t.host);
                            setPicked(next);
                          }}
                        />
                      </td>
                      <td className="mono">{t.host}</td>
                      <td>{existing ? `already added as ${existing}` : [t.name, t.model].filter(Boolean).join(" · ") || KIND_LABEL[kind!]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      ) : (
        <Field label="Addresses" help="One per line, or ranges like 192.168.1.145-164">
          <textarea className="mono" rows={4} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={"192.168.1.145-164"} />
          {typedResult.bad.length > 0 && <span className="bad-text">Not an address: {typedResult.bad.join(", ")}</span>}
          {skipped.length > 0 && <span className="help">Already added, skipped: {skipped.join(", ")}</span>}
        </Field>
      )}

      <h3 className="section">Names and placement</h3>
      <div className="aform">
        {scanMode && (
          <Field label="Names">
            <Pick value={naming} options={[{ value: "pattern", label: "Numbered" }, { value: "tv", label: "The name each TV reports" }]} onChange={setNaming} />
          </Field>
        )}
        {(naming === "pattern" || !scanMode) && (
          <div className="aform two">
            <Field label="Name pattern" help="{n} becomes the number"><Text value={pattern} onChange={setPattern} /></Field>
            <Field label="First number"><input type="number" min={0} value={start} onChange={(e) => setStart(Number(e.target.value) || 0)} /></Field>
          </div>
        )}
        <Field label="Room">
          <Pick value={room} empty="No room" options={site.rooms.map((r) => ({ value: r.id, label: r.name }))} onChange={(r) => setRoom(r || undefined)} />
        </Field>
        <Field label="Video wall" help="You can move TVs between walls later on the Video walls page.">
          <Pick
            value={wall}
            empty="Not in a wall yet"
            options={[...site.groups.filter((g) => g.kind === "wall").map((g) => ({ value: g.id, label: g.name })), { value: NEW_WALL, label: "+ New wall…" }]}
            onChange={(w) => setWall(w || undefined)}
          />
        </Field>
        {wall === NEW_WALL && <Field label="New wall name"><Text value={wallName} onChange={setWallName} placeholder="e.g. Main bar wall" /></Field>}
      </div>

      <div className="row-tight drawer-actions">
        <span className="grow muted">{chosen.length ? `${chosen.length} TVs, e.g. ${(naming === "tv" && chosen[0].name) || pattern.replace("{n}", String(start))}` : "No TVs chosen"}</span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!chosen.length || !profile || (wall === NEW_WALL && !wallName.trim()) || (naming === "pattern" && !pattern.includes("{n}") && chosen.length > 1)} onClick={add}>
          Add {chosen.length || ""} TVs
        </button>
      </div>
      {naming === "pattern" && !pattern.includes("{n}") && chosen.length > 1 && <p className="help bad-text">Put {"{n}"} in the pattern so each TV gets its own name.</p>}
    </aside>
  );
}

// --- Pairing -------------------------------------------------------------------

type Phase = "idle" | "starting" | "code" | "sending";

/** Pair-with-code flow for one saved device. An Apple TV's code is 4 digits and it asks for two in a row. */
export function usePairing(id: string, onPaired?: () => void, appleTv = false) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const step = async (fn: () => Promise<unknown>, busy: Phase, ok: Phase, failed: Phase) => {
    setError(undefined);
    setPhase(busy);
    try {
      await fn();
      setPhase(ok);
      return true;
    } catch (err) {
      setError((err as Error).message);
      setPhase(failed);
      return false;
    }
  };
  return {
    phase, code, setCode, error, note,
    length: appleTv ? 4 : 6,
    start: async () => {
      setNote(undefined);
      let done = false;
      // An Apple TV that's already paired has no code to show.
      if (await step(async () => { done = (await adminApi.pair(id, "start")).done === true && appleTv; }, "starting", "code", "idle") && done) {
        setPhase("idle");
        onPaired?.();
      }
    },
    finish: async () => {
      let more = false;
      let message: string | undefined;
      if (await step(async () => { const r = await adminApi.pair(id, "finish", code); more = r.more === true; message = r.message; }, "sending", "idle", appleTv ? "idle" : "code")) {
        setCode("");
        setNote(message);
        if (more) setPhase("code"); // the second code is on screen now
        else onPaired?.();
      } else if (appleTv) setCode(""); // a refused code ends that pairing on the Apple TV: back to the Pair button
    },
    cancel: () => {
      void adminApi.pair(id, "cancel").catch(() => {});
      setPhase("idle");
      setCode("");
      setError(undefined);
      setNote(undefined);
    },
  };
}

/** Start button, then the code box. */
export function PairControls({ p, startLabel = "Pair" }: { p: ReturnType<typeof usePairing>; startLabel?: string }) {
  if (p.phase === "idle" || p.phase === "starting") {
    return (
      <button className="btn small" disabled={p.phase === "starting"} onClick={() => void p.start()}>
        {p.phase === "starting" ? "Asking the TV…" : startLabel}
      </button>
    );
  }
  return (
    <form className="row-tight pair-code" onSubmit={(e) => { e.preventDefault(); void p.finish(); }}>
      <input className="mono" type="text" maxLength={p.length} autoFocus placeholder="Code on TV" value={p.code} onChange={(e) => p.setCode(e.target.value.toUpperCase())} />
      <button className="btn small primary" type="submit" disabled={p.code.length !== p.length || p.phase === "sending"}>{p.phase === "sending" ? "Pairing…" : "Pair"}</button>
      <button className="btn small" type="button" onClick={p.cancel}>Cancel</button>
    </form>
  );
}

/** Every remote-controlled TV with its connection state, pairable from one list. */
export function Pairing() {
  const { site, profiles, dirty } = useDraft();
  const live = useLive();
  const tvs = site.devices.filter((d) => ["androidtv", "adb", "appletv"].includes(profiles[d.profile]?.transport.type ?? ""));
  const wallOf = (id: string) => site.groups.find((g) => g.kind === "wall" && g.devices.includes(id))?.name;
  const connected = tvs.filter((d) => live?.devices[d.id]?.online).length;

  return (
    <div>
      <h2>TV pairing</h2>
      <p className="help">
        Each Google TV pairs once: press Pair, read the 6-character code off that TV and type it in. An Apple TV shows a 4-digit code,
        then a second one: type in both. Fire TVs and other ADB devices ask on
        their own screen instead: tick “Always allow” and press Allow. A TV that's connected is paired.
        {dirty && " Save & apply first so newly added TVs appear here as live."}
      </p>
      {tvs.length > 0 && <p><b>{connected}</b> of {tvs.length} connected</p>}
      <table className="atable">
        <thead>
          <tr><th>TV</th><th>Address</th><th>Wall</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {tvs.map((d) => <PairRow key={d.id} device={d} wall={wallOf(d.id)} />)}
        </tbody>
      </table>
      {!tvs.length && <p className="empty">No Google TVs, Apple TVs or Fire TVs yet. Add them on the Devices page with + Add TVs.</p>}
    </div>
  );
}

function PairRow({ device: d, wall }: { device: SiteDevice; wall?: string }) {
  const live = useLive();
  const { notice, profiles } = useDraft();
  const adb = profiles[d.profile]?.transport.type === "adb";
  const view = live?.devices[d.id];
  const p = usePairing(d.id, () => notice(`${d.name} paired`), profiles[d.profile]?.transport.type === "appletv");
  const status = !view ? "not saved yet" : view.online ? "connected" : view.error ?? "offline";
  return (
    <tr>
      <td><b>{d.name}</b></td>
      <td className="mono">{String(d.settings.host ?? "")}</td>
      <td>{wall ?? <span className="muted">none</span>}</td>
      <td>
        <span className={`pill ${!view ? "" : view.online ? "ok" : "warn"}`} title={status}>{status.length > 40 ? status.slice(0, 40) + "…" : status}</span>
        {p.error && <div className="bad-text">{p.error}</div>}
        {p.note && !p.error && <div className="help">{p.note}</div>}
      </td>
      <td className="actions">
        {view && !adb && <PairControls p={p} startLabel={view.online ? "Pair again" : "Pair"} />}
        {view && adb && !view.online && <span className="muted">Press Allow on the TV</span>}
      </td>
    </tr>
  );
}
