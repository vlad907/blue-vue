import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, adminApi, type Profile, type ProfileEntry, type Site } from "./adminApi.ts";

// Admin edits go into a draft copy of the site. Nothing changes on the
// devices until Save, which validates the whole site on the server and
// applies it live. Two admins can't silently overwrite each other: the server
// rejects a save based on an outdated copy.

interface DraftValue {
  site: Site;
  update: (fn: (site: Site) => Site) => void;
  dirty: boolean;
  saving: boolean;
  problems: string[];
  conflict: boolean;
  save: () => Promise<boolean>;
  discard: () => void;
  reload: () => Promise<void>;
  /** Re-fetches profiles only, keeping unsaved site edits. */
  reloadProfiles: () => Promise<void>;
  profiles: Record<string, Profile>;
  profileEntries: ProfileEntry[];
  notice: (text: string, error?: boolean) => void;
}

const Ctx = createContext<DraftValue | null>(null);

export function useDraft() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDraft outside DraftProvider");
  return v;
}

export function DraftProvider({ children }: { children: ReactNode }) {
  const [saved, setSaved] = useState<{ site: Site; hash: string }>();
  const [site, setSite] = useState<Site>();
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [profileEntries, setProfileEntries] = useState<ProfileEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [conflict, setConflict] = useState(false);
  const [toast, setToast] = useState<{ text: string; error: boolean }>();
  // The session can end (server restart, 12h timeout) while edits are open; sign in again without losing them.
  const [relogin, setRelogin] = useState(false);

  const notice = useCallback((text: string, error = false) => {
    setToast({ text, error });
    window.setTimeout(() => setToast(undefined), error ? 6000 : 2500);
  }, []);

  const reloadProfiles = useCallback(async () => {
    const entries = await adminApi.profiles();
    setProfileEntries(entries);
    const valid = entries.filter((e) => e.id && !e.errors.length);
    const loaded = await Promise.all(valid.map((e) => adminApi.profile(e.id!)));
    setProfiles(Object.fromEntries(loaded.map((p) => [p.id, p])));
  }, []);

  const reload = useCallback(async () => {
    const s = await adminApi.site();
    setSaved(s);
    setSite(structuredClone(s.site));
    setProblems([]);
    setConflict(false);
    await reloadProfiles();
  }, [reloadProfiles]);

  useEffect(() => {
    reload().catch((err) => notice(err.message, true));
  }, [reload, notice]);

  const dirty = !!site && !!saved && JSON.stringify(site) !== JSON.stringify(saved.site);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", onLeave);
    return () => removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  const save = useCallback(async () => {
    if (!site || !saved) return false;
    setSaving(true);
    try {
      const { hash } = await adminApi.saveSite(site, saved.hash);
      setSaved({ site: structuredClone(site), hash });
      setProblems([]);
      notice("Saved and applied");
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setRelogin(true);
        return false;
      }
      if (err instanceof ApiError && err.status === 409) setConflict(true);
      setProblems(err instanceof ApiError && err.problems.length ? err.problems : [err instanceof Error ? err.message : String(err)]);
      return false;
    } finally {
      setSaving(false);
    }
  }, [site, saved, notice]);

  if (!site) return <p className="empty">Loading site…</p>;

  return (
    <Ctx.Provider
      value={{
        site,
        update: (fn) => setSite((s) => fn(structuredClone(s!))),
        dirty,
        saving,
        problems,
        conflict,
        save,
        discard: () => {
          setSite(structuredClone(saved!.site));
          setProblems([]);
        },
        reload,
        reloadProfiles,
        profiles,
        profileEntries,
        notice,
      }}
    >
      {children}
      {relogin && <ReLogin onDone={() => { setRelogin(false); void save(); }} />}
      {toast && <div className={`toast${toast.error ? " error" : ""}`}>{toast.text}</div>}
    </Ctx.Provider>
  );
}

export function SaveBar() {
  const { dirty, saving, save, discard, problems, conflict, reload } = useDraft();
  if (!dirty && !problems.length) return null;
  return (
    <div className="savebar">
      <div className="savebar-main">
        <span>{conflict ? "Someone else saved changes" : dirty ? "Unsaved changes" : "Not saved"}</span>
        <div className="row-tight">
          {conflict ? (
            <button className="btn" onClick={() => reload()}>Reload their version</button>
          ) : (
            <>
              <button className="btn" onClick={discard} disabled={saving || !dirty}>Discard</button>
              <button className="btn primary" onClick={() => save()} disabled={saving || !dirty}>
                {saving ? "Saving…" : "Save & apply"}
              </button>
            </>
          )}
        </div>
      </div>
      {problems.length > 0 && (
        <ul className="problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReLogin({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  return (
    <div className="overlay">
      <form
        className="signin card"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await adminApi.login(password);
            onDone();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      >
        <h2>Sign in again</h2>
        <p className="help">Your admin session ended. Your unsaved changes are kept and will be saved after you sign in.</p>
        <input type="password" autoFocus placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="err">{error}</p>}
        <button className="btn primary" type="submit" disabled={!password}>Sign in and save</button>
      </form>
    </div>
  );
}
