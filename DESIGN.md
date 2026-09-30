# Terminal design

## User-defined flow

The main menu has exactly three actions: Start a new run, View Results, and View previous runs. No tabs, suite picker, template terminology, configuration editor, or start-review dialog.

Start a new run opens a single-model list. Its selected model's tasks, thinking level, and budget are visible. The default task set is Authority Ledger followed by the bike visual. Authority Ledger agent work is capped at 30 minutes even when the saved general limit is higher; grading has no task-specific cutoff. Enter starts that exact model immediately. One request is sent, repeated keys cannot duplicate it, and the UI follows the manager's returned batch identity rather than guessing that the newest job belongs to this user.

View Results opens a model-by-test table. Each row represents one provider, model, and thinking setup. Authority shows the latest Authority Ledger score out of 60, and Bike shows review state or the saved human rating. Recent model activity leads, configured but untested models remain visible, and Enter opens the selected model's latest run without starting anything. Pressing `v` regenerates and opens the local HTML results report without starting benchmark work.

View previous runs opens a list of active and completed jobs. Enter opens the selected job without starting anything.

## Progress and completion

A single full-width page follows the run. Model and outcome lead; a segmented, text-labeled `n / n tests` bar sits directly above the current task name. Completed tests, the active test, and waiting tests have distinct textures. The bar never treats an active task or an ungraded SVG as a scored pass. Elapsed time and actual tool activity follow. Quiet streams are not called hung. Closing or leaving the page does not cancel work.

Completion automatically brings results into view. Comparison comes before detailed task output, so other recorded results are visible without finding another screen. The selected run is first. The headline separates passed coding tests from the percentage of graded hidden checks, and states the number of task types and uncalibrated difficulty. Missing coding grades leave the score incomplete. Results repeat the test-count bar above the detailed task names; the visual test stays separate from coding grades. A selectable Open PNG action launches the Windows default app, then prompts for an optional 0 to 10 human rating on return to the terminal. The rating persists per result and never changes coding checks or the recorded run status. After the user rates the single visual task, the displayed review label becomes their green 0 to 10 rating in history, the run header, comparison, and task details; genuine failures stay visible. The brief success message is green. Recovered grades never become completed passes. Costs remain estimates; incomplete observations are identified. Comparison is descriptive, not a ranking across possibly different settings or environments.

## Appearance and layout

Use the terminal's own background and font. Cyan identifies focus and active work, green identifies passes, and red identifies errors. Text labels carry every status; a > marker carries selection without depending on color.

Keep one column at every width. The main menu has three spaced choices, the model picker has a short list followed by its selected settings, the cross-model results screen uses a compact aligned table, and individual progress/results uses a scrollable viewport. The results table drops its latest-run column at narrow widths and keeps the selected row visible while scrolling. No sidebar, nested panels, ornamental counters, or decorative animation.

Support 55 columns by 18 rows and larger. Below that size, show a resize message and disable hidden start actions. Footer shortcuts describe only the current screen. Enter starts work only on the model picker.

## HTML results report

The report is an Operate surface with the visual work acting as an Experience surface inside it. A dark ink masthead establishes the report, then a light comparison sheet carries the task. Deep green identifies navigation and focus, and compact tinted labels carry status. The page uses the local UI font stack, a broad results matrix, and media-first figures rather than a dashboard of ornamental metric cards.

The first viewport states what the report is, how many model setups exist, and how many have Authority Ledger or visual results. The model matrix follows before the visual gallery. Bike images appear together in a responsive two-column proof sheet with grid/list controls and full-size previews. Future visual tasks can publish owned raster presentations or self-contained webpages. Webpages use the same gallery frame, expand to a large viewport, and execute only inside sandboxed frames with network, forms, navigation, and local-origin access blocked.

The report regenerates at `.local/reports/results.html` each time the operator presses `v`. It embeds verified images and webpage source so it needs neither the manager token nor a local server. Missing or changed artifacts produce an explicit unavailable state instead of a broken or substituted preview. The report works at desktop and phone widths, supports keyboard focus and reduced motion, and prints without interactive controls.

## Interaction and persistence

Bubble Tea owns the alternate screen and Bubbles owns the progress viewport. Poll with at most one request in flight. Preserve the selected model and historical job by identity across responses. Offline state disables starts. An ambiguous queue response directs the user to history instead of automatically retrying.

New runs keep history for comparison. Existing backend configuration schemas remain compatible, but their terminology does not determine navigation. Cancellation has its own explicit confirmation; it is not part of starting a run. History and completed results expose d to delete a run. Deletion requires y after a confirmation naming the fixed run ID, model, date, and artifact scope. Polling never changes the confirmation's target. Active or cleanup-uncertain jobs stay protected.

## Verification

Behavior tests cover the exact three-choice menu, one Enter to start one model, duplicate-input suppression, returned-job tracking, the model-by-test table, `v` opening the HTML report, automatic completion, honest recovery comparisons, navigation without mutation, and disconnect. Report tests cover result rendering, verified image embedding, sandboxed webpage presentations, and rejection of files outside an owned run. Terminal snapshots cover home, model selection, cross-model results, history, progress, individual results, and empty history at wide, narrow, and minimum supported widths. Browser review covers desktop and mobile report layouts.
