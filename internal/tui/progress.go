package tui

import (
	"fmt"
	"strings"

	lip "charm.land/lipgloss/v2"
	"github.com/HemSoft/hemsoft-bench/internal/bench"
)

// This bar counts finished tests, not passed checks, time elapsed, or model tokens.
// Distinct textures keep completed, active, and waiting tests legible without color.
func testProgress(j *bench.Job, screenWidth int) []string {
	total := j.Template.Attempts()
	if total < 1 {
		return []string{"0 / 0 tests", "  No tests configured"}
	}
	done := min(len(j.Results), total)
	width := min(42, max(12, screenWidth-10))
	active := j.Status == "running" && j.Task != "" && done < total
	complete := lip.NewStyle().Foreground(lip.Color("6"))
	current := lip.NewStyle().Foreground(lip.Color("6")).Bold(true)
	waiting := lip.NewStyle().Foreground(lip.Color("7"))
	var parts []string
	if total <= 8 {
		usable := width - (total - 1)
		for i := 0; i < total; i++ {
			cells := usable / total
			if i < usable%total {
				cells++
			}
			switch {
			case i < done:
				parts = append(parts, complete.Render(strings.Repeat("█", cells)))
			case i == done && active:
				parts = append(parts, current.Render(strings.Repeat("▒", cells)))
			default:
				parts = append(parts, waiting.Render(strings.Repeat("░", cells)))
			}
		}
		return []string{fmt.Sprintf("%d / %d tests", done, total), "  " + strings.Join(parts, " ")}
	}
	filled := width * done / total
	parts = append(parts, complete.Render(strings.Repeat("█", filled)))
	if active && filled < width {
		parts = append(parts, current.Render("▒"))
		filled++
	}
	parts = append(parts, waiting.Render(strings.Repeat("░", width-filled)))
	return []string{fmt.Sprintf("%d / %d tests", done, total), "  " + strings.Join(parts, "")}
}
