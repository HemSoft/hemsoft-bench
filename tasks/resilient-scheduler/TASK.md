# Resilient Scheduler Repair

A small event-sourced job scheduler has several interacting production defects. Repair the existing Python package in `/workspace/scheduler`. Do not replace the package with a command-line program: the grader imports `scheduler.engine.Engine` directly.

You may edit these files:

- `scheduler/engine.py`
- `scheduler/replay.py`
- `scheduler/model.py`

`public_tests.py` contains examples, but the private suite exercises combinations and restart boundaries not shown there. Use only the Python standard library.

## Engine interface

The grader drives the package as follows:

```python
engine = Engine(case['workers'], case['until'])
for each timestamp in case['operations']:
    engine.advance(timestamp)
    engine.apply(each operation at that timestamp, in input order)
    # a checkpoint may happen after any apply call:
    state = json.loads(json.dumps(engine.snapshot()))
    engine = Engine.restore(state)
    engine.propagate(timestamp)
    engine.dispatch(timestamp)
answer = engine.finish()
```

`advance`, `apply`, `propagate`, and `dispatch` must therefore remain safe to call in that order. `snapshot()` must return JSON-safe data. `restore()` must reconstruct all observable and live scheduling state.

## Input

Workers have:

```json
{"id":"w1","cpu":4,"memory":8,"labels":["gpu"]}
```

A case has `workers`, nondecreasing `operations`, an integer `until`, and sometimes a private `checkpoint` index. Values are small non-negative integers. IDs, labels, keys, mutexes, and effects are short strings.

A submit operation contains a job:

```json
{
  "at": 0,
  "type": "submit",
  "job": {
    "id": "render",
    "key": "request-17",
    "priority": 4,
    "resources": {"cpu": 2, "memory": 3},
    "labels": ["gpu"],
    "requires": ["prepare"],
    "mutex": "catalog",
    "maxAttempts": 3,
    "backoff": 2,
    "lease": 5,
    "aging": 4,
    "effect": "publish:17"
  }
}
```

Defaults are already encoded by `model.make_job`: priority 0, one unit of each resource, no labels/dependencies/mutex/effect, one attempt, backoff 1, lease 10, and aging 10.

Other operations are:

- `{"at":t,"type":"heartbeat","job":id,"token":token}`
- `{"at":t,"type":"finish","job":id,"token":token}`
- `{"at":t,"type":"fail","job":id,"token":token}`
- `{"at":t,"type":"cancel","job":id}`
- `{"at":t,"type":"workerDown","worker":id}`
- `{"at":t,"type":"workerUp","worker":id}`

Unknown job/worker IDs and duplicate submissions are deterministic no-ops. The first submission with a given job ID or non-null idempotency `key` wins.

## Exact scheduling rules

At each timestamp, internal lease and retry timers due at that time are processed before external operations. External operations at the same time retain input order. After that batch, dependency propagation and dispatch run.

### Eligibility and ordering

A pending job is eligible when `readyAt <= now` and every dependency succeeded. A job whose dependency fails, is cancelled, or is blocked becomes blocked; this propagates transitively. At `finish()`, a job with a missing dependency, an impossible label/resource request, or a dependency cycle becomes blocked.

Only one running job may hold a non-null mutex value.

Order eligible jobs by:

1. descending `priority + floor((now - submitted) / aging)`;
2. ascending submission time;
3. lexicographic job ID.

If a higher-ranked job cannot currently fit, consider lower-ranked jobs. Dispatch repeatedly until no eligible job fits.

A worker fits when it is up, contains all requested labels, and has enough unallocated CPU and memory. Choose the fit with the lexicographically smallest tuple:

```text
(remaining CPU + remaining memory, remaining CPU, remaining memory, worker ID)
```

The remaining values are measured after allocating the job.

### Attempts, leases, and stale events

Starting attempt `n` allocates resources and creates token `job-id:n`. Its lease expires at `start + lease`. A matching heartbeat resets expiry to `heartbeat time + lease`.

A heartbeat, finish, or failure applies only when its token exactly matches the currently running attempt. Late events from expired, cancelled, or previous attempts are no-ops.

Failure or lease expiry releases resources. If `attempts >= maxAttempts`, the job fails. Otherwise it becomes pending at:

```text
failure time + backoff * 2 ** (attempt number - 1)
```

A worker going down receives no new work. Running attempts keep their resources and are handled by their normal lease timers. Cancellation releases a running allocation immediately and is terminal.

### Effects

A successful job contributes its non-null `effect` string. The output lists each effect once, in lexicographic order, even when multiple successful jobs name it.

## Output

`finish()` returns:

```json
{
  "timeline": [
    {"at":0,"event":"started","job":"a","worker":"w1","attempt":1,"token":"a:1","leaseUntil":5}
  ],
  "jobs": [
    {"id":"a","status":"running","attempts":1}
  ],
  "effects": []
}
```

Timeline entries are appended in occurrence order. The required event shapes are:

- `started`: worker, attempt, token, leaseUntil
- `heartbeat`: token, leaseUntil
- `retry`: attempt, reason (`failure` or `lease`), readyAt
- `failed`: attempt, reason
- `succeeded`: attempt
- `cancelled`: no extra fields
- `blocked`: dependency (an ID, `"cycle"`, or `null` for capacity/label impossibility)

Jobs and effects are lexicographically sorted. Do not emit entries for ignored operations, worker state changes, submissions, or idle timer advances.

## Local check

Run:

```bash
python -m unittest -v public_tests.py
```

The starter is intentionally defective. Passing only the public examples is not sufficient; preserve the interface and implement the complete contract above.
