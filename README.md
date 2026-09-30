# HemSoft Bench

Private coding-agent evaluations through the existing Pi command-line installation.

Pi handles provider selection and authentication. Candidate file and terminal tools run in disposable Docker containers. Adding a model normally means adding one configuration entry, not writing a provider adapter.

## Current status

The Node evaluator has one coding task and one visual task, with a Go terminal dashboard and background job manager. Authority Ledger is the coding challenge. Offline verification covers the installed Pi extension, real Docker isolation, the independent reference implementation, grading, and managed concurrency/cancellation.

Tested with Pi 0.87.0, Node 24.12.0, and Docker Desktop engine 29.5.3 on Windows. The sandbox is Linux with Python 3.12. This is not yet a Windows, .NET, browsing, or full-repository maintenance benchmark.

## Quick start

Run commands from [the project folder](D:/github/hemsoft/hemsoft-bench). The project has no npm dependencies to install. Pi must already be installed and authenticated.

```powershell
cd D:\github\hemsoft\hemsoft-bench
node src/cli.mjs doctor
node src/cli.mjs tasks
node src/cli.mjs models --search kimi
```

The local sandbox image is already downloaded and recorded by immutable image ID. On another machine, prepare it explicitly:

```powershell
docker desktop start
docker pull python:3.12-slim
docker build --pull=false -t hemsoft-bench-renderer:local -f docker/renderer.Dockerfile .
node src/cli.mjs setup
```

`setup` records the immutable IDs of the candidate sandbox and the separate SVG renderer. Runs do not download images or silently follow tag changes. The renderer runs without network access and cannot change the candidate's pinned sandbox image.

### Terminal dashboard

```powershell
.\build.cmd   # Rebuild the Go app when needed
.\bench.exe   # Open or reconnect to the dashboard
```

The [companion guide](D:/github/HemSoft/hemsoft-bench/docs/companion.md) covers the three-choice menu: **Start a new run**, **View Results**, or **View previous runs**. Choose a model and press Enter to start immediately and watch progress. Results and comparisons appear when it finishes. From **View Results**, press `v` to open the generated HTML comparison and visual gallery. There is no start-review screen. New dashboard runs keep history for comparison. Closing the dashboard leaves jobs running. Existing PowerShell runs remain separate and untouched.

### One-command scripted run

Edit [run.json](D:/github/HemSoft/hemsoft-bench/run.json) to choose the exact provider, model, thinking level, tasks, repeats, and per-attempt limits. No model alias is needed.

```powershell
.\run.cmd              # Start the benchmark using run.json
.\run.cmd -KeepHistory # Retain previous results too
```

The [Windows launcher](D:/github/HemSoft/hemsoft-bench/run.cmd) supplies `pwsh -NoProfile -File` and `-Execute` for you. It makes model calls and uses provider quota. It forwards options such as `-Config PATH` and preserves the script's exit code. It does not bypass the run lock or change an active run.

For a preview without model calls or cleanup:

```powershell
pwsh -NoProfile -File .\run.ps1
```

The [PowerShell script](D:/github/HemSoft/hemsoft-bench/run.ps1) defaults to one Authority Ledger attempt followed by the bike visual. Authority Ledger caps agent work at 1,800 seconds, or 30 minutes, even when the saved general limit is higher. Its grading phase has no task-specific time cutoff. The visual task keeps the configured 2,700-second limit. Each attempt has a $5 estimated-cost limit and a separate 40-request cap. Offline self-tests default to 60 seconds. The script works from other directories too and accepts `-Config PATH` for another configuration. Execution stops on infrastructure or budget failures. An ordinary failing task score does not prevent the next task from running.

By default, an executed script invocation deletes previous finalized run folders after readiness and reference checks pass, before its self-test and model attempts. It retains only the current invocation's artifacts, including its self-test and any failures or timeouts. Preview mode never deletes anything. Add `-KeepHistory` on each invocation when you want accumulated history; a later default invocation removes that history too. Configuration and the pinned Docker image are not deleted.

