import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Engine } from "../engine/index.ts";
import { type Site, SiteSchema } from "../engine/site.ts";
import { lintScenes } from "../engine/site-lint.ts";
import { AdminAuth, COOKIE, readCookie, sessionCookie } from "./auth.ts";

const hashOf = (site: Site) => createHash("sha256").update(JSON.stringify(site)).digest("hex").slice(0, 16);

const BACKUP_FORMAT = "blue-vue-backup";

/** Admin API: everything that changes the site. Every route except login/setup needs a session. */
export function registerAdminRoutes(app: FastifyInstance, cfg: Config, engine: Engine) {
  const auth = new AdminAuth(cfg.dataDir);
  const sessionOf = (req: FastifyRequest) => readCookie(req.headers.cookie, COOKIE);
  const fail = (status: number, message: string) => Object.assign(new Error(message), { statusCode: status });

  // Scene steps are checked against profiles before anything is written.
  const save = (input: unknown) => {
    const parsed = SiteSchema.safeParse(input);
    if (parsed.success) {
      const problems = lintScenes(parsed.data, engine.profiles);
      if (problems.length) return { errors: problems };
    }
    return engine.store.save(input);
  };

  // Saves a site, applies it live, and answers with problems instead of saving when invalid.
  const saveAndApply = (reply: FastifyReply, result: { errors: string[]; site?: Site }) => {
    if (result.errors.length) return reply.status(400).send({ error: "The site has problems", problems: result.errors });
    engine.apply(result.site!);
    return { ok: true, hash: hashOf(result.site!) };
  };

  app.get("/api/admin/session", async (req) => ({ authenticated: auth.valid(sessionOf(req)), setupRequired: auth.setupRequired }));

  app.post("/api/admin/setup", async (req, reply) => {
    if (!auth.setupRequired) throw fail(409, "A password is already set");
    const { password } = z.object({ password: z.string() }).parse(req.body);
    auth.setPassword(password);
    reply.header("set-cookie", sessionCookie(auth.createSession()));
    return { ok: true };
  });

  app.post("/api/admin/login", async (req, reply) => {
    const { password } = z.object({ password: z.string() }).parse(req.body);
    reply.header("set-cookie", sessionCookie(auth.login(password, req.ip)));
    return { ok: true };
  });

  app.post("/api/admin/logout", async (req, reply) => {
    auth.logout(sessionOf(req));
    reply.header("set-cookie", sessionCookie("", 0));
    return { ok: true };
  });

  // Everything below requires a session.
  app.register(async (admin) => {
    admin.addHook("onRequest", async (req) => {
      if (!auth.valid(sessionOf(req))) throw fail(401, "Sign in to the admin first");
    });

    admin.post("/api/admin/password", async (req, reply) => {
      const { current, next } = z.object({ current: z.string(), next: z.string() }).parse(req.body);
      if (!auth.check(current)) throw fail(401, "Current password is wrong");
      auth.setPassword(next);
      reply.header("set-cookie", sessionCookie(auth.createSession()));
      return { ok: true };
    });

    // The full site, including agent tokens. `hash` guards against two admins overwriting each other.
    admin.get("/api/admin/site", async () => {
      const site = engine.site();
      return { site, hash: hashOf(site) };
    });

    admin.put("/api/admin/site", async (req, reply) => {
      const { site, baseHash } = z.object({ site: z.unknown(), baseHash: z.string() }).parse(req.body);
      if (baseHash !== hashOf(engine.site())) {
        return reply.status(409).send({ error: "Someone else changed the site since you opened it. Reload to see their changes." });
      }
      return saveAndApply(reply, save(site));
    });

    admin.get("/api/admin/snapshots", async () => engine.store.snapshots());

    admin.post("/api/admin/snapshots/:name/restore", async (req, reply) => {
      const { name } = z.object({ name: z.string() }).parse(req.params);
      return saveAndApply(reply, engine.store.restore(name));
    });

    admin.get("/api/admin/export", async (_req, reply) => {
      const stamp = new Date().toISOString().slice(0, 10);
      reply.header("content-disposition", `attachment; filename="blue-vue-${stamp}.json"`);
      return { format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), site: engine.site(), profiles: engine.profiles.customRaw() };
    });

    admin.post("/api/admin/import", { bodyLimit: 20 * 1024 * 1024 }, async (req, reply) => {
      const body = z.object({ format: z.literal(BACKUP_FORMAT), site: z.unknown(), profiles: z.array(z.record(z.unknown())).default([]) }).parse(req.body);
      const problems: string[] = [];
      for (const p of body.profiles) for (const e of engine.profiles.saveCustom(p)) problems.push(`profile ${p.id}: ${e}`);
      if (problems.length) return reply.status(400).send({ error: "Some profiles in the backup are invalid", problems });
      return saveAndApply(reply, save(body.site));
    });

    // --- Wall agents -------------------------------------------------------

    /** Approves an agent that tried to connect, trusting the token it offered. */
    admin.post("/api/admin/agents/:id/approve", async (req, reply) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { name } = z.object({ name: z.string().optional() }).parse(req.body ?? {});
      const candidate = engine.agents.candidate(id);
      if (!candidate) throw fail(404, `No agent "${id}" is waiting for approval`);
      const site = engine.site();
      const agents = site.agents.filter((a) => a.id !== id).concat({ id, name: name ?? site.agents.find((a) => a.id === id)?.name ?? id, token: candidate.token });
      const result = saveAndApply(reply, engine.store.save({ ...site, agents }));
      engine.agents.forgetCandidate(id);
      return result;
    });

    admin.post("/api/admin/agents/:id/dismiss", async (req) => {
      engine.agents.forgetCandidate(z.object({ id: z.string() }).parse(req.params).id);
      return { ok: true };
    });

    /** Makes a fresh token for an agent; put it in that wall PC's agent.json. */
    admin.post("/api/admin/agents/:id/token", async (req, reply) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const site = engine.site();
      if (!site.agents.some((a) => a.id === id)) throw fail(404, `Unknown agent "${id}"`);
      const token = randomBytes(20).toString("hex");
      const result = saveAndApply(reply, engine.store.save({ ...site, agents: site.agents.map((a) => (a.id === id ? { ...a, token } : a)) }));
      return { ...(result as object), token };
    });

    // --- Gracenote lookups for the channel editor --------------------------

    admin.get("/api/admin/gracenote/:kind", async (req) => {
      const { kind } = z.object({ kind: z.enum(["lineups", "channels"]) }).parse(req.params);
      const { q } = z.object({ q: z.string().min(1) }).parse(req.query);
      const key = process.env[cfg.guide.apiKeyEnv];
      if (!key) throw fail(400, `Set ${cfg.guide.apiKeyEnv} on the control server to look up listings`);
      const url =
        kind === "lineups"
          ? `${cfg.guide.baseUrl}/lineups?country=USA&postalCode=${encodeURIComponent(q)}&api_key=${key}`
          : `${cfg.guide.baseUrl}/lineups/${encodeURIComponent(q)}/channels?api_key=${key}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw fail(502, `Gracenote ${res.status}`);
      const data: any[] = await res.json();
      return kind === "lineups"
        ? data.map((l) => ({ id: l.lineupId, name: l.name, type: l.type, location: l.location }))
        : data.map((c) => ({ number: Number(c.channel), name: c.affiliateCallSign ?? c.callSign, callSign: c.callSign, stationId: c.stationId }));
    });
  });
}
