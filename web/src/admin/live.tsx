import { createContext, useContext, type ReactNode } from "react";
import { type LiveState, useLiveState } from "../api.ts";

// One live-state connection shared by every admin page.
const Ctx = createContext<LiveState | undefined>(undefined);

export function LiveProvider({ children }: { children: ReactNode }) {
  const { state } = useLiveState();
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export const useLive = () => useContext(Ctx);
