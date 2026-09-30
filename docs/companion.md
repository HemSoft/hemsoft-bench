# Benchmark companion

The dashboard has three choices:

- **Start a new run**
- **View Results**
- **View previous runs**

Open [bench.exe](D:/github/HemSoft/hemsoft-bench/bench.exe). Use the arrow keys to choose an action and Enter to open it.

## Start a run

Choose **Start a new run**, highlight one model, and press Enter. That Enter starts provider calls immediately and opens the run's progress. There is no review screen or second confirmation.

The model picker shows its thinking level, tasks, and estimated allowance before you start. It uses the saved model settings. Current defaults are Authority Ledger followed by the kangaroo-bike SVG test, one run of each, 40 requests, and $5 estimated per test. Authority Ledger agent work stops after 30 minutes even though the visual task keeps the configured 45-minute limit. The estimated total allowance is $10 for both, not a hard billing cap. Authority grading has no task-specific time cutoff and remains operator-cancellable.

A selection always starts exactly one model, even if older saved configuration includes model suites. Model settings, credentials, and provider authentication remain unchanged. The simple dashboard does not expose suite or configuration editors.

## Compare results

Choose **View Results** for the latest result from every provider, model, and thinking setup. Authority shows the latest Authority Ledger score out of 60. The visual column shows review state or your saved rating. Configured models remain visible before their first run. Enter opens the selected model's latest run without starting work.

Press `v` from **View Results** to regenerate and open [the local HTML report](D:/github/HemSoft/hemsoft-bench/.local/reports/results.html). It shows the same result matrix followed by every retained kangaroo-bike image in a responsive gallery. Use Grid or List to change the gallery layout and **Open large** to inspect an image.

The report is a static local file. It embeds verified images, contains no manager credentials, and needs no local web server. Future visual tasks can add owned raster images or self-contained HTML pages. HTML candidates render in network-blocked sandbox frames and cannot access the report's origin.

## Watch progress and results

The progress screen identifies the model and current task. Above the task name, a segmented bar shows completed, active, and waiting tests alongside `n / n tests`. It counts finished task runs, not hidden checks or fractions of a test. The screen also shows execution stage, elapsed time, tool activity, and completed results. Silence is reported without claiming that the model has hung.

The same screen changes to results when execution ends. The comparison section shows the selected run first, followed by up to ten recent completed runs. It includes passed coding tests, graded checks, summed test time, outcome, and cost. All older runs remain available through **View previous runs**.

The result headline separates coding tests passed from hidden checks. A test means one complete task run, not one hidden grading case. Authority Ledger has 60 private cases. It combines recorded-time corrections, effective-time intervals, nested membership, delegated authority, policy specificity, and canonical proofs. The bike task saves an SVG for human review and never increases the coding score. Authority Ledger passes only when all its cases pass.

The check pass rate is descriptive, not a calibrated capability score. Missing task grades leave the overall score incomplete, and startup failures are not scored.

These are recorded totals, not a model ranking. Tasks, budgets, thinking levels, transport, and environments may differ. Time excludes manager preflight and sums recorded test elapsed times. Estimates are not subscription invoices; partial observed costs remain marked incomplete.

Provider failures remain failures even when an interrupted solution passes its separate diagnostic grade. Recovered grades appear in task details and never count as completed passes in the comparison.

## Navigation

| Screen | Keys |
| --- | --- |
| Main menu | Up/Down selects; Enter opens |
| Model picker | Up/Down selects one model; Enter starts it |
| View Results | Up/Down selects; Enter opens the latest run; `v` opens the HTML report |
| Previous runs | Up/Down selects; Enter opens; `d` requests deletion |
| Progress/results | PgUp/PgDn scrolls; `d` requests deletion of a finished run |
| Active run | `c` asks to cancel; `y` confirms cancellation |
| Any screen | Esc goes back; `q` disconnects |

