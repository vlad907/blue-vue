import { api } from "../api.ts";
import { useApp } from "../context.tsx";

export function Scenes() {
  const { ui, state, act } = useApp();
  if (!ui.scenes.length) return <p className="empty">No scenes yet. Build them in the admin.</p>;
  return (
    <div className="tiles big">
      {ui.scenes.map((s) => (
        <button
          key={s.id}
          className={`tile${state.activeScene === s.id ? " active" : ""}`}
          disabled={state.busy}
          onClick={() => act(() => api.scene(s.id), `${s.name} done`)}
        >
          {s.name}
          {s.description && <small>{s.description}</small>}
        </button>
      ))}
    </div>
  );
}
