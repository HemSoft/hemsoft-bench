package bench

import (
	_ "embed"
	"encoding/base64"
	"errors"
	"fmt"
	htmltmpl "html/template"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed report_template.html
var reportHTML string

var resultsReportTemplate = htmltmpl.Must(htmltmpl.New("results-report").Parse(reportHTML))
var reportEastern, _ = time.LoadLocation("America/New_York")

type reportCell struct {
	Text string
	Tone string
}

type reportRow struct {
	Provider  string
	Model     string
	Thinking  string
	Scheduler reportCell
	Bike      reportCell
	Clock     reportCell
	Latest    reportCell
	Date      string
}

type reportMedia struct {
	Kind     string
	Label    string
	Model    string
	Provider string
	Thinking string
	Status   string
	Tone     string
	Date     string
	Source   htmltmpl.URL
	HTML     string
	Note     string
}

type reportPage struct {
	Generated       string
	Rows            []reportRow
	Media           []reportMedia
	SetupCount      int
	SchedulerTested int
	VisualCount     int
}

type reportSourceRow struct {
	model  Model
	latest *Job
	tasks  map[string]Result
}

func reportModelKey(model Model) string {
	return model.Provider + "/" + model.Model + "@" + model.Thinking
}

func reportSourceRows(state State) []reportSourceRow {
	rows := []reportSourceRow{}
	indexes := map[string]int{}
	ensure := func(model Model) int {
		key := reportModelKey(model)
		if i, ok := indexes[key]; ok {
			return i
		}
		indexes[key] = len(rows)
		rows = append(rows, reportSourceRow{model: model, tasks: map[string]Result{}})
		return len(rows) - 1
	}
	for i := len(state.Jobs) - 1; i >= 0; i-- {
		job := state.Jobs[i]
		row := &rows[ensure(job.Model)]
		if row.latest == nil {
			row.latest = job
		}
		for n := len(job.Results) - 1; n >= 0; n-- {
			result := job.Results[n]
			if _, exists := row.tasks[result.Task]; !exists {
				row.tasks[result.Task] = result
			}
		}
	}
	for _, saved := range state.Templates {
		for _, model := range saved.Models {
			ensure(model)
		}
	}
	return rows
}

func reportStatus(status string) string {
	switch status {
	case "provider_error", "infrastructure_error", "cleanup_error":
		return "Error"
	case "missing_or_invalid_submission":
		return "Invalid"
	case "needs_visual_review":
		return "Needs review"
	case "queued", "running", "recovering", "cancelling":
		return "Active"
	case "passed":
		return "Passed"
	case "failed":
		return "Failed"
	case "":
		return "Not run"
	default:
		return strings.ToUpper(strings.ReplaceAll(status, "_", " "))
	}
}

func reportTone(status string) string {
	switch status {
	case "passed":
		return "good"
	case "queued", "running", "recovering", "cancelling", "needs_visual_review":
		return "active"
	case "":
		return "muted"
	default:
		return "bad"
	}
}

func reportCodingCell(result Result, ok bool) (reportCell, bool, int) {
	if !ok {
		return reportCell{Text: "Not run", Tone: "muted"}, false, 0
	}
	if result.Grade != nil && (result.Status == "passed" || result.Status == "failed") {
		complete := result.Status == "passed" && result.Grade.Total > 0 && result.Grade.Passed == result.Grade.Total
		tone := "bad"
		if complete {
			tone = "good"
		}
		return reportCell{Text: fmt.Sprintf("%d / %d", result.Grade.Passed, result.Grade.Total), Tone: tone}, complete, result.Grade.Total
	}
	return reportCell{Text: reportStatus(result.Status), Tone: reportTone(result.Status)}, false, 0
}

func reportVisualCell(result Result, ok bool) reportCell {
	if !ok {
		return reportCell{Text: "Not run", Tone: "muted"}
	}
	if result.HumanScore != nil && *result.HumanScore >= 0 && *result.HumanScore <= 10 {
		return reportCell{Text: fmt.Sprintf("%d / 10", *result.HumanScore), Tone: "good"}
	}
	return reportCell{Text: reportStatus(result.Status), Tone: reportTone(result.Status)}
}

func reportRunCell(job *Job) reportCell {
	if job == nil {
		return reportCell{Text: "Not run", Tone: "muted"}
	}
	if status, ok := reportRatedRun(job); ok {
		return reportCell{Text: status, Tone: "good"}
	}
	return reportCell{Text: reportStatus(job.Status), Tone: reportTone(job.Status)}
}

func reportRatedRun(job *Job) (string, bool) {
	if job.Status != "needs_visual_review" {
		return "", false
	}
	expected := 0
	for _, task := range job.Template.Tasks {
		if task == "kangaroo-bike" || task == "world-clock" {
			expected += job.Template.Repeat
		}
	}
	count, total := 0, 0
	for _, result := range job.Results {
		if result.Task != "kangaroo-bike" && result.Task != "world-clock" {
			continue
		}
		total++
		if result.HumanScore != nil && *result.HumanScore >= 0 && *result.HumanScore <= 10 {
			count++
		}
	}
	if total != expected || expected == 0 {
		return "", false
	}
	if total == 1 && count == 1 {
		for _, result := range job.Results {
			if result.Task == "kangaroo-bike" || result.Task == "world-clock" {
				return fmt.Sprintf("Reviewed %d / 10", *result.HumanScore), true
			}
		}
	}
	if total > 1 && count == total {
		return fmt.Sprintf("%d visuals reviewed", count), true
	}
	return "", false
}

func reportDate(job *Job) string {
	if job == nil {
		return ""
	}
	stamp := job.QueuedAt
	if job.StartedAt != nil {
		stamp = *job.StartedAt
	}
	if stamp.IsZero() {
		return ""
	}
	return stamp.In(reportEastern).Format("Jan 02, 2006 · 3:04 PM MST")
}

func (m *Manager) reportPageLocked() reportPage {
	state := clone(m.state)
	sources := reportSourceRows(state)
	page := reportPage{Generated: time.Now().In(reportEastern).Format("Jan 02, 2006 · 3:04 PM MST"), SetupCount: len(sources)}
	for _, source := range sources {
		schedulerResult, hasScheduler := source.tasks["resilient-scheduler"]
		bikeResult, hasBike := source.tasks["kangaroo-bike"]
		clockResult, hasClock := source.tasks["world-clock"]
		if hasScheduler && schedulerResult.Grade != nil {
			page.SchedulerTested++
		}
		scheduler, _, _ := reportCodingCell(schedulerResult, hasScheduler)
		page.Rows = append(page.Rows, reportRow{Provider: source.model.Provider, Model: source.model.Model, Thinking: source.model.Thinking, Scheduler: scheduler, Bike: reportVisualCell(bikeResult, hasBike), Clock: reportVisualCell(clockResult, hasClock), Latest: reportRunCell(source.latest), Date: reportDate(source.latest)})
	}
	page.Media = m.reportMediaLocked(state)
	page.VisualCount = len(page.Media)
	return page
}

func (m *Manager) reportMediaLocked(state State) []reportMedia {
	media := []reportMedia{}
	for jobIndex := len(state.Jobs) - 1; jobIndex >= 0; jobIndex-- {
		job := state.Jobs[jobIndex]
		for resultIndex := len(job.Results) - 1; resultIndex >= 0; resultIndex-- {
			result := job.Results[resultIndex]
			if result.Artifact != nil && result.Task == "kangaroo-bike" {
				item := reportMedia{Kind: "image", Label: "Kangaroo bike", Model: job.Model.Model, Provider: job.Model.Provider, Thinking: job.Model.Thinking, Status: reportVisualCell(result, true).Text, Tone: reportVisualCell(result, true).Tone, Date: reportDate(job)}
				_, _, path, err := m.visualResult(job.ID, result.ID)
				if err == nil {
					if data, readErr := os.ReadFile(path); readErr == nil {
						item.Source = htmltmpl.URL("data:image/png;base64," + base64.StdEncoding.EncodeToString(data))
					} else {
						item.Note = "Preview unavailable: " + readErr.Error()
					}
				} else {
					item.Note = "Preview unavailable: " + err.Error()
				}
				media = append(media, item)
			}
			for _, presentation := range result.Presentations {
				media = append(media, m.reportPresentation(job, result, presentation))
			}
		}
	}
	return media
}

func (m *Manager) reportPresentation(job *Job, result Result, artifact PresentationArtifact) reportMedia {
	label := strings.TrimSpace(artifact.Label)
	if label == "" {
		label = strings.ReplaceAll(result.Task, "-", " ")
	}
	status := reportVisualCell(result, true)
	item := reportMedia{Kind: artifact.Kind, Label: label, Model: job.Model.Model, Provider: job.Model.Provider, Thinking: job.Model.Thinking, Status: status.Text, Tone: status.Tone, Date: reportDate(job)}
	data, err := readOwnedPresentation(job, artifact.File)
	if err != nil {
		item.Note = "Preview unavailable: " + err.Error()
		return item
	}
	switch artifact.Kind {
	case "image":
		mime := http.DetectContentType(data)
		if mime != "image/png" && mime != "image/jpeg" && mime != "image/gif" && mime != "image/webp" {
			item.Note = "Preview unavailable: presentation image must be PNG, JPEG, GIF, or WebP"
			return item
		}
		item.Source = htmltmpl.URL("data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data))
	case "webpage":
		if len(data) > 5*1024*1024 {
			item.Note = "Preview unavailable: webpage exceeds 5 MB"
			return item
		}
		item.HTML = sandboxDocument(string(data))
	default:
		item.Note = "Preview unavailable: unsupported presentation kind"
	}
	return item
}

func readOwnedPresentation(job *Job, path string) ([]byte, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("presentation file is missing")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	root, err := filepath.EvalSymlinks(job.RunDir)
	if err != nil {
		return nil, errors.New("owned run directory is missing")
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, errors.New("presentation file is missing")
	}
	rel, err := filepath.Rel(root, resolved)
	if err != nil || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return nil, errors.New("presentation file is outside its owned run")
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 1 || info.Size() > 8*1024*1024 {
		return nil, errors.New("presentation file is missing, linked, or too large")
	}
	return os.ReadFile(absolute)
}

func sandboxDocument(source string) string {
	// Keep the policy in the first bytes of a fresh document. Candidate markup
	// follows inside the body so a long prologue or second head cannot push the
	// policy past the browser's meta-CSP processing window.
	policy := `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline' data:; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`
	return "<!doctype html><html><head>" + policy + "</head><body>" + source + "</body></html>"
}

func (m *Manager) writeResultsReportLocked() (string, error) {
	directory := filepath.Join(m.root, ".local", "reports")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	path := filepath.Join(directory, "results.html")
	temporary, err := os.CreateTemp(directory, ".results-*.html")
	if err != nil {
		return "", err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err = temporary.Chmod(0600); err == nil {
		err = resultsReportTemplate.Execute(temporary, m.reportPageLocked())
	}
	if err == nil {
		err = temporary.Sync()
	}
	closeErr := temporary.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	if err = os.Remove(path); err != nil && !os.IsNotExist(err) {
		return "", err
	}
	if err = os.Rename(name, path); err != nil {
		return "", err
	}
	return path, nil
}

// OpenResultsReport regenerates the static report from persisted manager state
// before opening it. The report never needs manager credentials or a web server.
func (m *Manager) OpenResultsReport() (string, error) {
	m.mu.Lock()
	path, err := m.writeResultsReportLocked()
	m.mu.Unlock()
	if err != nil {
		return "", err
	}
	if err = m.openReport(path); err != nil {
		return "", err
	}
	return path, nil
}
