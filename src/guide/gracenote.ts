import type { Config } from "../config.ts";
import type { StateStore } from "../state.ts";

export interface Airing {
  start: string;
  end: string;
  title: string;
  episodeTitle?: string;
  description?: string;
  genres?: string[];
  live?: boolean;
  isNew?: boolean;
}

export interface GuideRow {
  channel: number;
  name: string;
  callSign?: string;
  stationId?: string;
  logo?: string;
  airings: Airing[];
}

/**
 * Gracenote OnConnect (TMS) listings. Only channels in config with a
 * `stationId` are fetched; find station IDs for your Xfinity lineup with
 * `npm run gracenote -- channels <lineupId>`.
 */
export class GracenoteGuide {
  private rows: GuideRow[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private cfg: Config, private state: StateStore) {}

  get apiKey() {
    return process.env[this.cfg.guide.apiKeyEnv];
  }

  start() {
    if (!this.cfg.guide.enabled) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.cfg.guide.refreshMinutes * 60_000);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Guide rows, with airings that already ended trimmed off. */
  grid(): GuideRow[] {
    const now = Date.now();
    return this.rows.map((r) => ({ ...r, airings: r.airings.filter((a) => Date.parse(a.end) > now) }));
  }

  nowPlaying(channel: number): Airing | undefined {
    const now = Date.now();
    return this.rows.find((r) => r.channel === channel)?.airings.find((a) => Date.parse(a.start) <= now && Date.parse(a.end) > now);
  }

  async refresh() {
    try {
      this.rows = this.cfg.simulate || !this.apiKey || !this.cfg.guide.lineupId ? this.simulatedGrid() : await this.fetchGrid();
      this.state.update((s) => (s.guide = { lastUpdated: new Date().toISOString() }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[guide] refresh failed: ${message}`);
      this.state.update((s) => void (s.guide.error = message));
    }
  }

  private async fetchGrid(): Promise<GuideRow[]> {
    const channels = this.cfg.channels.filter((c) => c.stationId);
    if (!channels.length) return [];

    const start = new Date();
    start.setMinutes(start.getMinutes() < 30 ? 0 : 30, 0, 0);
    const end = new Date(start.getTime() + this.cfg.guide.hours * 3_600_000);

    const url = new URL(`${this.cfg.guide.baseUrl}/lineups/${encodeURIComponent(this.cfg.guide.lineupId!)}/grid`);
    url.searchParams.set("startDateTime", isoMinute(start));
    url.searchParams.set("endDateTime", isoMinute(end));
    url.searchParams.set("stationId", channels.map((c) => c.stationId).join(","));
    url.searchParams.set("size", "Basic");
    url.searchParams.set("api_key", this.apiKey!);

    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Gracenote ${res.status} ${res.statusText}`);
    const stations: any[] = await res.json();

    return channels.map((c) => {
      const st = stations.find((s) => s.stationId === c.stationId);
      return {
        channel: c.number,
        name: c.name,
        callSign: c.callSign ?? st?.callSign,
        stationId: c.stationId,
        logo: c.logo ?? st?.preferredImage?.uri,
        airings: (st?.airings ?? []).map(toAiring),
      };
    });
  }

  private simulatedGrid(): GuideRow[] {
    const shows = ["SportsCenter", "College Football", "NFL Live", "Local News", "NBA Tonight", "Movie: The Long Game", "Hockey Night", "Poker Championship"];
    const start = new Date();
    start.setMinutes(start.getMinutes() < 30 ? 0 : 30, 0, 0);
    return this.cfg.channels.map((c, ci) => {
      const airings: Airing[] = [];
      let t = start.getTime();
      for (let i = 0; t < start.getTime() + this.cfg.guide.hours * 3_600_000; i++) {
        const len = ((ci + i) % 3 === 0 ? 60 : 30) * 60_000;
        airings.push({
          start: new Date(t).toISOString(),
          end: new Date(t + len).toISOString(),
          title: shows[(ci * 3 + i) % shows.length],
          live: (ci + i) % 4 === 0,
        });
        t += len;
      }
      return { channel: c.number, name: c.name, callSign: c.callSign, stationId: c.stationId, logo: c.logo, airings };
    });
  }
}

function toAiring(a: any): Airing {
  const q: string[] = a.qualifiers ?? [];
  return {
    start: a.startTime,
    end: a.endTime,
    title: a.program?.title ?? "Unknown",
    episodeTitle: a.program?.episodeTitle,
    description: a.program?.shortDescription,
    genres: a.program?.genres,
    live: a.liveTapeDelay === "Live" || q.includes("Live"),
    isNew: q.includes("New"),
  };
}

// Gracenote wants yyyy-MM-ddTHH:mmZ.
function isoMinute(d: Date) {
  return d.toISOString().slice(0, 16) + "Z";
}
