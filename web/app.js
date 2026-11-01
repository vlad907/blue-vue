const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== false) n.setAttribute(k, v === true ? "" : v);
  }
  n.append(...children.flat().filter((c) => c !== null && c !== undefined));
  return n;
};

let cfg;
let state;
let selectedBox;
let keypadDigits = "";

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (r?.errors?.length) toast(`Finished with errors: ${r.errors.join("; ")}`, true);
    else if (okMsg) toast(okMsg);
  } catch (err) {
    toast(err.message, true);
  }
}

let toastTimer;
function toast(msg, error = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = error ? "error" : "";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), error ? 5000 : 2000);
}

const channelName = (n) => cfg.channels.find((c) => c.number === n)?.name ?? `Ch ${n}`;

// ---------- Tabs ----------
document.querySelectorAll("nav button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("nav button, .tab").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    $(`#tab-${b.dataset.tab}`).classList.add("active");
    if (b.dataset.tab === "guide") loadGuide();
  }),
);

// ---------- Scenes ----------
function renderScenes() {
  $("#scene-list").replaceChildren(
    ...cfg.scenes.map((s) =>
      el("button", {
        class: `tile${state?.activeScene === s.id ? " active" : ""}`,
        onclick: () => act(() => api(`/api/scenes/${s.id}`, {}), `${s.name} done`),
      }, s.name, s.description ? el("small", {}, s.description) : null),
    ),
  );
}

// ---------- Video wall ----------
document.querySelectorAll("[data-wall-power]").forEach((b) =>
  b.addEventListener("click", () => {
    const on = b.dataset.wallPower === "true";
    act(() => api("/api/wall/power", { on }), `Wall ${on ? "on" : "off"}`);
  }),
);

function renderWallPresets() {
  $("#wall-presets").replaceChildren(
    ...cfg.wallPresets.map((p) =>
      el("button", {
        class: `tile${state?.videoWall.activePreset === p.id ? " active" : ""}`,
        onclick: () => act(() => api(`/api/wall/preset/${p.id}`, {}), p.name),
      }, p.name, p.layout ? el("small", {}, p.layout) : null),
    ),
  );
}

// ---------- Cable boxes ----------
function boxSelector(container, onPick) {
  container.replaceChildren(
    ...cfg.cableBoxes.map((b) =>
      el("button", { class: b.id === selectedBox ? "active" : "", onclick: () => { selectedBox = b.id; onPick(); } }, b.name),
    ),
  );
}

function tune(channel) {
  const box = cfg.cableBoxes.find((b) => b.id === selectedBox);
  act(() => api(`/api/boxes/${selectedBox}/tune`, { channel }), `${box.name} → ${channel} ${channelName(channel)}`);
}

function channelTile(c) {
  const current = state?.boxes[selectedBox]?.channel === c.number;
  return el("button", { class: `tile${current ? " active" : ""}`, onclick: () => tune(c.number) },
    el("span", { class: "num" }, String(c.number)), c.name,
    c.category ? el("small", {}, c.category) : null);
}

function renderBoxes() {
  boxSelector($("#box-select"), renderBoxes);
  const box = cfg.cableBoxes.find((b) => b.id === selectedBox);
  const ch = state?.boxes[selectedBox]?.channel;
  $("#box-now").replaceChildren(
    `${box.name}: `,
    ch ? el("b", {}, `${ch} ${channelName(ch)}`) : el("b", {}, "unknown channel"),
  );
  const favs = box.favorites.map((n) => cfg.channels.find((c) => c.number === n) ?? { number: n, name: `Ch ${n}` });
  $("#box-favs").replaceChildren(...favs.map(channelTile));
  $("#box-channels").replaceChildren(...cfg.channels.map(channelTile));
}

