package tui

import (
	"fmt"
	"strings"

	lip "charm.land/lipgloss/v2"
	"github.com/HemSoft/hemsoft-bench/internal/bench"
	"github.com/charmbracelet/x/ansi"
)

type resultRow struct {
	key    string
	model  bench.Model
	latest *bench.Job
	tasks  map[string]bench.Result
}

type resultCell struct {
	text  string
	style lip.Style
	full  bool
	total int
}

func (m Model) resultRows() []resultRow {
	rows := []resultRow{}
	indexes := map[string]int{}
	ensure := func(model bench.Model) int {
		key := modelKey(model)
		if i, ok := indexes[key]; ok {
			return i
		}
		indexes[key] = len(rows)
		rows = append(rows, resultRow{key: key, model: model, tasks: map[string]bench.Result{}})
		return len(rows) - 1
	}
	// Recent activity leads. Each cell keeps the newest recorded result for that
	// task, even when a newer run used a smaller task set.
	for i := len(m.state.Jobs) - 1; i >= 0; i-- {
		j := m.state.Jobs[i]
		row := &rows[ensure(j.Model)]
		if row.latest == nil {
			row.latest = j
		}
		for n := len(j.Results) - 1; n >= 0; n-- {
			r := j.Results[n]
			if _, exists := row.tasks[r.Task]; !exists {
				row.tasks[r.Task] = r
			}
		}
	}
	for _, setup := range m.modelSetups() {
		if len(setup.Models) == 1 {
			ensure(setup.Models[0])
		}
	}
	return rows
}

func shortResultStatus(status string) string {
	switch status {
	case "provider_error", "infrastructure_error", "cleanup_error":
		return "ERROR"
	case "missing_or_invalid_submission":
		return "INVALID"
	case "estimated_cost_limit":
		return "BUDGET"
	case "request_limit":
		return "LIMIT"
	case "needs_visual_review":
		return "REVIEW"
	case "artifact_conflict":
		return "CONFLICT"
	case "render_error":
		return "RENDER"
	case "cancelled", "aborted":
		return "CANCEL"
	case "timeout":
		return "TIMEOUT"
	case "queued", "running", "recovering", "cancelling":
		return "ACTIVE"
	case "passed":
		return "PASS"
	case "failed":
		return "FAIL"
	case "":
		return "-"
	default:
		return strings.ToUpper(strings.ReplaceAll(status, "_", " "))
	}
}

func codingResultCell(row resultRow, task string) resultCell {
	r, ok := row.tasks[task]
	if !ok {
		return resultCell{text: "-", style: muted}
	}
	if r.Grade != nil && (r.Status == "passed" || r.Status == "failed") {
		full := r.Status == "passed" && r.Grade.Total > 0 && r.Grade.Passed == r.Grade.Total
		style := danger
		if full {
			style = good
		}
		return resultCell{text: fmt.Sprintf("%d/%d", r.Grade.Passed, r.Grade.Total), style: style, full: full, total: r.Grade.Total}
	}
	style := danger
	if r.Status == "running" || r.Status == "queued" || r.Status == "recovering" {
		style = accent
	}
	return resultCell{text: shortResultStatus(r.Status), style: style}
}

func visualResultCell(row resultRow) resultCell {
	r, ok := row.tasks["kangaroo-bike"]
	if !ok {
		return resultCell{text: "-", style: muted}
	}
	if r.HumanScore != nil && *r.HumanScore >= 0 && *r.HumanScore <= 10 {
		return resultCell{text: fmt.Sprintf("%d/10", *r.HumanScore), style: good}
	}
	style := danger
	if r.Status == "needs_visual_review" || r.Status == "running" || r.Status == "queued" {
		style = accent
	}
	return resultCell{text: shortResultStatus(r.Status), style: style}
}

func latestRunCell(j *bench.Job) resultCell {
	if j == nil {
		return resultCell{text: "-", style: muted}
	}
	style := statusStyle(j.Status)
	text := shortResultStatus(j.Status)
	if _, rated := ratedRunStatus(j); rated {
		text = "REVIEWED"
		style = good
	}
	return resultCell{text: text, style: style}
}

func renderTableCell(cell resultCell, width int) string {
	text := fit(clean(cell.text), width)
	text += strings.Repeat(" ", max(0, width-ansi.StringWidth(text)))
	return cell.style.Render(text)
}

func plainTableCell(text string, width int, style lip.Style) string {
	return renderTableCell(resultCell{text: text, style: style}, width)
}

func (m Model) resultsView() string {
	rows := m.resultRows()
	width := max(30, m.width-4)
	lines := []string{accent.Render("RESULTS BY MODEL")}
	if width >= 92 {
		lines = append(lines, "Latest Authority Ledger checks and bike review for each model setup.")
	} else {
		lines = append(lines, "Latest result for each test.", "Authority is passed/total. Bike is review or rating.")
	}
	lines = append(lines, "")
	if len(rows) == 0 {
		return strings.Join(append(lines, "No model results yet. Run a model to populate this table."), "\n")
	}

	wide := width >= 92
	modelWidth := min(34, width-19)
	if wide {
		modelWidth = min(34, width-30)
	}
	modelWidth = max(12, modelWidth)
	headers := []string{plainTableCell("MODEL / THINKING", modelWidth, muted), plainTableCell("AUTHORITY", 9, muted), plainTableCell("BIKE", 8, muted)}
	separator := []string{strings.Repeat("-", modelWidth), strings.Repeat("-", 9), strings.Repeat("-", 8)}
	if wide {
		headers = append(headers, plainTableCell("LATEST RUN", 10, muted))
		separator = append(separator, strings.Repeat("-", 10))
	}
	lines = append(lines, strings.Join(headers, " "), strings.Join(separator, " "))

	bodyLimit := max(1, m.height-6)
	capacity := max(1, bodyLimit-len(lines))
	showRange := len(rows) > capacity
	if showRange {
		capacity = max(1, capacity-1)
	}
	cursor := clamp(m.resultsCursor, 0, len(rows)-1)
	start := max(0, cursor-capacity+1)
	for i := start; i < len(rows) && i < start+capacity; i++ {
		row := rows[i]
		prefix := "  "
		modelStyle := lip.NewStyle()
		if i == cursor {
			prefix = "> "
			modelStyle = selected
		}
		modelText := prefix + clean(row.model.Model+" / "+row.model.Thinking)
		cells := []string{plainTableCell(modelText, modelWidth, modelStyle), renderTableCell(codingResultCell(row, "authority-ledger"), 9), renderTableCell(visualResultCell(row), 8)}
		if wide {
			cells = append(cells, renderTableCell(latestRunCell(row.latest), 10))
		}
		lines = append(lines, strings.Join(cells, " "))
	}
	if showRange {
		lines = append(lines, muted.Render(fmt.Sprintf("Showing %d-%d of %d model setups.", start+1, min(len(rows), start+capacity), len(rows))))
	}
	return strings.Join(lines, "\n")
}
