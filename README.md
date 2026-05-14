# Thymus

Thymus scores agent output against rubrics you define. Each rubric is a set of weighted criteria with min/max scales. You score a single agent run against a rubric and Thymus stores the per-criterion scores, computes a normalized overall score, and lets you query aggregates over time. A separate metrics endpoint records arbitrary numeric values (latency, token count, cost) tagged with whatever context you want.

- **Port:** 4900
- **Stack:** Node 22, libsql (SQLite-compatible embedded database)
- **Org:** [Ghost-Frame/thymus](https://github.com/Ghost-Frame/thymus)

---

## What It Does

- Stores rubrics with weighted criteria and per-criterion scoring scales
- Records evaluations linking an agent run to a rubric and a set of scores
- Computes a normalized overall score per evaluation
- Aggregates per-agent scores across rubrics, criteria, and time windows
- Stores arbitrary tagged metrics for any other signal you care about
- Emits an event to Axon every time an evaluation completes

---

## Quick Start

```bash
docker run -d \
  --name thymus \
  -p 4900:4900 \
  -e THYMUS_API_KEY=your-secret-key \
  -e DB_PATH=/data/thymus.db \
  -v thymus-data:/data \
  ghcr.io/ghost-frame/thymus:latest
```

Without `THYMUS_AUTH=disabled`, every endpoint except `/health` requires `Authorization: Bearer <THYMUS_API_KEY>`.

---

## Environment Variables

| Variable             | Default       | Description                                                        |
|----------------------|---------------|--------------------------------------------------------------------|
| `PORT`               | `4900`        | Port to listen on                                                  |
| `HOST`               | `0.0.0.0`     | Bind address                                                       |
| `DB_PATH`            | `thymus.db`   | Path to the libsql database file                                   |
| `THYMUS_API_KEY`     | (none)        | Bearer token required for authenticated requests                   |
| `THYMUS_AUTH`        | (required)    | Set to `disabled` to skip auth entirely (development only)         |
| `CORS_ALLOW_ORIGIN`  | (none)        | Value for the `Access-Control-Allow-Origin` response header        |
| `BODY_MAX_BYTES`     | `65536`       | Maximum request body size                                          |
| `AXON_URL`           | (none)        | Axon endpoint to publish `evaluation.completed` events to          |
| `AXON_API_KEY`       | (none)        | Bearer token for Axon publishes                                    |

---

## Concepts

- **Rubric** -- a named set of weighted criteria. Each criterion has `name`, optional `description`, `weight`, `scale_min`, and `scale_max`.
- **Evaluation** -- a single scoring event. Links a rubric, the agent under evaluation, the `subject` of the work, the raw scores per criterion, an `evaluator` (who or what did the scoring), and an optional `input` / `output` / `notes`.
- **Metric** -- a tagged numeric measurement attached to an agent and a metric name. Stored separately from rubric scores.

### How the overall score is computed

For each criterion `c` with weight `w_c` and scale `[scale_min_c, scale_max_c]`, given a raw score `s_c`:

```
normalized_c = (s_c - scale_min_c) / (scale_max_c - scale_min_c)
overall_score = sum(normalized_c * w_c) / sum(w_c)
```

The result lands in `[0.0, 1.0]`. Weights do not need to sum to 1 -- Thymus divides by the total weight.

If you score on a 0-10 scale, set `scale_min: 0` and `scale_max: 10`. For a 1-5 Likert, set `scale_min: 1` and `scale_max: 5`. Higher raw scores always mean better, so invert the meaning at the criterion level if you need a "lower is better" measure.

---

## API Reference

### Health

#### `GET /health`

Always open.

```json
{ "status": "ok", "version": "0.1.0" }
```

---

### Rubrics

#### `POST /rubrics`

Create a rubric.

**Request**
```json
{
  "name": "code-review-quality",
  "description": "Rubric for evaluating code review outputs",
  "criteria": [
    { "name": "accuracy",     "description": "Issues identified are real",       "weight": 0.5, "scale_min": 0, "scale_max": 10 },
    { "name": "completeness", "description": "Significant issues are caught",    "weight": 0.3, "scale_min": 0, "scale_max": 10 },
    { "name": "clarity",      "description": "Feedback is clear and actionable", "weight": 0.2, "scale_min": 0, "scale_max": 10 }
  ]
}
```

**Response** `201` -- the stored rubric. Returns `409` if the name already exists.

---

#### `GET /rubrics`

List rubrics, newest first.

#### `GET /rubrics/:id`

Get one rubric with full criteria.

#### `PATCH /rubrics/:id`

Update `name`, `description`, or `criteria`. Replaces the criteria array wholesale when supplied.

#### `DELETE /rubrics/:id`

Delete a rubric. Existing evaluations stay intact.

---

### Evaluations

#### `POST /evaluate`

Score one agent run.

**Request**
```json
{
  "rubric_id": 1,
  "agent": "code-reviewer",
  "subject": "pr-1247",
  "evaluator": "human:alice",
  "scores": { "accuracy": 9, "completeness": 7, "clarity": 8 },
  "input": "Review this diff: ...",
  "output": "Found 2 issues: ...",
  "notes": "Missed one minor style issue but otherwise solid"
}
```

Required fields: `rubric_id`, `agent`, `subject`, `scores`, `evaluator`. The score object must contain exactly the criterion names declared on the rubric -- missing or unknown keys return `400`. `input`, `output`, and `notes` are optional.

`evaluator` is a free-form string. Use it to track who or what scored the run -- a human reviewer (`human:alice`), a peer model (`agent:gpt-5.5-judge`), or a deterministic script (`script:lint-rubric-v1`).

**Response** `201`
```json
{
  "id": 87,
  "rubric_id": 1,
  "agent": "code-reviewer",
  "subject": "pr-1247",
  "evaluator": "human:alice",
  "input": "Review this diff: ...",
  "output": "Found 2 issues: ...",
  "scores": { "accuracy": 9, "completeness": 7, "clarity": 8 },
  "overall_score": 0.82,
  "notes": "Missed one minor style issue but otherwise solid",
  "created_at": "2026-03-22T12:00:00Z"
}
```

---

#### `GET /evaluations`

List evaluations, newest first.

**Query params**
- `agent` -- filter by agent name
- `rubric_id` -- filter by rubric
- `limit` -- default `100`, max `1000`

#### `GET /evaluations/:id`

Get one evaluation with full scores, input, output, and notes.

---

#### `GET /agents/:agent/scores`

Aggregate one agent's scores across evaluations.

**Query params**
- `rubric_id` -- restrict to one rubric
- `since` -- ISO8601 lower bound on `created_at`

**Response** `200`
```json
{
  "agent": "code-reviewer",
  "overall_avg": 0.78,
  "evaluation_count": 42,
  "by_criterion": {
    "accuracy":     { "avg": 8.4, "min": 5, "max": 10, "count": 42 },
    "completeness": { "avg": 7.1, "min": 4, "max": 9,  "count": 42 },
    "clarity":      { "avg": 7.9, "min": 6, "max": 10, "count": 42 }
  }
}
```

`overall_avg` averages the normalized `overall_score` across matching evaluations. `by_criterion` averages the raw scores per criterion.

---

### Metrics

#### `POST /metrics`

Record one measurement.

**Request**
```json
{
  "agent": "code-reviewer",
  "metric": "latency_ms",
  "value": 1240,
  "tags": { "task_id": "task_99", "model": "claude-sonnet-4-6" }
}
```

Required: `agent`, `metric`, `value`. `tags` is optional and stored as JSON.

**Response** `201` -- the stored metric row.

---

#### `GET /metrics`

Query recorded metrics.

**Query params**
- `agent` -- filter by agent name
- `metric` -- filter by metric name
- `since` -- ISO8601 lower bound on `recorded_at`
- `limit` -- default `100`, max `1000`

---

#### `GET /metrics/summary`

Aggregate one metric for one agent. Both `agent` and `metric` query params are required.

**Query params**
- `agent` (required)
- `metric` (required)
- `since` -- ISO8601 lower bound

**Response** `200`
```json
{ "agent": "code-reviewer", "metric": "latency_ms", "avg": 1380, "min": 820, "max": 3100, "count": 42 }
```

---

### Stats

#### `GET /stats`

Aggregate counts plus a per-rubric breakdown.

```json
{
  "rubrics": 4,
  "evaluations": 298,
  "metrics": 1042,
  "agent_count": 7,
  "by_rubric": [
    { "name": "code-review-quality", "evaluation_count": 142, "avg_score": 0.78 }
  ]
}
```

---

## Events

Thymus publishes one event type to Axon, with `source: "thymus"`:

| Channel  | Type                    | Emitted when                |
|----------|-------------------------|-----------------------------|
| `system` | `evaluation.completed`  | An evaluation is created    |

Payload includes `evaluation_id`, `agent`, `subject`, `overall_score`, and `rubric` name.

---

## Where Thymus Fits

Thymus is one piece of a larger agent infrastructure. Sister services:

- [axon](https://github.com/Ghost-Frame/axon) -- pub/sub event bus
- [broca](https://github.com/Ghost-Frame/broca) -- action log and natural language narrator
- [chiasm](https://github.com/Ghost-Frame/chiasm) -- task coordination dashboard
- [loom](https://github.com/Ghost-Frame/loom) -- workflow orchestration
- [soma](https://github.com/Ghost-Frame/soma) -- agent registry and heartbeats

Thymus runs standalone. Score any agent run against any rubric over HTTP, then read aggregate quality from `/agents/:agent/scores` to compare agents, track drift, or gate releases.
