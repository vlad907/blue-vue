import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { learnOnce, sendirToPronto } from "../../agent/src/learn.ts";
import { pairStep } from "../../agent/src/transports/androidtv/remote.ts";
import { SimulatedConnection, describe } from "../../agent/src/transports/index.ts";
import { resolveSettings } from "../engine/device-manager.ts";
import { DeviceRuntime } from "../engine/device-runtime.ts";
import type { Engine } from "../engine/index.ts";
import { applyRules } from "../engine/parsers.ts";
import { ParseRule } from "../engine/profile-schema.ts";

const fail = (status: number, message: string) => Object.assign(new Error(message), { statusCode: status });
const Raw = z.record(z.unknown());

/** Profile editor API. Registered inside the admin scope, so every route needs a session. */
export function registerProfileRoutes(admin: FastifyInstance, engine: Engine) {
  const usedBy = (id: string) => engine.site().devices.filter((d) => d.profile === id).map((d) => d.id);

  admin.get("/api/admin/profiles/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const entry = engine.profiles.entry(id);
    if (!entry?.raw) throw fail(404, `Unknown profile "${id}"`);
    return { raw: entry.raw, source: entry.source, errors: entry.errors, usedBy: usedBy(id) };
  });

  /** Checks a profile without saving it, so the editor can show problems as you go. */
  admin.post("/api/admin/profiles/validate", async (req) => {
    const { profile } = z.object({ profile: Raw }).parse(req.body);
    return { problems: engine.profiles.validate(profile).errors };
  });

  admin.put("/api/admin/profiles/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { profile } = z.object({ profile: Raw }).parse(req.body);
    if (profile.id !== id) throw fail(400, "The profile id can't change; duplicate it instead");
    const problems = engine.profiles.saveCustom(profile);
    if (problems.length) return reply.status(400).send({ error: "The profile has problems", problems });
    // Devices using this profile restart with the new version.
    engine.reloadProfiles();
    return { ok: true, usedBy: usedBy(id) };
  });

  admin.delete("/api/admin/profiles/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const users = usedBy(id);
    if (users.length) throw fail(409, `Still used by: ${users.join(", ")}`);
    const dependents = engine.profiles.list().filter((e) => e.raw?.extends === id).map((e) => e.raw!.id);
    if (dependents.length) throw fail(409, `Other profiles build on it: ${dependents.join(", ")}`);
    try {
      engine.profiles.deleteCustom(id);
    } catch (err) {
      throw fail(400, err instanceof Error ? err.message : String(err));
    }
    engine.reloadProfiles();
    return { ok: true };
  });

  /**
   * Renders a command from a draft profile without sending anything: shows
   * exactly what would go to the device, and the state it would set.
   */
  admin.post("/api/admin/profiles/preview", async (req) => {
    const body = z
      .object({ profile: Raw, command: z.string(), params: z.record(z.unknown()).default({}), settings: z.record(z.unknown()).default({}) })
      .parse(req.body);
    const { profile, errors } = engine.profiles.validate(body.profile);
    if (!profile) return { problems: errors };
    let settings: Record<string, unknown>;
    try {
      settings = resolveSettings(profile.settings, body.settings);
    } catch {
      settings = body.settings; // preview with whatever was filled in
    }
    const conn = new SimulatedConnection();
    const rt = new DeviceRuntime(
      { id: "preview", name: "Preview", profile: profile.id, location: "server", enabled: true, settings },
      profile,
      () => conn,
      { noDelays: true },
    );
    try {
      await rt.execute(body.command, body.params);
    } catch (err) {
      return { problems: [err instanceof Error ? err.message : String(err)] };
    }
    const warnings = conn.sent.flatMap((p) => (p.kind === "ir" && !profile.irCodes[p.label ?? ""] ? [`No IR code learned yet for ${p.label}`] : []));
    return { sent: conn.sent.map(describe), state: rt.state, warnings: [...new Set(warnings)], problems: [] };
  });

  /** Runs parse rules over a sample reply, to check what state they'd produce. */
  admin.post("/api/admin/profiles/parse-test", async (req) => {
    const body = z.object({ rules: z.array(z.unknown()), sample: z.string(), settings: z.record(z.unknown()).default({}) }).parse(req.body);
    const rules = z.array(ParseRule).safeParse(body.rules);
    if (!rules.success) return { problems: rules.error.issues.map((i) => `rule ${i.path.join(".")}: ${i.message}`) };
    try {
      return { updates: applyRules(rules.data, body.sample, { settings: body.settings }), problems: [] };
    } catch (err) {
      return { problems: [err instanceof Error ? err.message : String(err)] };
    }
  });

  /**
   * Pairs a saved Android TV device with this system: "start" makes the TV
   * show a code, "finish" sends the code typed in. Runs where the device is
   * reached from, since that machine's certificate is the one the TV learns.
   */
  admin.post("/api/admin/devices/:id/pair", async (req) => {
    const { id } = req.params as { id: string };
    const { step, code } = z.object({ step: z.enum(["start", "finish", "cancel"]), code: z.string().optional() }).parse(req.body);
    const device = engine.site().devices.find((d) => d.id === id);
    if (!device) throw fail(404, `No saved device "${id}"`);
    if (engine.profiles.get(device.profile)?.transport.type !== "androidtv") throw fail(400, `${device.name} isn't an Android TV remote device`);
    const host = String(device.settings.host ?? "");
    if (!host) throw fail(400, `${device.name} has no IP address`);
    try {
      if (device.location === "server") await pairStep(host, step, code, engine.simulate);
      else await engine.agents.pairAndroidTv(device.location, host, step, code);
    } catch (err) {
      throw (err as { statusCode?: number }).statusCode ? err : fail(400, err instanceof Error ? err.message : String(err));
    }
    return { ok: true, simulated: engine.simulate };
  });

  /** Learns one IR code from a remote, with an iTach reached from the server or a wall PC. */
  admin.post("/api/admin/ir/learn", async (req) => {
    const { location, irHost, irTcpPort } = z
      .object({ location: z.string().default("server"), irHost: z.string().min(1), irTcpPort: z.number().int().optional() })
      .parse(req.body);
    const sendir = location === "server" ? await learnOnce(irHost, 15_000, irTcpPort) : await engine.agents.learnIr(location, irHost, irTcpPort);
    return { pronto: sendirToPronto(sendir) };
  });
}
