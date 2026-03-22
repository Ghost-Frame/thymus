import type { Db } from "./db.ts";
import { emitEvent } from "./axon.ts";

// ---------------------------------------------------------------------------
// JSON field parsing helper
// ---------------------------------------------------------------------------

function parseJsonFields<T extends Record<string, unknown>>(
  row: T | undefined,
  ...fields: string[]
): T | undefined {
  if (!row) return undefined;
  for (const f of fields) {
    if (typeof (row as any)[f] === "string") {
      try { (row as any)[f] = JSON.parse((row as any)[f]); } catch { /* leave as-is */ }
    }
  }
  return row;
}

function parseJsonFieldsAll<T extends Record<string, unknown>>(
  rows: T[],
  ...fields: string[]
): T[] {
  for (const row of rows) parseJsonFields(row, ...fields);
  return rows;
}

// ---------------------------------------------------------------------------
// Rubrics
// ---------------------------------------------------------------------------

export function createRubric(
  db: Db,
  name: string,
  description: string | null | undefined,
  criteria: unknown[],
) {
  const stmt = db.prepare(
    "INSERT INTO rubrics (name, description, criteria) VALUES (?, ?, ?)",
  );
  const info = stmt.run(name, description ?? null, JSON.stringify(criteria));
  return getRubric(db, Number(info.lastInsertRowid))!;
}

