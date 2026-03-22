import { createServer, type ServerResponse, type IncomingMessage } from "node:http";
import { initDb } from "./db.ts";
import {
  createRubric, getRubric, getRubricByName, listRubrics, updateRubric, deleteRubric,
  evaluate, getEvaluation, listEvaluations, getAgentScores,
  recordMetric, getMetrics, getMetricSummary,
  getStats,
} from "./eval.ts";

const DB_PATH = process.env.DB_PATH ?? "./thymus.db";
const HOST = process.env.HOST ?? "0.0.0.0";
const AUTH_DISABLED = process.env.THYMUS_AUTH === "disabled";
const THYMUS_API_KEY = process.env.THYMUS_API_KEY;
const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN;

function envInt(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

const PORT = envInt(process.env.PORT, 4900);
const BODY_MAX = envInt(process.env.BODY_MAX_BYTES, 64 * 1024);

if (!THYMUS_API_KEY && !AUTH_DISABLED) {
  console.error("FATAL: THYMUS_API_KEY is not set.");
  console.error("  Set THYMUS_API_KEY to enable auth, or");
  console.error("  set THYMUS_AUTH=disabled to run without auth.");
  process.exit(1);
}

const db = initDb(DB_PATH);

// ============================================================================
// HELPERS
// ============================================================================

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function err(res: ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}

function applyCors(origin: string | undefined, res: ServerResponse) {
  if (!CORS_ALLOW_ORIGIN) return;
  if (CORS_ALLOW_ORIGIN === "*" || origin === CORS_ALLOW_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN === "*" ? "*" : origin ?? CORS_ALLOW_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Vary", "Origin");
  }
}

function authenticate(req: IncomingMessage): boolean {
  if (AUTH_DISABLED) return true;
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return false;
  return auth.slice(7) === THYMUS_API_KEY;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > BODY_MAX) { done(() => { req.resume(); reject(new Error("Body too large")); }); return; }
      chunks.push(chunk);
    });
    req.on("end", () => done(() => {
      if (chunks.length === 0) { resolve({}); return; }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString());
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) { reject(new Error("Must be JSON object")); return; }
        resolve(parsed);
      } catch { reject(new Error("Invalid JSON")); }
    }));
    req.on("error", (e) => done(() => reject(e)));
  });
}

