import type { CommandResult, EndpointManager } from "../drivers/endpoints.ts";

/**
 * Controls the TV panels of every video wall through each wall's endpoint
 * agent. Commands go to one wall, or to all walls in parallel when no wall is
 * given (each agent staggers its own panels).
 */
export class TvWallController {
  constructor(private endpoints: EndpointManager) {}

  async power(on: boolean, wall?: string, panels?: string[]) {
    return this.each(wall, (id) => this.endpoints.get(id).power(on, panels));
  }

  async input(input: string, wall?: string, panels?: string[]) {
    return this.each(wall, (id) => this.endpoints.get(id).input(input, panels));
  }

  /** Runs `fn` per wall and throws a combined error if any wall or panel failed. */
  private async each(wall: string | undefined, fn: (id: string) => Promise<CommandResult>) {
    if (wall) this.endpoints.get(wall); // throws on an unknown wall
    const ids = wall ? [wall] : [...this.endpoints.endpoints.keys()];
    const results = await Promise.allSettled(ids.map(fn));
    await Promise.all(ids.map((id) => this.endpoints.poll(id)));

    const errors: string[] = [];
    results.forEach((r, i) => {
      if (r.status === "rejected") errors.push(`${ids[i]}: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
      else for (const [panel, msg] of Object.entries(r.value.errors)) errors.push(`${ids[i]}/${panel}: ${msg}`);
    });
    if (errors.length) throw new Error(errors.join("; "));
  }
}
