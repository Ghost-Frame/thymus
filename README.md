# Thymus

Thymus is an agent output evaluation and quality scoring service. Define rubrics with weighted criteria, score agent outputs against them, and track quality metrics over time. Use it to benchmark agents, detect regressions, and surface which agents perform best on which tasks.

- **Port:** 4900
- **Stack:** Node 22, libsql (SQLite-compatible embedded database)
- **Org:** [Ghost-Frame/thymus](https://github.com/Ghost-Frame/thymus)

---

## What It Does

- Stores rubrics with named criteria, descriptions, and per-criterion weights and max scores
- Records scored evaluations linking an agent, an input/output pair, and per-criterion scores
- Aggregates scores per agent over time with filtering by rubric or time window
- Tracks arbitrary named metrics (latency, token count, etc.) separately from rubric evaluations
- Exposes a summary endpoint for dashboard-style reporting

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

Without `THYMUS_AUTH=disabled`, all write endpoints require `Authorization: Bearer <THYMUS_API_KEY>`.

---

## Environment Variables

| Variable             | Default       | Description                                                        |
|----------------------|---------------|--------------------------------------------------------------------|
| `PORT`               | `4900`        | Port to listen on                                                  |
| `DB_PATH`            | `thymus.db`   | Path to the libsql database file                                   |
| `THYMUS_API_KEY`     | (none)        | Bearer token required for authenticated requests                   |
| `THYMUS_AUTH`        | (required)    | Set to `disabled` to skip auth entirely (development only)         |
| `CORS_ALLOW_ORIGIN`  | `*`           | Value for the `Access-Control-Allow-Origin` response header        |

---

## API Reference

### Health

#### `GET /health`

Returns service status.

```json
{ "status": "ok" }
```

---

### Rubrics

A rubric defines the evaluation criteria for a class of agent outputs. Each criterion has a name, description, weight (relative importance), and maximum score.

#### `POST /rubrics`

Create a rubric.

**Request**
```json
{
  "name": "Code Review Quality",
  "description": "Rubric for evaluating code review outputs",
  "criteria": [
    {
      "name": "accuracy",
      "description": "Bugs and issues identified are real and correctly described",
      "weight": 0.5,
      "max_score": 10
    },
    {
      "name": "completeness",
      "description": "All significant issues in the diff are caught",
      "weight": 0.3,
      "max_score": 10
    },
    {
      "name": "clarity",
      "description": "Feedback is clear and actionable",
      "weight": 0.2,
      "max_score": 10
    }
  ]
}
```

**Response** `201`
```json
{
  "id": "rub_01",
  "name": "Code Review Quality",
  "description": "Rubric for evaluating code review outputs",
  "criteria": [
    { "name": "accuracy", "weight": 0.5, "max_score": 10 },
    { "name": "completeness", "weight": 0.3, "max_score": 10 },
    { "name": "clarity", "weight": 0.2, "max_score": 10 }
  ],
  "created_at": "2026-03-22T12:00:00Z"
}
```

---

#### `GET /rubrics`

List all rubrics.

**Response** `200`
```json
[
  { "id": "rub_01", "name": "Code Review Quality", "criteria_count": 3 }
]
```

---

#### `GET /rubrics/:id`

Get a rubric with full criteria detail.

**Response** `200` - full rubric object as shown in `POST /rubrics`

---

#### `PATCH /rubrics/:id`

Update a rubric's name, description, or criteria.

**Request** - any subset of the rubric fields

**Response** `200` - updated rubric object

---

#### `DELETE /rubrics/:id`

Delete a rubric. Does not delete evaluations that referenced it.

**Response** `200`
```json
{ "ok": true }
```

---

### Evaluations

An evaluation links a rubric, an agent, an input/output pair, and a set of per-criterion scores.

#### `POST /evaluate`

Score an agent output.

**Request**
```json
{
  "rubric_id": "rub_01",
  "agent": "code-reviewer",
  "input": "Review this diff: ...",
  "output": "Found 2 issues: ...",
  "scores": {
    "accuracy": 9,
    "completeness": 7,
    "clarity": 8
  },
  "notes": "Missed one minor style issue but otherwise solid"
}
```

**Response** `201`
```json
{
  "id": "eval_01",
  "rubric_id": "rub_01",
  "agent": "code-reviewer",
  "weighted_score": 8.3,
  "scores": {
    "accuracy": 9,
    "completeness": 7,
    "clarity": 8
  },
  "notes": "Missed one minor style issue but otherwise solid",
  "created_at": "2026-03-22T12:00:00Z"
}
```

`weighted_score` is computed as `sum(score[c] / max_score[c] * weight[c])` across all criteria, normalized to 0-1, then multiplied by 100.

---

#### `GET /evaluations`

List evaluations. Filter by agent or rubric.

**Query params**
- `agent` - filter by agent name
- `rubric_id` - filter by rubric ID

**Response** `200`
```json
[
  {
    "id": "eval_01",
    "rubric_id": "rub_01",
    "agent": "code-reviewer",
    "weighted_score": 8.3,
    "created_at": "2026-03-22T12:00:00Z"
  }
]
```

---

#### `GET /evaluations/:id`

Get a single evaluation with full scores and notes.

**Response** `200` - full evaluation object as shown in `POST /evaluate`

---

#### `GET /agents/:agent/scores`

Get aggregate scores for an agent across all evaluations (or filtered by rubric).

**Query params**
- `rubric_id` - filter to a specific rubric

**Response** `200`
```json
{
  "agent": "code-reviewer",
  "evaluation_count": 42,
  "average_score": 7.8,
  "min_score": 5.1,
  "max_score": 9.6,
  "by_rubric": [
    {
      "rubric_id": "rub_01",
      "rubric_name": "Code Review Quality",
      "evaluation_count": 42,
      "average_score": 7.8
    }
  ]
}
```

---

### Metrics

Metrics are arbitrary named numeric measurements recorded per agent. Use them for latency, token counts, cost, or any other signal not captured by rubric scores.

#### `POST /metrics`

Record a metric.

**Request**
```json
{
  "agent": "code-reviewer",
  "metric": "latency_ms",
  "value": 1240,
  "metadata": {
    "task_id": "task_99",
    "model": "claude-sonnet-4-6"
  }
}
```

**Response** `201`
```json
{
  "id": "met_01",
  "agent": "code-reviewer",
  "metric": "latency_ms",
  "value": 1240,
  "created_at": "2026-03-22T12:00:00Z"
}
```

---

#### `GET /metrics`

Query recorded metrics.

**Query params**
- `agent` - filter by agent name
- `metric` - filter by metric name
- `from` - ISO8601 start timestamp
- `to` - ISO8601 end timestamp

**Response** `200`
```json
[
  {
    "id": "met_01",
    "agent": "code-reviewer",
    "metric": "latency_ms",
    "value": 1240,
    "metadata": { "model": "claude-sonnet-4-6" },
    "created_at": "2026-03-22T12:00:00Z"
  }
]
```

---

#### `GET /metrics/summary`

Aggregated min/max/avg per agent per metric.

**Query params** - same as `GET /metrics`

**Response** `200`
```json
[
  {
    "agent": "code-reviewer",
    "metric": "latency_ms",
    "count": 42,
    "min": 820,
    "max": 3100,
    "avg": 1380
  }
]
```

---

### Stats

#### `GET /stats`

Returns aggregate counts.

**Response** `200`
```json
{
  "rubrics": 4,
  "evaluations": 298,
  "metrics": 1042
}
```