function buildRemote() {
  const show = () => ($("#keypad-display").textContent = keypadDigits || " ");
  const digit = (d) => el("button", { onclick: () => { if (keypadDigits.length < 4) keypadDigits += d; show(); } }, d);
  $("#keypad").replaceChildren(
    ..."123456789".split("").map(digit),
    el("button", { onclick: () => { keypadDigits = keypadDigits.slice(0, -1); show(); } }, "⌫"),
    digit("0"),
    el("button", { class: "go", onclick: () => { if (keypadDigits) tune(Number(keypadDigits)); keypadDigits = ""; show(); } }, "Tune"),
  );

  const keys = [
    ["KEY_CHANNELUP", "CH ▲"], ["KEY_UP", "▲"], ["KEY_EPG", "Guide"],
    ["KEY_LEFT", "◀"], ["KEY_OK", "OK"], ["KEY_RIGHT", "▶"],
    ["KEY_CHANNELDOWN", "CH ▼"], ["KEY_DOWN", "▼"], ["KEY_LAST", "Last"],
    ["KEY_MENU", "Menu"], ["KEY_EXIT", "Exit"], ["KEY_INFO", "Info"],
    ["KEY_REWIND", "⏪"], ["KEY_PLAYPAUSE", "⏯"], ["KEY_FASTFORWARD", "⏩"],
  ].filter(([k]) => cfg.remoteKeys.includes(k));
  $("#remote-keys").replaceChildren(
    ...keys.map(([key, label]) => el("button", { onclick: () => act(() => api(`/api/boxes/${selectedBox}/key`, { key })) }, label)),
  );
}

// ---------- Guide ----------
const PX_PER_MIN = 6;