function bounded(v: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

// ============================================================================
// HTTP SERVER
// ============================================================================

const server = createServer(async (req, res) => {
  applyCors(req.headers.origin, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  try {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const path = url.pathname;

    // Health -- always open
    if (path === "/health" && req.method === "GET") {
      return json(res, { status: "ok", version: "0.1.0" });
    }

    // Auth gate
    if (!authenticate(req)) return err(res, "Unauthorized", 401);

    // ---- RUBRICS ----

    if (path === "/rubrics" && req.method === "GET") {
      return json(res, listRubrics(db));
    }

    if (path === "/rubrics" && req.method === "POST") {
      const body = await readBody(req);
      const { name, description, criteria } = body as {
        name?: string; description?: string; criteria?: unknown[];
      };
      if (!name || typeof name !== "string") return err(res, "name required");
      if (!criteria || !Array.isArray(criteria)) return err(res, "criteria (array) required");
      try {
        return json(res, createRubric(db, name, description, criteria), 201);
      } catch (e: any) {
        if (e.message?.includes("UNIQUE")) return err(res, "Rubric already exists", 409);
        throw e;
      }
    }

    const rubricMatch = path.match(/^\/rubrics\/(\d+)$/);

    if (rubricMatch && req.method === "GET") {
      const rubric = getRubric(db, parseInt(rubricMatch[1], 10));
      if (!rubric) return err(res, "Rubric not found", 404);
      return json(res, rubric);
    }

    if (rubricMatch && req.method === "PATCH") {
      const body = await readBody(req);
      const rubric = updateRubric(db, parseInt(rubricMatch[1], 10), body as any);
      if (!rubric) return err(res, "Rubric not found", 404);
      return json(res, rubric);
    }

    if (rubricMatch && req.method === "DELETE") {
      const ok = deleteRubric(db, parseInt(rubricMatch[1], 10));
      if (!ok) return err(res, "Rubric not found", 404);
      return json(res, { ok: true });
    }

    // ---- EVALUATIONS ----

    if (path === "/evaluate" && req.method === "POST") {
      const body = await readBody(req);
      const { rubric_id, agent, subject, input, output, scores, notes, evaluator } = body as {
        rubric_id?: number; agent?: string; subject?: string; input?: unknown; output?: unknown;
        scores?: Record<string, number>; notes?: string; evaluator?: string;
      };
      if (!rubric_id || typeof rubric_id !== "number") return err(res, "rubric_id (number) required");
      if (!agent || typeof agent !== "string") return err(res, "agent required");
      if (!subject || typeof subject !== "string") return err(res, "subject required");
      if (!scores || typeof scores !== "object") return err(res, "scores (object) required");
      if (!evaluator || typeof evaluator !== "string") return err(res, "evaluator required");
      try {
        return json(res, evaluate(db, rubric_id, agent, subject, input, output, scores, notes, evaluator), 201);
      } catch (e: any) {
        return err(res, e.message ?? "Evaluation failed");
      }
    }

    if (path === "/evaluations" && req.method === "GET") {
      return json(res, listEvaluations(db, {
        agent: url.searchParams.get("agent") ?? undefined,
        rubric_id: url.searchParams.has("rubric_id") ? parseInt(url.searchParams.get("rubric_id")!, 10) : undefined,
        limit: bounded(url.searchParams.get("limit"), 100, 1, 1000),
      }));
    }

    const evalMatch = path.match(/^\/evaluations\/(\d+)$/);
    if (evalMatch && req.method === "GET") {
      const evaluation = getEvaluation(db, parseInt(evalMatch[1], 10));
      if (!evaluation) return err(res, "Evaluation not found", 404);
      return json(res, evaluation);
    }

    // ---- AGENT SCORES ----
    // MUST use regex to carefully match /agents/:name/scores
    const agentScoresMatch = path.match(/^\/agents\/([^/]+)\/scores$/);
    if (agentScoresMatch && req.method === "GET") {
      const agentName = decodeURIComponent(agentScoresMatch[1]);
      return json(res, getAgentScores(db, agentName, {
        rubric_id: url.searchParams.has("rubric_id") ? parseInt(url.searchParams.get("rubric_id")!, 10) : undefined,
        since: url.searchParams.get("since") ?? undefined,
      }));
    }

    // ---- METRICS ----

    if (path === "/metrics" && req.method === "POST") {
      const body = await readBody(req);
      const { agent, metric, value, tags } = body as {
        agent?: string; metric?: string; value?: number; tags?: Record<string, unknown>;
      };
      if (!agent || typeof agent !== "string") return err(res, "agent required");
      if (!metric || typeof metric !== "string") return err(res, "metric required");
      if (value === undefined || typeof value !== "number") return err(res, "value (number) required");
      return json(res, recordMetric(db, agent, metric, value, tags), 201);
    }

    if (path === "/metrics" && req.method === "GET") {
      return json(res, getMetrics(db, {
        agent: url.searchParams.get("agent") ?? undefined,
        metric: url.searchParams.get("metric") ?? undefined,
        since: url.searchParams.get("since") ?? undefined,
        limit: bounded(url.searchParams.get("limit"), 100, 1, 1000),
      }));
    }

    if (path === "/metrics/summary" && req.method === "GET") {
      const agent = url.searchParams.get("agent");
      const metric = url.searchParams.get("metric");
      if (!agent) return err(res, "agent query param required");
      if (!metric) return err(res, "metric query param required");
      return json(res, getMetricSummary(db, agent, metric, url.searchParams.get("since") ?? undefined));
    }

    // ---- STATS ----

    if (path === "/stats" && req.method === "GET") {
      return json(res, getStats(db));
    }

    err(res, "Not found", 404);
  } catch (e) {
    console.error("Unhandled:", e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Thymus running on http://${HOST}:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Auth: ${AUTH_DISABLED ? "DISABLED" : "enabled"}`);
  console.log(`CORS: ${CORS_ALLOW_ORIGIN ?? "disabled"}`);
});
