package tui

import (
	"fmt"
	"github.com/HemSoft/hemsoft-bench/internal/bench"
)

// This is a descriptive check pass rate, not a calibrated model capability score.
// Missing grades and interrupted snapshots must never turn into a perfect score.
func scoreSummary(j *bench.Job) []string {
	passed, total, attempts := 0, 0, 0
	codeAttempts := 0
	for _, task := range j.Template.Tasks {
		if task != "kangaroo-bike" {
			codeAttempts += j.Template.Repeat
		}
	}
	complete := len(j.Results) == j.Template.Attempts() && len(j.Results) > 0
	for _, r := range j.Results {
		if r.Status == "passed" {
			attempts++
		}
		if r.Task == "kangaroo-bike" {
			continue
		}
		if r.Grade == nil || (r.Status != "passed" && r.Status != "failed") {
			complete = false
			continue
		}
		passed += r.Grade.Passed
		total += r.Grade.Total
	}
	lines := []string{}
	if total == 0 {
		if codeAttempts == 0 {
			lines = append(lines, "Visual task: human review required; no automatic score.")
		} else {
			lines = append(lines, "Not scored: no completed task grades.")
		}
	} else if complete {
		lines = append(lines, fmt.Sprintf("Check pass rate: %.1f%% (%d/%d hidden checks)", 100*float64(passed)/float64(total), passed, total))
	} else {
		lines = append(lines, fmt.Sprintf("Score incomplete: %d/%d graded checks passed.", passed, total))
	}
	if codeAttempts > 0 {
		label := "Coding tests passed"
		lines = append(lines, fmt.Sprintf("%s: %d/%d.", label, attempts, codeAttempts))
	}
	for _, r := range j.Results {
		if r.Task == "kangaroo-bike" && r.Artifact != nil && r.Artifact.Published {
			if r.HumanScore != nil {
				lines = append(lines, good.Render(fmt.Sprintf("Visual rating: %d/10", *r.HumanScore)))
			} else {
				lines = append(lines, "SVG saved for human review; appearance ungraded.")
			}
		}
	}
	families := map[string]bool{}
	for _, task := range j.Template.Tasks {
		if task != "kangaroo-bike" {
			families[task] = true
		}
	}
	if len(families) > 0 {
		label := "task types"
		if len(families) == 1 {
			label = "task type"
		}
		if codeAttempts != j.Template.Attempts() {
			label = "coding tasks"
			if len(families) == 1 {
				label = "coding task"
			}
		}
		lines = append(lines, fmt.Sprintf("Scope: %d %s; difficulty uncalibrated.", len(families), label))
	}
	return lines
}
