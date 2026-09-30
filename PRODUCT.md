# Product

<!-- impeccable:product-schema 1 -->

## Platform

Terminal application, initially Windows PowerShell and Windows Terminal, with a generated local HTML results report for richer comparison and visual review. The report is an output view, not a hosted service or browser-based configuration interface.

## Stack

Go companion with Bubble Tea, Bubbles, and Lip Gloss. Existing Node/Pi evaluator and disposable Docker sandboxes remain responsible for execution and grading.

## Users and purpose

A local operator comparing coding models against private benchmark tasks. Choose one model, start its benchmark with Enter, watch concrete progress, and compare the result with retained previous runs.

## Operating context

Provider authentication stays in Pi. A background Go manager owns jobs. Closing the dashboard disconnects without stopping jobs; reopening reconnects. Cancellation is explicit. Existing legacy runs must remain untouched during migration.

## Capabilities and constraints

Saved configurations contain provider/thinking selections, tasks, repeats, and per-attempt budgets. A model run executes Authority Ledger, the 60-case coding challenge, then the separate unscored kangaroo-on-a-bike SVG task. Authority Ledger caps agent work at 30 minutes; its isolated grading phase has no task-specific time cutoff and remains cancellable by the operator. The interface starts exactly one model at a time per selection. Enter on a model starts immediately, with no review or extra confirmation. Future runs retain history for comparison. The background manager can still manage multiple independent jobs. Each managed job owns its artifacts and cancellation marker. Retention must never remove active runs. Limits and partial usage remain visible; activity is not proof of correctness. Concurrent execution can distort timing through shared machine or provider contention.

The HTML results report regenerates from retained state on demand. It embeds verified bike PNGs, supports grid and list viewing, and accepts future owned image or self-contained webpage presentations. Webpage candidates run in network-blocked sandbox frames. The report contains no manager credentials and needs no local web server.

## Confirmed interface

A keyboard-first TUI whose home menu contains Start a new run, View Results, and View previous runs. Starting opens a single-model picker; Enter starts the selected model and opens progress. View Results compares Authority Ledger and visual outcomes. Pressing `v` there opens the generated HTML comparison and visual gallery. Completion automatically presents results and comparison with past runs. Previous runs opens a selectable history list. No suites, settings screens, template wording, or start-review dialog. Empty, loading, error, cancellation, and disconnected states remain visible. No browser-based setup.