The PowerShell script and direct candidate/self-test CLI commands share an exclusive run lock. A second scripted execution cannot start while the first owns that store. The Go manager uses separate per-job stores and locks, so managed jobs can run concurrently without entering the script run store. Cleanup refuses unknown, linked, or incomplete run folders rather than guessing that they are stale. A hard crash can leave a lock or incomplete artifacts requiring inspection before removal. Direct CLI commands preserve history; automatic latest-invocation retention belongs to the PowerShell script.

Node, authenticated Pi, Docker, and the pinned image must already be available. The script does not install software, download images, or change authentication. Use the setup commands above on a new machine.

The script waits until execution and grading finish. In an interactive terminal, it redraws one compact status line instead of printing each tool transition. The line refreshes once per second and shows the task and attempt, current phase or tool, elapsed time against the limit, last-event age, completed/started tools, and write/edit count. Zero tool errors and noisy delta counters are omitted. It clips the line to the terminal width to avoid wrapping, and clears it before printing a result or warning.

Redirected output uses plain lines at most every 30 seconds during model execution, plus stage changes and new warnings. Detailed model-response ages and delta counters remain available in the live activity snapshot. Deltas are streamed chunks, not tokens or proof of correct work. Write/edit counts exclude writes made through bash and do not prove a valid solution exists.

After 60 seconds without events, the display adds a `QUIET` warning. Silence can mean provider latency or work inside a tool; it is not proof of a hang. These warnings do not stop, extend, or retry a run. The existing wall-clock, request, and estimated-cost limits still apply. No model reasoning, response text, tool arguments, or tool output is echoed to the progress console. Completed runs receive a task grade. Interrupted runs keep their failure status even when their recovered code passes. The final table covers only this invocation, with status, passed checks, elapsed seconds, tokens, and estimated USD. Interrupted runs show the recorded attempts and an early-stop notice. A timeout remains a nonzero exit for automation, but the script prints a short explanation instead of a PowerShell error dump. The runner does not extend limits or restart stopped runs. Transient provider responses can be retried within the original limits, as described below.

Each attempt prints its result path under [`.local/runs`](D:/github/HemSoft/hemsoft-bench/.local/runs). Self-tests have their own result folders but are excluded from the table. Use `node src/cli.mjs report` for a JSON report over the retained results. Direct CLI runs accept `--progress` for verbose activity lines on stderr without changing JSON stdout. The PowerShell script instead uses `--progress-json`, which interleaves typed progress records with final result records on stdout, and renders those progress records in place. Consumers using that option must distinguish `type: "progress"` from final result objects. Every trial saves live logs even without `--progress`. Cost limits are estimates per attempt, not a hard billing cap.

### Add a model

Find exact identifiers through `models`. It lists Pi's catalog; listing is not proof that your account can call a particular model.

```powershell
node src/cli.mjs models --search openrouter
node src/cli.mjs models --search openai-codex
node src/cli.mjs add my-model --provider PROVIDER --model EXACT_MODEL_ID --thinking high
```

Replace the provider and model placeholders with the identifiers Pi reports. Thinking must be explicit. If Pi clamps it to another level, the run stops rather than silently changing the comparison.

The default configuration and dashboard use `openrouter/moonshotai/kimi-k3` with max thinking. The matching local alias is `openrouter-kimi-k3`. The old `go-kimi-k3` alias remains available for explicit legacy use; it is no longer the default. Model aliases live in [models.local.json](D:/github/hemsoft/hemsoft-bench/models.local.json), which is ignored by Git. Credentials stay in your existing Pi configuration.

OpenRouter IDs with suffixes such as `:free` are supported. Use the separate `--thinking` setting rather than adding a thinking suffix to the model ID. Fuzzy selectors are rejected or caught by an exact selected-model check before inference.

### Check the machinery without model calls

```powershell
npm test
npm run test:integration
node src/cli.mjs verify
node src/cli.mjs self-test openrouter-kimi-k3 --wall-seconds 60
```

