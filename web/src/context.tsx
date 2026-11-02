import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import type { LiveState, Ui } from "./api.ts";

interface Toast {
  text: string;
  error: boolean;
}

interface AppContextValue {
  ui: Ui;
  state: LiveState;
  /** Runs an action; shows its error (or `okMessage`) as a toast. */
  act: (fn: () => Promise<unknown>, okMessage?: string) => Promise<void>;
}

const Ctx = createContext<AppContextValue | null>(null);

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}

export function AppProvider({ ui, state, children }: { ui: Ui; state: LiveState; children: ReactNode }) {
  const [toast, setToast] = useState<Toast>();
  const timer = useRef<number>();

  const show = useCallback((text: string, error: boolean) => {
    setToast({ text, error });
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(undefined), error ? 5000 : 2000);
  }, []);

  const act = useCallback(
    async (fn: () => Promise<unknown>, okMessage?: string) => {
      try {
        const result = (await fn()) as { errors?: string[] } | undefined;
        if (result?.errors?.length) show(`Finished with problems: ${result.errors.join("; ")}`, true);
        else if (okMessage) show(okMessage, false);
      } catch (err) {
        show(err instanceof Error ? err.message : String(err), true);
      }
    },
    [show],
  );

  return (
    <Ctx.Provider value={{ ui, state, act }}>
      {children}
      {toast && <div className={`toast${toast.error ? " error" : ""}`}>{toast.text}</div>}
    </Ctx.Provider>
  );
}