async function loadGuide() {
  boxSelector($("#guide-box-select"), () => { renderBoxes(); loadGuide(); });
  try {
    const g = await api("/api/guide");
    renderGuide(g);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderGuide(g) {
  $("#guide-updated").textContent = g.error
    ? `Guide error: ${g.error}`
    : g.lastUpdated ? `Updated ${new Date(g.lastUpdated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "";

  if (!g.rows.length) {
    $("#guide").replaceChildren(el("p", { class: "muted", style: "padding:16px" }, "No guide data. Add Gracenote stationIds to your channels."));
    return;
  }

  const now = Date.now();
  const start = new Date(now);
  start.setMinutes(start.getMinutes() < 30 ? 0 : 30, 0, 0);
  const t0 = start.getTime();
  const end = Math.max(...g.rows.flatMap((r) => r.airings.map((a) => Date.parse(a.end))), t0 + 3_600_000);
  const width = ((end - t0) / 60_000) * PX_PER_MIN;
  const x = (t) => Math.max(0, ((t - t0) / 60_000) * PX_PER_MIN);
  const current = state?.boxes[selectedBox]?.channel;

  const slots = [];
  for (let t = t0; t < end; t += 30 * 60_000) {
    slots.push(el("div", { class: "slot", style: `left:${x(t)}px` }, new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })));
  }
  const head = el("div", { class: "guide-head" }, el("div", { class: "corner" }),
    el("div", { class: "guide-track", style: `width:${width}px;height:34px` }, ...slots));

  const rows = g.rows.map((r) =>
    el("div", { class: "guide-row" },
      el("div", { class: "guide-ch", onclick: () => tune(r.channel), style: current === r.channel ? "box-shadow: inset 4px 0 var(--accent)" : "" },
        el("b", {}, r.name), el("span", {}, `${r.channel}${r.callSign ? " · " + r.callSign : ""}`)),
      el("div", { class: "guide-track", style: `width:${width}px` },
        ...r.airings.map((a) => {
          const s = Date.parse(a.start), e = Date.parse(a.end);
          const left = x(s), w = x(e) - left - 4;
          if (w <= 0) return null;
          return el("div", {
            class: `airing${s <= now && e > now ? " now" : ""}`,
            style: `left:${left}px;width:${w}px`,
            title: [a.title, a.episodeTitle, a.description].filter(Boolean).join(" — "),
            onclick: () => tune(r.channel),
          },
            a.title,
            a.live ? el("span", { class: "badge live" }, "LIVE") : null,
            a.isNew ? el("span", { class: "badge new" }, "NEW") : null,
            el("small", {}, a.episodeTitle || `${fmtTime(s)} – ${fmtTime(e)}`));
        })),
    ),
  );
  $("#guide").replaceChildren(head, ...rows);
}

const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// ---------- Audio ----------
const gainTimers = {};

function buildZones() {
  $("#zones").replaceChildren(
    ...cfg.zones.map((z) =>
      el("div", { class: "zone", id: `zone-${z.index}` },
        el("h3", {}, z.name,
          el("button", { class: "mute", onclick: () => {
            const muted = !!state.atlas.zones[z.index]?.mute;
            act(() => api(`/api/audio/zones/${z.index}`, { mute: !muted }));
          } }, "Mute")),
        el("select", { onchange: (e) => act(() => api(`/api/audio/zones/${z.index}`, { source: Number(e.target.value) })) },
          ...cfg.sources.map((s) => el("option", { value: s.index }, s.name))),
        el("div", { class: "gain" },
          el("input", {
            type: "range", min: cfg.gainRange.min, max: cfg.gainRange.max, step: 1,
            oninput: (e) => {
              const db = Number(e.target.value);
              e.target.parentElement.querySelector(".db").textContent = `${db} dB`;
              // Throttle so dragging doesn't flood the DSP.
              clearTimeout(gainTimers[z.index]);
              gainTimers[z.index] = setTimeout(() => act(() => api(`/api/audio/zones/${z.index}`, { gainDb: db })), 80);
            },
          }),
          el("span", { class: "db" }, "")),
      ),
    ),
  );
  $("#atlas-scenes").replaceChildren(
    ...cfg.atlasScenes.map((s) => el("button", { class: "tile", onclick: () => act(() => api(`/api/audio/scenes/${s.index}`, {}), s.name) }, s.name)),
  );
}

function renderZones() {
  for (const z of cfg.zones) {
    const node = $(`#zone-${z.index}`);
    const zs = state.atlas.zones[z.index] ?? {};
    node.querySelector(".mute").classList.toggle("muted", !!zs.mute);
    node.querySelector(".mute").textContent = zs.mute ? "Muted" : "Mute";
    if (zs.source !== undefined) node.querySelector("select").value = zs.source;
    const slider = node.querySelector("input");
    // Don't fight the user's finger while they drag.
    if (zs.gainDb !== undefined && document.activeElement !== slider) {
      slider.value = zs.gainDb;
      node.querySelector(".db").textContent = `${zs.gainDb} dB`;
    }
  }
}

// ---------- Status ----------
function renderStatus() {
  const pill = (id, text, cls) => { const p = $(id); p.textContent = text; p.className = `pill ${cls}`; };
  pill("#st-wall", `Wall: ${state.wallPower}`, state.wallPower === "on" ? "ok" : "");
  pill("#st-atlas", state.atlas.connected ? "DSP online" : "DSP offline", state.atlas.connected ? "ok" : "bad");
  pill("#st-vw", state.videoWall.reachable ? "Wall API ok" : "Wall API ?", state.videoWall.reachable ? "ok" : "warn");
  $("#st-busy").hidden = !state.busy;
}

function renderAll() {
  renderStatus();
  renderScenes();
  renderWallPresets();
  renderBoxes();
  renderZones();
}

// ---------- Live state ----------
function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "state") {
      state = msg.state;
      renderAll();
    }
  };
  ws.onclose = () => {
    $("#st-atlas").textContent = "Server offline";
    $("#st-atlas").className = "pill bad";
    setTimeout(connect, 2000);
  };
}

async function init() {
  cfg = await api("/api/config");
  $("#site").textContent = cfg.site;
  document.title = `${cfg.site} Control`;
  $("#sim").hidden = !cfg.simulate;
  selectedBox = cfg.cableBoxes[0]?.id;
  buildRemote();
  buildZones();
  state = await api("/api/state");
  renderAll();
  connect();
}

init().catch((err) => toast(`Failed to load: ${err.message}`, true));