Closing the dashboard does not cancel background work. Open **View previous runs** to reconnect to an active run. An unavailable manager disables starting; a failed start response never triggers an automatic retry.

## History and storage

Runs started through this interface always keep history for comparison. Selecting a model does not remove previous results.

- [Saved state](D:/github/HemSoft/hemsoft-bench/.local/companion/state.json) contains model settings and job summaries. Its older internal `templates` schema remains compatible; that wording is not part of the UI.
- [Manager diagnostics](D:/github/HemSoft/hemsoft-bench/.local/companion/daemon.log) records startup problems.
- Each job owns a directory under `.local/managed-runs/`. The results screen shows the exact artifact path.
- [The generated HTML report](D:/github/HemSoft/hemsoft-bench/.local/reports/results.html) is replaced each time you press `v`; it is a view of retained state, not a separate result database.
- The connection file contains a private token. Do not share it.

The legacy PowerShell runner remains separate. Its retention policy is unchanged. Older external/API callers can still use their existing saved configurations; the simplified UI only submits single-model runs with history enabled.

## Delete a previous run

In **View previous runs**, select a run and press `d`. You can also press `d` on its results screen. The confirmation identifies the model, date, and run ID. Press `y` to permanently delete it, or Esc to keep it.

Deletion removes the entire owned job directory, including logs, saved code, results, and diagnostics, plus its saved history entry. For a visual-task job, deletion also removes its named SVG and PNG exports only if both still match their recorded hashes; a modified or linked export blocks deletion rather than removing someone else's file. It does not remove other runs, model settings, credentials, or the shared Docker image. Active runs and runs with uncertain cleanup cannot be deleted. A deleted result no longer participates in comparisons.

## Runtime and safety

Pi owns provider credentials. Candidate tools run in disposable Docker containers; grading uses a fresh container without feeding hidden results back to the model.

The `kangaroo-bike` visual task runs after Authority Ledger when you start a model from the existing picker. You can run it alone from the CLI without repeating the coding task. It saves a validated SVG and a bounded PNG side by side in `.local/results/`. The PNG comes from a separate pinned renderer image in an offline Docker container; the candidate image and grading image do not change. Existing named exports are preserved; a collision on either filename retains both candidates under the run directory, where the PNG can still be opened and rated from that run's results screen.

On a run's results screen, select **Open PNG** with Enter or `v`. Windows opens it using the default PNG app. Return to the terminal to enter a whole-number rating from 0 to 10 and press Enter, or press Esc to skip. The rating stays with the run and can be changed by opening the image again. It is not an automatic art score or a coding grade. If validation or rendering fails, the SVG stays under the run directory with a visible error, and the harness does not publish a misleading pair. The validator accepts local gradients and passive blur/drop-shadow filters, but still rejects scripts, external resources, and linked artifacts.

Codex calls use SSE inside the benchmark project. All models allow up to two agent-level retries per consecutive transient failure sequence, using the same conversation and candidate sandbox. The original time, request and observed estimated-cost budgets still apply. Provider-level retries remain disabled; quota/authentication failures are not retried. Progress and task details show scheduled retries, and recovered interruptions leave usage/cost incomplete even if the task finishes successfully. Changed execution policies remain separate in CLI reports; TUI comparisons warn that settings/retries may differ.

An attempt that still stops tries to capture saved code before cleanup and grade it without another model call. That snapshot remains separate from a completed grade. A hard process crash may prevent capture.

The detached manager binds to authenticated loopback HTTP and has a single-owner filesystem lock. On a manager restart, previously running workers are cancelled rather than silently resumed. Unknown cleanup remains protected from deletion.

## Build and checks

Run from [the project directory](D:/github/HemSoft/hemsoft-bench):

```powershell
.\build.cmd
go test -race ./...
go vet ./...
npm run check
npm run test:integration
```

The UI tests exercise selection, immediate single-model start, duplicate-key protection, progress/result transitions, comparisons, offline behavior, and terminal layouts. They use a fake local manager and do not make paid provider calls.
