import type { Touch } from "../api.ts";
import { TABS } from "../tabs.ts";
import { useDraft } from "./draft.tsx";
import { Check } from "./forms.tsx";
import { useLive } from "./live.tsx";

// What staff see on the touch panel: which menu items, which mosaic canvases
// and walls, and which splits each wall offers. Hiding something only takes it
// off the panel; scenes can still use it.

interface LiveWall { id: string; name?: string; arrangements?: { id: string; name: string; slots: number }[] }

/** Drops settings that say nothing, so the saved site only holds real choices. */
function tidy(t: Touch): Touch | undefined {
  const walls = Object.fromEntries(
    Object.entries(t.walls ?? {})
      .map(([id, w]) => [id, { ...(w.hidden ? { hidden: true } : {}), ...(w.splits ? { splits: w.splits } : {}) }] as const)
      .filter(([, w]) => Object.keys(w).length),
  );
  const out: Touch = { ...(t.hidden ? { hidden: true } : {}), ...(Object.keys(walls).length ? { walls } : {}) };
  return Object.keys(out).length ? out : undefined;
}

export function TouchPanel() {
  const { site, update, dirty } = useDraft();
  const live = useLive();
  const hiddenTabs = new Set(site.hiddenTabs ?? []);
  const canvases = site.devices.filter((d) => d.profile === "mosaic-engine");

  const showTab = (id: string, on: boolean) =>
    update((s) => {
      const next = new Set(s.hiddenTabs ?? []);
      if (on) next.delete(id);
      else next.add(id);
      if (next.size) s.hiddenTabs = TABS.map((t) => t.id).filter((t) => next.has(t));
      else delete s.hiddenTabs;
      return s;
    });
  const change = (deviceId: string, fn: (t: Touch) => void) =>
    update((s) => {
      const d = s.devices.find((x) => x.id === deviceId);
      if (!d) return s;
      const t: Touch = structuredClone(d.touch ?? {});
      fn(t);
      const next = tidy(t);
      if (next) d.touch = next;
      else delete d.touch;
      return s;
    });
  const wall = (t: Touch, id: string) => ((t.walls ??= {})[id] ??= {});

  return (
    <div>
      <h2>Touch panel</h2>
      <p className="help">
        Choose what staff see on the touch panel. Anything hidden here still works in scenes; it just isn't offered on the panel.
        {dirty && <b> Press Save &amp; apply to put changes on the touch panel.</b>}
      </p>

      <section className="card">
        <h3>Menu</h3>
        <p className="help">Untick the parts this venue doesn't use.</p>
        <div className="source-ticks">
          {TABS.map((t) => (
            <Check key={t.id} value={!hiddenTabs.has(t.id)} label={t.label} onChange={(on) => (on || hiddenTabs.size < TABS.length - 1) && showTab(t.id, on)} />
          ))}
        </div>
        {hiddenTabs.size === TABS.length - 1 && <p className="help">At least one menu item stays on.</p>}
      </section>

      {!canvases.length && <p className="empty">No mosaic engine yet. Add it on Devices (+ Add mosaic engine) to choose its canvases, walls and splits here.</p>}
      {canvases.map((c) => {
        const list = live?.devices[c.id]?.state.groupList;
        const reported: LiveWall[] = Array.isArray(list) ? (list as LiveWall[]) : [];
        // Walls with saved choices stay listed while the engine isn't reporting them.
        const rows: (LiveWall & { missing?: boolean })[] = [
          ...reported,
          ...Object.keys(c.touch?.walls ?? {}).filter((id) => !reported.some((w) => w.id === id)).map((id) => ({ id, missing: true })),
        ];
        const shown = !c.touch?.hidden;
        return (
          <section className="card" key={c.id}>
            <div className="row-between">
              <h3>{c.name}</h3>
              <span className="muted">{shown ? `${rows.filter((w) => !c.touch?.walls?.[w.id]?.hidden).length} of ${rows.length} wall${rows.length === 1 ? "" : "s"} shown` : "Hidden"}</span>
            </div>
            <div className="row-tight">
              <Check value={shown} label="Show this canvas on the touch panel" onChange={(on) => change(c.id, (t) => { t.hidden = !on; })} />
            </div>
            {shown && rows.map((w) => {
              const saved = c.touch?.walls?.[w.id];
              const all = (w.arrangements ?? []).map((a) => a.id);
              const ticked = new Set(saved?.splits ?? all);
              const toggle = (id: string, on: boolean) =>
                change(c.id, (t) => {
                  const next = new Set(ticked);
                  if (on) next.add(id);
                  else next.delete(id);
                  if (!next.size) return; // a wall always keeps one split
                  // Everything ticked means "all, including new ones": nothing to store.
                  wall(t, w.id).splits = all.every((a) => next.has(a)) ? undefined : [...new Set([...all, ...(saved?.splits ?? [])])].filter((a) => next.has(a));
                });
              return (
                <div className="source-group" key={w.id}>
                  <div className="row-tight">
                    <Check value={!saved?.hidden} label={w.name ?? w.id} onChange={(on) => change(c.id, (t) => { wall(t, w.id).hidden = !on; })} />
                    {w.missing && <span className="muted">not reported by the media server right now</span>}
                    {w.missing && <button className="btn small" onClick={() => change(c.id, (t) => { delete t.walls?.[w.id]; })}>Forget</button>}
                  </div>
                  {!saved?.hidden && all.length > 0 && (
                    <>
                      <div className="muted">Splits staff can choose</div>
                      <div className="source-ticks">
                        {w.arrangements!.map((a) => (
                          <Check key={a.id} value={ticked.has(a.id)} label={`${a.name} (${a.slots} piece${a.slots === 1 ? "" : "s"})`} onChange={(on) => toggle(a.id, on)} />
                        ))}
                      </div>
                      {ticked.size === 1 && <p className="help">With one split ticked, staff don't get a split choice on this wall.</p>}
                    </>
                  )}
                </div>
              );
            })}
            {shown && !rows.length && <p className="muted">The media server isn't reporting any walls for this canvas right now.</p>}
          </section>
        );
      })}
    </div>
  );
}