- Unit tests cover CLI isolation settings, reporting, process limits, and scoring rules.
- Integration tests check actual container configuration, blocked network connections, absent host credential variables, symlink rejection, command timeouts, and clean state.
- `verify` grades separately implemented Python reference programs and rejects an empty-answer shortcut.
- `self-test` launches the installed Pi CLI, verifies exact model selection and the tool allowlist, and exercises all four sandbox tool implementations through an input hook. It exits without requesting a model response.

### Run a candidate

First inspect a plan. Without `--execute`, this makes no model calls:

```powershell
node src/cli.mjs run openrouter-kimi-k3 authority-ledger --repeat 1
```

Add `--execute` when you intend to consume provider credits or subscription quota:

```powershell
node src/cli.mjs run openrouter-kimi-k3 authority-ledger --repeat 1 --execute
node src/cli.mjs report
```

The regular `bench.exe` model run follows Authority Ledger with the visual task. The agent draws a kangaroo riding a bicycle in `/workspace/bike.svg`; the harness validates the SVG, renders a bounded PNG in a separate offline Docker container, and publishes both in `.local/results/`, such as `kimi-k3-bike.svg` and `kimi-k3-bike.png`. It reports `needs_visual_review`, not a coding pass or an automatic art score. On the run results screen, press Enter or `v` to open the PNG in the Windows default app. Return to the dashboard to enter your optional 0 to 10 visual rating, which remains separate from coding grades. You can also run only the visual task with `node src/cli.mjs run openrouter-kimi-k3 kangaroo-bike --repeat 1 --execute`. Neither named file is overwritten. If either filename is occupied, both new candidates remain under the attempt folder and the attempt reports `artifact_conflict`; the run's PNG can still be opened and rated from the dashboard. Deleting a managed run removes its named pair only when the recorded hashes still match.

The default is three repeats when `--repeat` is omitted. Each attempt receives a fresh Pi conversation and container. Runs are sequential. An infrastructure or budget error stops the remaining repeats rather than silently retrying.

Per-trial limits are configurable:

```powershell
node src/cli.mjs run my-model authority-ledger --repeat 1 --wall-seconds 1800 --max-requests 40 --max-estimated-usd 5 --execute
```

The cost guard uses Pi's reported estimates and checks between requests. One request can exceed the remaining estimate. Missing, zero, or subscription-specific pricing means it is not a hard billing cap. A subscription does not necessarily make every supported endpoint free. The wall-clock limit and request count provide separate controls.

Codex benchmark calls explicitly use SSE rather than automatic WebSocket selection. Other providers use automatic transport selection. These settings apply only inside the temporary benchmark project; global Pi settings and credentials are unchanged. Pi can retry a transient provider error, including `Stream ended without finish_reason`, up to twice per consecutive failure sequence. OpenRouter's generic mid-stream `finish_reason: "error"` is rewritten to Pi's retryable `network_error` finish reason because Pi 0.87.1 otherwise treats that exact documented OpenRouter marker as non-retryable. The rewrite is limited to the OpenRouter provider and does not include content-filter errors. The retry uses the same conversation checkpoint and candidate sandbox; completed tools are not replayed, and unfinished tool calls are not executed. The original wall-clock, request, and observed estimated-cost limits include these retries. A deadline and stop-marker check before each provider request prevents further calls during slow Windows process-tree termination. Explicit authentication or subscription/quota errors, and stopped benchmark jobs, are not automatically retried. Lower-level provider retries remain disabled so requests cannot bypass the harness's budget check.

Progress and results show scheduled retries. A subsequent completed answer can be graded normally, but any interrupted response keeps total usage/cost marked incomplete. Exact recovered errors stay in `metrics.recoveredProviderErrors`; unresolved errors stay in `metrics.providerErrors`. This is distinct from offline grading of an interrupted submission, which never converts a stopped attempt into a completed pass. Results record execution-policy version 4, and CLI reports separate it from earlier policies. The TUI's historical comparisons are descriptive and warn that settings/retries can differ.