export function getRubric(db: Db, id: number) {
  const row = db.prepare("SELECT * FROM rubrics WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return parseJsonFields(row, "criteria");
}

export function getRubricByName(db: Db, name: string) {
  const row = db.prepare("SELECT * FROM rubrics WHERE name = ?").get(name) as Record<string, unknown> | undefined;
  return parseJsonFields(row, "criteria");
}

export function listRubrics(db: Db) {
  const rows = db.prepare("SELECT * FROM rubrics ORDER BY id DESC").all() as Record<string, unknown>[];
  return parseJsonFieldsAll(rows, "criteria");
}

export function updateRubric(
  db: Db,
  id: number,
  updates: { name?: string; description?: string | null; criteria?: unknown[] },
) {
  const fields: string[] = [];
  const params: unknown[] = [];

  if (updates.name !== undefined) { fields.push("name = ?"); params.push(updates.name); }
  if (updates.description !== undefined) { fields.push("description = ?"); params.push(updates.description); }
  if (updates.criteria !== undefined) { fields.push("criteria = ?"); params.push(JSON.stringify(updates.criteria)); }

  if (fields.length === 0) return getRubric(db, id);

  fields.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE rubrics SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  return getRubric(db, id);
}

export function deleteRubric(db: Db, id: number): boolean {
  const info = db.prepare("DELETE FROM rubrics WHERE id = ?").run(id);
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// Evaluations
// ---------------------------------------------------------------------------

export function evaluate(
  db: Db,
  rubricId: number,
  agent: string,
  subject: string,
  input: unknown,
  output: unknown,
  scores: Record<string, number>,
  notes: string | null | undefined,
  evaluator: string,
) {
  const rubric = getRubric(db, rubricId);
  if (!rubric) throw new Error("Rubric not found");

  const criteria = rubric.criteria as { name: string; description?: string; weight: number; scale_min: number; scale_max: number }[];
  const criteriaNames = new Set(criteria.map((c) => c.name));
  const scoreKeys = Object.keys(scores);

  // Validate score keys match criteria names
  for (const key of scoreKeys) {
    if (!criteriaNames.has(key)) throw new Error(`Unknown criterion: ${key}`);
  }
  for (const name of criteriaNames) {
    if (!(name in scores)) throw new Error(`Missing score for criterion: ${name}`);
  }

  // Calculate weighted overall_score
  let weightedSum = 0;
  let totalWeight = 0;
  for (const c of criteria) {
    const raw = scores[c.name];
    const normalized = (raw - c.scale_min) / (c.scale_max - c.scale_min);
    weightedSum += normalized * c.weight;
    totalWeight += c.weight;
  }
  const overall_score = totalWeight > 0 ? weightedSum / totalWeight : 0;

  const info = db.prepare(
    "INSERT INTO evaluations (rubric_id, agent, subject, input, output, scores, overall_score, notes, evaluator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    rubricId,
    agent,
    subject,
    JSON.stringify(input ?? {}),
    JSON.stringify(output ?? {}),
    JSON.stringify(scores),
    overall_score,
    notes ?? null,
    evaluator,
  );

  const evaluation = getEvaluation(db, Number(info.lastInsertRowid))!;
  emitEvent("system", "evaluation.completed", { evaluation_id: evaluation.id, agent, subject, overall_score, rubric: (rubric as any).name });
  return evaluation;
}

export function getEvaluation(db: Db, id: number) {
  const row = db.prepare("SELECT * FROM evaluations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return parseJsonFields(row, "input", "output", "scores");
}

export function listEvaluations(
  db: Db,
  opts?: { agent?: string; rubric_id?: number; limit?: number },
) {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (opts?.agent) { clauses.push("agent = ?"); params.push(opts.agent); }
  if (opts?.rubric_id) { clauses.push("rubric_id = ?"); params.push(opts.rubric_id); }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = opts?.limit ?? 100;
  const rows = db.prepare(
    `SELECT * FROM evaluations ${where} ORDER BY created_at DESC LIMIT ?`,
  ).all(...params, limit) as Record<string, unknown>[];
  return parseJsonFieldsAll(rows, "input", "output", "scores");
}

export function getAgentScores(
  db: Db,
  agent: string,
  opts?: { rubric_id?: number; since?: string },
) {
  const clauses = ["agent = ?"];
  const params: unknown[] = [agent];

  if (opts?.rubric_id) { clauses.push("rubric_id = ?"); params.push(opts.rubric_id); }
  if (opts?.since) { clauses.push("created_at >= ?"); params.push(opts.since); }

  const where = `WHERE ${clauses.join(" AND ")}`;
  const rows = db.prepare(
    `SELECT * FROM evaluations ${where} ORDER BY created_at DESC`,
  ).all(...params) as Record<string, unknown>[];
  const evals = parseJsonFieldsAll(rows, "input", "output", "scores");

  // Compute per-criterion stats
  const criterionStats: Record<string, { sum: number; min: number; max: number; count: number }> = {};
  let overallSum = 0;
  let overallCount = 0;

  for (const ev of evals) {
    const scores = ev.scores as Record<string, number>;
    for (const [key, val] of Object.entries(scores)) {
      if (!criterionStats[key]) {
        criterionStats[key] = { sum: 0, min: Infinity, max: -Infinity, count: 0 };
      }
      const s = criterionStats[key];
      s.sum += val;
      s.min = Math.min(s.min, val);
      s.max = Math.max(s.max, val);
      s.count += 1;
    }
    overallSum += ev.overall_score as number;
    overallCount += 1;
  }

  const by_criterion: Record<string, { avg: number; min: number; max: number; count: number }> = {};
  for (const [key, s] of Object.entries(criterionStats)) {
    by_criterion[key] = {
      avg: s.count > 0 ? s.sum / s.count : 0,
      min: s.count > 0 ? s.min : 0,
      max: s.count > 0 ? s.max : 0,
      count: s.count,
    };
  }

  return {
    agent,
    overall_avg: overallCount > 0 ? overallSum / overallCount : 0,
    evaluation_count: overallCount,
    by_criterion,
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export function recordMetric(
  db: Db,
  agent: string,
  metric: string,
  value: number,
  tags?: Record<string, unknown>,
) {
  const info = db.prepare(
    "INSERT INTO metrics (agent, metric, value, tags) VALUES (?, ?, ?, ?)",
  ).run(agent, metric, value, JSON.stringify(tags ?? {}));
  const row = db.prepare("SELECT * FROM metrics WHERE id = ?").get(Number(info.lastInsertRowid)) as Record<string, unknown> | undefined;
  return parseJsonFields(row, "tags");
}

export function getMetrics(
  db: Db,
  opts?: { agent?: string; metric?: string; since?: string; limit?: number },
) {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (opts?.agent) { clauses.push("agent = ?"); params.push(opts.agent); }
  if (opts?.metric) { clauses.push("metric = ?"); params.push(opts.metric); }
  if (opts?.since) { clauses.push("recorded_at >= ?"); params.push(opts.since); }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = opts?.limit ?? 100;
  const rows = db.prepare(
    `SELECT * FROM metrics ${where} ORDER BY recorded_at DESC LIMIT ?`,
  ).all(...params, limit) as Record<string, unknown>[];
  return parseJsonFieldsAll(rows, "tags");
}

export function getMetricSummary(
  db: Db,
  agent: string,
  metric: string,
  since?: string,
) {
  const clauses = ["agent = ?", "metric = ?"];
  const params: unknown[] = [agent, metric];

  if (since) { clauses.push("recorded_at >= ?"); params.push(since); }

  const where = `WHERE ${clauses.join(" AND ")}`;
  const row = db.prepare(
    `SELECT AVG(value) as avg, MIN(value) as min, MAX(value) as max, COUNT(*) as count FROM metrics ${where}`,
  ).get(...params) as { avg: number | null; min: number | null; max: number | null; count: number };

  return {
    agent,
    metric,
    avg: row.avg ?? 0,
    min: row.min ?? 0,
    max: row.max ?? 0,
    count: row.count,
  };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function getStats(db: Db) {
  const rubrics = (db.prepare("SELECT COUNT(*) as count FROM rubrics").get() as any).count;
  const evaluations = (db.prepare("SELECT COUNT(*) as count FROM evaluations").get() as any).count;
  const metrics = (db.prepare("SELECT COUNT(*) as count FROM metrics").get() as any).count;
  const agents = db.prepare("SELECT DISTINCT agent FROM evaluations UNION SELECT DISTINCT agent FROM metrics").all();
  const by_rubric = db.prepare(
    "SELECT r.name, COUNT(e.id) as evaluation_count, AVG(e.overall_score) as avg_score FROM rubrics r LEFT JOIN evaluations e ON r.id = e.rubric_id GROUP BY r.id ORDER BY evaluation_count DESC",
  ).all();
  return { rubrics, evaluations, metrics, agent_count: agents.length, by_rubric };
}
