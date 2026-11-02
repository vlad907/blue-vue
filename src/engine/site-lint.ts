import { validateParams } from "./device-runtime.ts";
import type { ProfileLibrary } from "./profiles.ts";
import type { Site } from "./site.ts";

/**
 * Checks scene steps against device profiles, so a scene that would fail when
 * run (unknown command, missing or out-of-range params) is caught on save.
 */
export function lintScenes(site: Site, profiles: ProfileLibrary): string[] {
  const problems: string[] = [];
  const profileOf = (deviceId: string) => {
    const d = site.devices.find((x) => x.id === deviceId);
    return d ? { device: d, profile: profiles.get(d.profile) } : undefined;
  };

  for (const scene of site.scenes) {
    scene.steps.forEach((step, i) => {
      if (step.type !== "command") return;
      const where = `scene "${scene.name}" step ${i + 1}`;
      if (!step.command) return problems.push(`${where}: choose a command`);
      const targets = step.group ? (site.groups.find((g) => g.id === step.group)?.devices ?? []) : step.device ? [step.device] : [];
      for (const id of targets) {
        const found = profileOf(id);
        if (!found?.profile) continue; // missing devices/profiles are reported elsewhere
        const cmd = found.profile.commands[step.command];
        if (!cmd) {
          problems.push(`${where}: ${found.device.name} has no command "${step.command}"`);
          continue;
        }
        try {
          validateParams(cmd, step.params);
        } catch (err) {
          problems.push(`${where}: ${err instanceof Error ? err.message : err}`);
        }
      }
    });
  }
  return [...new Set(problems)];
}