New attempts also save bounded HTTP/SSE diagnostics, separate from Pi's interpreted events. They distinguish missing completion markers, stream read errors, SDK-masked body aborts and local stops without copying prompts, response text or credentials. Run `node src/diagnose-stream.mjs PATH/TO/result.json` to inspect an attempt without inference. See [stream failure diagnostics](docs/stream-diagnostics.md) for the evidence and limits.

After a provider error, timeout, budget stop, cancellation, or incomplete response, the runner tries to capture the current solution before removing its container. A changed solution is graded in a fresh sandbox without another model call. The original status remains a failure, with a separate `recovery.grade` for the interrupted snapshot. Unchanged starter files are not graded. Capture, cleanup, and grading failures are recorded rather than promoted to passes. A hard process crash can still prevent capture. Previously saved results are not retroactively changed.

The wall-clock limit applies to Pi execution, not image preparation or hidden grading. Individual terminal commands allow at most 60 seconds. Authority Ledger grading has no task-specific time cutoff and remains cancellable through the managed job.

### Read results

Each attempt writes a directory under [the local run store](D:/github/hemsoft/hemsoft-bench/.local/runs):

- `result.json` contains outcome, scores, token usage, estimated cost, elapsed time, configuration, and source hashes.
- `events.jsonl` receives Pi's event stream as bytes arrive, not just when execution ends. A reader may see a partial final line during a run or after interruption.
- `stderr.txt` receives startup and execution diagnostics as they arrive.
- `activity.json` holds a metadata-only snapshot, updated every ten seconds and at tool/response boundaries. It includes last-event/model ages, counters, the current stage, and final status. A hard crash can leave a stale `running` snapshot; check `updatedAt` rather than treating the file as a liveness guarantee.
- `submission.py` contains the candidate's submitted artifact when available.
- `extension-state.json` records successful initialization or a blocked run.

`report` prints JSON grouped by compatible task, model, environment, budget, and implementation hashes. It exposes every status and does not pool changed task sets or execution policies. `recoveredGraded` and `recoveredFullPasses` are diagnostic counts; they never contribute to `fullPasses`. Offline self-tests are excluded. A partial collection of usage estimates is reported as unknown rather than an apparently complete cost. Interrupted model responses make token totals incomplete and total estimated cost unknown, even when earlier responses reported usage. Saved metrics retain observed token counts and `reportedEstimatedCostUsd` as partial diagnostic data. Historical reports also exclude old timeout estimates from complete cost totals; retained result files are not rewritten. Runs with the 2,700-second, $5 budget remain separate from runs with earlier budgets.

No public leaderboard, score upload, or session sharing is configured. Logs can contain complete model responses and task material. Keep them private.

## Tasks

| Task | What it tests | Hidden cases |
| --- | --- | --- |
| [Authority Ledger](D:/github/hemsoft/hemsoft-bench/tasks/authority-ledger/TASK.md) | Bitemporal corrections, cyclic group membership, hierarchical policy scope, delegated-authority fixed points, specificity, and canonical proofs | 60 |
| [Kangaroo bike](D:/github/HemSoft/hemsoft-bench/tasks/kangaroo-bike/TASK.md) | Produce a self-contained SVG for human visual review | None |

Authority Ledger has **60 private checks**. Passing every check is full task success. The fraction of cases passed is diagnostic partial credit.

The coding task submits one self-contained `solution.py`, reads JSON, and writes JSON. Authority Ledger starts with input/output helpers and public tests, then privately grades interacting temporal and delegation semantics. Its agent work period is capped at 30 minutes, while grading remains uncapped by task policy and operator-cancellable. The visual task instead requires `/workspace/bike.svg`; the harness validates SVG structure, not artistic content. No dependency installation is needed.

Separate JavaScript grading oracles and Python reference implementations agree on the retained cases. Unit tests also check manually specified edge cases. That is useful validation, not independent human review or proof of complete test coverage.

