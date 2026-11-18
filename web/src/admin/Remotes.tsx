import { useState } from "react";
import { Preview } from "../views/Remote.tsx";
import type { SiteDevice } from "./adminApi.ts";
import { useDraft } from "./draft.tsx";
import { Pick, Text } from "./forms.tsx";
import { useLive } from "./live.tsx";

// One place to point each Apple TV and cable box at the NDI stream that carries
// its picture. The touch panel's Remote tab then shows that stream beside the
// device's remote. A thumbnail of the chosen stream confirms it's the right one.

/** The NDI streams each media server sees on the network, and the mosaic device to ask for a picture. */
export function useNdiStreams() {
  const { site } = useDraft();
  const live = useLive();
  const engines = site.devices.filter((d) => d.profile === "mosaic-engine");
  // Several canvases of one media server are several devices; any of them can fetch a picture.
  const servers = engines.filter((e, i) => engines.findIndex((x) => x.settings.host === e.settings.host) === i);
  const streamsOf = (engineId: string) => {
    const host = engines.find((e) => e.id === engineId)?.settings.host;
    return [...new Set(engines.filter((e) => e.settings.host === host).flatMap((e) => (live?.devices[e.id]?.state.streams as string[] | undefined) ?? []))].sort();
  };
  return { servers, streamsOf };
}

export function Remotes() {
  const { site, update, profiles, dirty } = useDraft();
  const { servers, streamsOf } = useNdiStreams();
  const [server, setServer] = useState<string>();
  const boxes = site.devices.filter((d) => ["tuner", "player"].includes(profiles[d.profile]?.category ?? ""));
  const engine = servers.find((s) => s.id === server)?.id ?? servers[0]?.id;
  const streams = engine ? streamsOf(engine) : [];
  const roomName = (id?: string) => site.rooms.find((r) => r.id === id)?.name ?? "";
  const usedBy = (stream: string, except: string) => boxes.find((b) => b.id !== except && b.preview?.stream === stream)?.name;
  const link = (id: string, preview: SiteDevice["preview"]) =>
    update((s) => {
      const d = s.devices.find((x) => x.id === id);
      if (d) d.preview = preview;
      return s;
    });
  const linked = boxes.filter((b) => b.preview).length;

  return (
    <div>
      <h2>Remote pictures</h2>
      <p className="help">
        Choose the NDI stream that shows each Apple TV or cable box: the encoder box its HDMI output goes into. Staff then see that picture live beside
        the device's remote on the touch panel's Remote tab. The media server pulls the stream off the network by its name, whether or not it's on a wall.
      </p>
      {!servers.length && <p className="empty">Add the mosaic engine first (Devices → + Add mosaic engine). Its media server is what finds and reads the NDI streams.</p>}
      {servers.length > 1 && (
        <div className="row-tight">
          <span className="muted">Streams seen by</span>
          <Pick value={engine} options={servers.map((s) => ({ value: s.id, label: `${s.name} (${String(s.settings.host ?? "")})` }))} onChange={setServer} />
        </div>
      )}
      {servers.length > 0 && (
        <>
          <p>
            <b>{linked}</b> of {boxes.length} linked · {streams.length} stream{streams.length === 1 ? "" : "s"} on the network right now
            {dirty && <span className="muted"> · press Save & apply to put changes on the touch panel</span>}
          </p>
          <table className="atable remotes">
            <thead>
              <tr><th>Device</th><th>Room</th><th>NDI stream</th><th>Picture</th></tr>
            </thead>
            <tbody>
              {boxes.map((b) => {
                const chosen = b.preview?.stream;
                const offline = chosen !== undefined && !streams.includes(chosen);
                const shared = chosen ? usedBy(chosen, b.id) : undefined;
                return (
                  <tr key={b.id}>
                    <td><b>{b.name}</b><div className="muted">{profiles[b.profile]?.name ?? b.profile}</div></td>
                    <td>{roomName(b.room) || <span className="muted">none</span>}</td>
                    <td>
                      <Pick
                        value={chosen}
                        empty="No picture"
                        options={[...new Set([...(chosen ? [chosen] : []), ...streams])].map((s) => ({ value: s, label: s }))}
                        onChange={(stream) => link(b.id, stream ? { device: b.preview?.device ?? engine!, stream } : undefined)}
                      />
                      {(!streams.length || offline) && (
                        <Text value={chosen} placeholder="or type the full NDI name: MACHINE (Stream)" onChange={(stream) => link(b.id, stream.trim() ? { device: b.preview?.device ?? engine!, stream } : undefined)} />
                      )}
                      {offline && <div className="help">Not on the network right now.</div>}
                      {shared && <div className="help">Also linked to {shared}.</div>}
                    </td>
                    <td className="thumb">
                      {chosen ? (
                        <Preview key={chosen} url={`/api/v2/streams/preview.jpg?engine=${encodeURIComponent(b.preview!.device)}&name=${encodeURIComponent(chosen)}`} everyMs={1000} />
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!boxes.length && <p className="empty">No Apple TVs or cable boxes yet. Add them on the Devices page.</p>}
        </>
      )}
    </div>
  );
}
