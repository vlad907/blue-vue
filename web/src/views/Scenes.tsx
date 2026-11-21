import { api } from "../api.ts";
import { useApp } from "../context.tsx";

export function Scenes() {
  const { ui, state, act } = useApp();
  if (!ui.scenes.length) return <p className="empty">No scenes yet. Build them in the admin.</p>;
  return (
    <div className="scenes">
      {ui.scenes.map((s) => {
        const active = state.activeScene === s.id;
        return (
          <button key={s.id} className={`scene${active ? " active" : ""}`} disabled={state.busy} onClick={() => act(() => api.scene(s.id), `${s.name} done`)}>
            <b>{s.name}</b>
            {s.description && <small>{s.description}</small>}
            {active && <span className="pill ok">Active</span>}
          </button>
        );
      })}
    </div>
  );
}