Authority Ledger is calibrated offline against deliberately flawed solvers: default-deny passes 14/60 cases, ignoring delegation passes 45/60, and ignoring recorded-time snapshots passes 43/60. Paid model calibration remains a separate operator decision. Do not change the grader after seeing a preferred model's result without recording and rescoring the change.

## Isolation design

```text
Host, trusted
  Existing Pi CLI and provider authentication
  Runner, hidden cases, reference answers, graders, result files
       |
       | Four explicitly allowed sandbox tools
       v
Fresh candidate container
  TASK.md, starter solution.py, standard Python runtime
  Writable bounded /workspace and /tmp
  No host mounts, credentials, network, or grading code
       |
       | Capture only solution.py as untrusted text, then remove container
       v
Fresh grading container
  Submitted solution.py and hidden inputs only
  Expected answers and comparisons remain on the host
```

The candidate can inspect its own sandbox and recognize it is being evaluated. The design does not depend on hiding that fact or obscuring the repository name.

Pi runs on the host, but its normal host tools are disabled. Only `sandbox_read`, `sandbox_write`, `sandbox_edit`, and `sandbox_bash` are enabled. Tool names are deliberately distinct from built-ins so an extension-loading failure cannot restore a host `bash` tool under the same name.

All normal extensions, skills, prompt templates, themes, and context-file discovery are disabled for evaluation. A controlled prompt replaces inherited system instructions. The host working directory is a fresh temporary directory, not this repository. Startup network operations, hidden provider-level retries, compaction, and cache warming are disabled for benchmark runs. Agent-level transient-error recovery is bounded by the policy above. Provider traffic still uses the network.

Provider catalogs, authentication, and provider configuration come from the existing Pi installation. Providers implemented only by custom extensions are not automatically loaded. Supporting one requires explicitly auditing its extension first.

Docker runs as an unprivileged user with no added capabilities, no privilege escalation, a read-only root filesystem, no network, no bind mounts, bounded memory and processes, and bounded temporary storage. File tools reject paths outside `/workspace`; bash can inspect the container's own operating-system files but cannot see host files.

The grader never imports or executes submitted code on the host. It passes inputs to a new container and compares bounded JSON output against host-held expected answers. Candidate processes are removed before grading begins. No grader feedback returns to the candidate session.

This protects against ordinary filesystem inspection, answer discovery, and host-tool misuse. It is not a proof against Docker, kernel, Pi, or extension vulnerabilities. Keep those runtimes patched. Do not use this prototype for hostile third-party container images or tasks that deliberately exploit the runtime.

A private Git repository, an obscure name, or `.gitignore` would not provide this isolation. The code and answer files can remain together on the trusted host precisely because that repository is never mounted into the candidate container.

## Extending it

For another model, add an alias. No provider SDK integration is needed when Pi already supports and authenticates it.

For another task:

1. Add a precise visible task specification and starter files.
2. Add host-held deterministic case generation and a grading oracle.
3. Add a separately implemented reference solution and known-bad solutions.
4. Test valid alternatives and edge cases before a model run.
5. Increment the task version when behavior or grading changes. Retain hashes and separate old results.

The first implementation uses a small task registry rather than a general plugin system. Adding arbitrary languages, multi-file artifacts, live services, or new grading methods requires implementation work. Model setup is already configuration-driven.

## Notes and sources

The [research report](D:/research/llm-benchmark-2026-09-22/REPORT.md) explains the broader methodology and feasibility assessment.

Implementation follows the installed Pi documentation:

- [CLI and resource flags](C:/Users/User/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/README.md)
- [Extension tools and lifecycle hooks](C:/Users/User/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md)
- [JSON event stream](C:/Users/User/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs/json.md)
- [Host authentication with isolated tools](C:/Users/User/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs/containerization.md)
- [Pi security model](C:/Users/User/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs/security.md)

On Windows the runner locates the standard installed Pi `cli.js` and invokes it with Node, avoiding shell argument interpolation. Set `HB_PI_ENTRY` if Pi is installed elsewhere. On other platforms it defaults to the `pi` executable, but those platforms have not yet been tested.
