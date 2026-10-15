import { Router, type Request } from "express";
import { z } from "zod";
import { ok } from "@richtfest/shared";
import type { AppDeps } from "./deps";
import { readProjectEnvironment, researchProjectEnvironment } from "./environment";

export function createEnvironmentRouter(getDeps: (req: Request) => AppDeps) {
  const router = Router();
  router.get("/projects/:projectId/environment", async (req, res, next) => {
    try { res.json(ok(await readProjectEnvironment(getDeps(req), z.string().uuid().parse(req.params.projectId)))); }
    catch (error) { next(error); }
  });
  router.post("/projects/:projectId/environment", async (req, res, next) => {
    try {
      const input = z.object({ revision: z.number().int().nonnegative(), refresh: z.boolean().default(false) }).strict().parse(req.body);
      res.json(ok(await researchProjectEnvironment(getDeps(req), z.string().uuid().parse(req.params.projectId), input)));
    } catch (error) { next(error); }
  });
  return router;
}
