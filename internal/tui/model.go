package tui

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"
	"unicode"

	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	lip "charm.land/lipgloss/v2"
	"github.com/HemSoft/hemsoft-bench/internal/bench"
	"github.com/charmbracelet/x/ansi"
)

type stateMsg struct {
	State bench.State
	Err   error
}
type queuedMsg struct {
	BatchID string
	Err     error
}
type cancelledMsg struct{ Err error }
type deletedMsg struct {
	ID  string
	Err error
}
type imageOpenedMsg struct {
	JobID, ResultID string
	Err             error
}
type resultsHTMLOpenedMsg struct {
	JobID, ResultID string
	Err             error
}
type imageScoredMsg struct {
	JobID, ResultID string
	Score           int
	Err             error
}
type tickMsg time.Time

const (
	homeScreen    = "home"
	modelScreen   = "models"
	resultsScreen = "results-table"
	historyScreen = "history"
	runScreen     = "run"
)

var accent = lip.NewStyle().Foreground(lip.Color("6")).Bold(true)
var muted = lip.NewStyle().Foreground(lip.Color("7"))
var selected = lip.NewStyle().Foreground(lip.Color("0")).Background(lip.Color("6"))
var danger = lip.NewStyle().Foreground(lip.Color("1")).Bold(true)
var good = lip.NewStyle().Foreground(lip.Color("2"))
var eastern, _ = time.LoadLocation("America/New_York")

type Model struct {
	client                                                *bench.Client
	state                                                 bench.State
	width, height                                         int
	screen                                                string
	homeCursor, modelCursor, resultsCursor, historyCursor int
	connected, busy, polling                              bool
	cancelPrompt                                          bool
	ratingPrompt                                          bool
	ratingInput                                           string
	ratingJobID, ratingResultID                           string
	deleteTarget                                          *bench.Job
	removed                                               map[string]bool
	watchID, watchBatch, err, success                     string
	detail                                                viewport.Model
	now                                                   time.Time
}

func New(c *bench.Client) Model {
	detail := viewport.New(viewport.WithWidth(96), viewport.WithHeight(24))
	detail.SoftWrap = true
	return Model{client: c, screen: homeScreen, width: 100, height: 30, polling: true, now: time.Now(), detail: detail}
}
func tick() tea.Cmd { return tea.Tick(time.Second, func(t time.Time) tea.Msg { return tickMsg(t) }) }
func (m Model) fetch() tea.Cmd {
	return func() tea.Msg { var s bench.State; e := m.client.Call("GET", "/state", nil, &s); return stateMsg{s, e} }
}
func (m Model) Init() tea.Cmd { return tea.Batch(m.fetch(), tick()) }
func (m Model) start(t bench.Template) tea.Cmd {
	// The displayed model is the complete selection. Retain every run for comparison.
	t.KeepHistory = true
	t.Concurrency = 1
	return func() tea.Msg {
		var reply struct {
			BatchID string `json:"batchId"`
		}
		err := m.client.Call("POST", "/queue", t, &reply)
		if err == nil && reply.BatchID == "" {
			err = fmt.Errorf("manager returned no run identity")
		}
		return queuedMsg{reply.BatchID, err}
	}
}
func (m Model) cancel(id string) tea.Cmd {
	return func() tea.Msg { return cancelledMsg{m.client.Call("POST", "/jobs/"+id+"/cancel", nil, nil)} }
}
func canDelete(j *bench.Job) bool {
	return j != nil && bench.Terminal(j.Status) && j.PID == 0 && !j.CleanupUncertain && j.Status != "interrupted" && j.Status != "cleanup_error"
}
func (m Model) deleteRun(id string) tea.Cmd {
	return func() tea.Msg { return deletedMsg{id, m.client.Call("POST", "/jobs/"+id+"/delete", nil, nil)} }
}
func (m Model) openImage(jobID, resultID string) tea.Cmd {
	return func() tea.Msg {
		return imageOpenedMsg{jobID, resultID, m.client.Call("POST", "/jobs/"+jobID+"/open-image", map[string]string{"resultId": resultID}, nil)}
	}
}
func (m Model) openResultsHTML(ids ...string) tea.Cmd {
	jobID, resultID := "", ""
	if len(ids) == 2 {
		jobID, resultID = ids[0], ids[1]
	}
	return func() tea.Msg {
		return resultsHTMLOpenedMsg{jobID, resultID, m.client.Call("POST", "/results/open-html", nil, nil)}
	}
}
func (m Model) scoreImage(score int) tea.Cmd {
	jobID, resultID := m.ratingJobID, m.ratingResultID
	return func() tea.Msg {
		return imageScoredMsg{jobID, resultID, score, m.client.Call("POST", "/jobs/"+jobID+"/score-image", map[string]any{"resultId": resultID, "score": score}, nil)}
	}
}
func visualTask(task string) bool { return task == "kangaroo-bike" || task == "world-clock" }
func reviewableVisual(j *bench.Job) (*bench.Result, string) {
	if j == nil || !bench.Terminal(j.Status) {
		return nil, ""
	}
	var rated *bench.Result
	var ratedKind string
	for i := len(j.Results) - 1; i >= 0; i-- {
		r := &j.Results[i]
		kind := ""
		if r.Task == "kangaroo-bike" && r.ID != "" && r.Artifact != nil && (r.Artifact.PNGPublicFile != "" || r.Artifact.PNGOwnedFile != "") {
			kind = "image"
		}
		if r.Task == "world-clock" && r.ID != "" {
			for _, presentation := range r.Presentations {
				if presentation.Kind == "webpage" {
					kind = "webpage"
					break
				}
			}
		}
		if kind != "" {
			if r.HumanScore == nil {
				return r, kind
			}
			if rated == nil {
				rated, ratedKind = r, kind
			}
		}
	}
	return rated, ratedKind
}
func reviewableImage(j *bench.Job) *bench.Result {
	r, kind := reviewableVisual(j)
	if kind == "image" {
		return r
	}
	return nil
}
func (m *Model) filterDeleted() {
	jobs := make([]*bench.Job, 0, len(m.state.Jobs))
	for _, j := range m.state.Jobs {
		if !m.removed[j.ID] {
			jobs = append(jobs, j)
		}
	}
	m.state.Jobs = jobs
}
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = v.Width, v.Height
		m.resize()
		m.refreshDetail()
		return m, nil
	case stateMsg:
		m.polling = false
		wasRunning := false
		if j := m.watchedJob(); j != nil {
			wasRunning = !bench.Terminal(j.Status)
		}
		m.connected = v.Err == nil
		if v.Err != nil {
			m.success = ""
			m.err = "Disconnected. Run status is unknown; starting is disabled. " + v.Err.Error()
		} else {
			// Preserve the visible selection across polling, rather than selecting a new
			// model or history row when another dashboard saves settings or starts work.
			modelID := ""
			options := m.modelSetups()
			if len(options) > 0 {
				modelID = modelKey(options[clamp(m.modelCursor, 0, len(options)-1)].Models[0])
			}
			resultsKey := ""
			resultRows := m.resultRows()
			if len(resultRows) > 0 {
				resultsKey = resultRows[clamp(m.resultsCursor, 0, len(resultRows)-1)].key
			}
			historyID := ""
			if j := m.historyJob(); j != nil {
				historyID = j.ID
			}
			m.state = v.State
			m.filterDeleted()
			options = m.modelSetups()
			m.modelCursor = clamp(m.modelCursor, 0, len(options)-1)
			for i, t := range options {
				if modelKey(t.Models[0]) == modelID {
					m.modelCursor = i
					break
				}
			}
			resultRows = m.resultRows()
			m.resultsCursor = clamp(m.resultsCursor, 0, len(resultRows)-1)
			for i, row := range resultRows {
				if row.key == resultsKey {
					m.resultsCursor = i
					break
				}
			}
			m.historyCursor = clamp(m.historyCursor, 0, len(m.state.Jobs)-1)
			for i, j := range m.state.Jobs {
				if j.ID == historyID {
					m.historyCursor = len(m.state.Jobs) - 1 - i
					break
				}
			}
			if m.watchBatch != "" && m.watchID == "" {
				for _, j := range m.state.Jobs {
					if j.BatchID == m.watchBatch {
						m.watchID = j.ID
						break
					}
				}
			}
			if strings.HasPrefix(m.err, "Disconnected.") {
				m.err = ""
			}
		}
		m.refreshDetail()
		if j := m.watchedJob(); wasRunning && j != nil && bench.Terminal(j.Status) {
			m.detail.GotoTop()
		}
		return m, nil
	case tickMsg:
		m.now = time.Time(v)
		m.refreshDetail()
		if !m.polling {
			m.polling = true
			return m, tea.Batch(m.fetch(), tick())
		}
		return m, tick()
	case queuedMsg:
		m.busy = false
		if v.Err != nil {
			// A lost HTTP response does not prove the manager rejected the request.
			// Never retry automatically or leave repeated Enter poised to start twice.
			m.screen = historyScreen
			m.err = "Start request failed. Check this history before retrying: " + v.Err.Error()
		} else {
			m.screen = runScreen
			m.watchBatch = v.BatchID
			m.watchID = ""
			m.err = ""
			m.detail.GotoTop()
		}
		m.refreshDetail()
		return m, nil
	case deletedMsg:
		m.busy = false
		m.deleteTarget = nil
		if v.Err != nil {
			m.err = "Delete failed: " + v.Err.Error()
			return m, nil
		}
		if m.removed == nil {
			m.removed = map[string]bool{}
		}
		m.removed[v.ID] = true
		m.filterDeleted()
		m.historyCursor = clamp(m.historyCursor, 0, len(m.state.Jobs)-1)
		m.screen = historyScreen
		m.err = ""
		if m.watchID == v.ID {
			m.watchID = ""
			m.watchBatch = ""
		}
		return m, nil
	case cancelledMsg:
		m.busy = false
		m.cancelPrompt = false
		if v.Err != nil {
			m.err = v.Err.Error()
		}
		return m, nil
	case imageOpenedMsg:
		m.busy = false
		if v.Err != nil {
			m.err = "Could not open PNG: " + v.Err.Error()
			return m, nil
		}
		m.ratingJobID, m.ratingResultID = v.JobID, v.ResultID
		m.ratingInput = ""
		m.ratingPrompt = true
		m.err = ""
		return m, nil
	case resultsHTMLOpenedMsg:
		m.busy = false
		if v.Err != nil {
			m.err = "Could not open HTML results: " + v.Err.Error()
			return m, nil
		}
		m.err = ""
		m.success = "Opened HTML results."
		if v.JobID != "" && v.ResultID != "" {
			m.ratingJobID, m.ratingResultID = v.JobID, v.ResultID
			m.ratingInput = ""
			m.ratingPrompt = true
		}
		return m, nil
	case imageScoredMsg:
		m.busy = false
		if v.Err != nil {
			m.err = "Could not save rating: " + v.Err.Error()
			return m, nil
		}
		m.ratingPrompt = false
		m.ratingJobID, m.ratingResultID = "", ""
		m.ratingInput = ""
		// Show the confirmed rating immediately, without waiting for the next poll.
		for _, j := range m.state.Jobs {
			if j.ID == v.JobID {
				for i := range j.Results {
					if j.Results[i].ID == v.ResultID {
						j.Results[i].HumanScore = &v.Score
					}
				}
			}
		}
		m.err = ""
		m.success = "Rating saved."
		m.refreshDetail()
		return m, m.fetch()
	case tea.KeyPressMsg:
		key := v.String()
		if key == "q" || key == "ctrl+c" {
			return m, tea.Quit
		}
		if m.busy {
			return m, nil
		}
		m.success = ""
		if key == "esc" {
			if m.ratingPrompt {
				m.ratingPrompt = false
				m.ratingJobID, m.ratingResultID = "", ""
				m.ratingInput = ""
				m.err = ""
			} else if m.deleteTarget != nil {
				m.deleteTarget = nil
				m.err = ""
			} else if m.cancelPrompt {
				m.cancelPrompt = false
			} else {
				m.screen = homeScreen
				m.err = ""
			}
			return m, nil
		}
		if m.width < 55 || m.height < 18 {
			return m, nil
		}
		if m.ratingPrompt {
			switch key {
			case "backspace":
				if len(m.ratingInput) > 0 {
					m.ratingInput = m.ratingInput[:len(m.ratingInput)-1]
				}
			case "enter":
				if score, e := strconv.Atoi(m.ratingInput); e == nil && m.connected && score >= 0 && score <= 10 {
					m.busy = true
					m.err = ""
					return m, m.scoreImage(score)
				}
				m.err = "Enter a whole number from 0 to 10."
			default:
				if len(key) == 1 && key[0] >= '0' && key[0] <= '9' {
					candidate := m.ratingInput + key
					if n, e := strconv.Atoi(candidate); e == nil && n <= 10 && len(candidate) <= 2 {
						m.ratingInput = candidate
						m.err = ""
					}
				}
			}
			return m, nil
		}
		if m.deleteTarget != nil {
			if key == "y" && m.connected {
				m.busy = true
				return m, m.deleteRun(m.deleteTarget.ID)
			}
			return m, nil
		}
		if key == "d" && (m.screen == historyScreen || m.screen == runScreen) && m.connected {
			j := m.historyJob()
			if m.screen == runScreen {
				j = m.watchedJob()
			}
			if canDelete(j) {
				copy := *j
				m.deleteTarget = &copy
				m.err = ""
			} else {
				m.err = "This run is active or cleanup is uncertain; deletion is blocked."
			}
			return m, nil
		}
		if m.cancelPrompt {
			if key == "y" && m.connected {
				if j := m.watchedJob(); j != nil && !bench.Terminal(j.Status) {
					m.busy = true
					return m, m.cancel(j.ID)
				}
			}
			return m, nil
		}
		switch m.screen {
		case homeScreen:
			switch key {
			case "up", "k":
				m.homeCursor = clamp(m.homeCursor-1, 0, 2)
			case "down", "j":
				m.homeCursor = clamp(m.homeCursor+1, 0, 2)
			case "enter":
				switch m.homeCursor {
				case 0:
					m.screen = modelScreen
				case 1:
					m.screen = resultsScreen
				default:
					m.screen = historyScreen
				}
			}
		case modelScreen:
			options := m.modelSetups()
			switch key {
			case "up", "k":
				m.modelCursor = clamp(m.modelCursor-1, 0, len(options)-1)
			case "down", "j":
				m.modelCursor = clamp(m.modelCursor+1, 0, len(options)-1)
			case "enter":
				if m.connected && len(options) > 0 {
					t := options[m.modelCursor]
					if len(t.Models) != 1 {
						return m, nil
					}
					m.busy = true
					m.err = ""
					return m, m.start(t)
				}
			}
		case resultsScreen:
			rows := m.resultRows()
			switch key {
			case "up", "k":
				m.resultsCursor = clamp(m.resultsCursor-1, 0, len(rows)-1)
			case "down", "j":
				m.resultsCursor = clamp(m.resultsCursor+1, 0, len(rows)-1)
			case "v":
				if m.connected {
					m.busy = true
					m.err = ""
					return m, m.openResultsHTML()
				}
			case "enter":
				if len(rows) > 0 {
					if j := rows[clamp(m.resultsCursor, 0, len(rows)-1)].latest; j != nil {
						m.watchID = j.ID
						m.watchBatch = ""
						m.screen = runScreen
						m.detail.GotoTop()
					}
				}
			}
		case historyScreen:
			switch key {
			case "up", "k":
				m.historyCursor = clamp(m.historyCursor-1, 0, len(m.state.Jobs)-1)
			case "down", "j":
				m.historyCursor = clamp(m.historyCursor+1, 0, len(m.state.Jobs)-1)
			case "enter":
				if j := m.historyJob(); j != nil {
					m.watchID = j.ID
					m.watchBatch = ""
					m.screen = runScreen
					m.detail.GotoTop()
				}
			}
		case runScreen:
			switch key {
			case "enter", "v":
				if j := m.watchedJob(); j != nil && m.connected {
					if visual, kind := reviewableVisual(j); visual != nil {
						m.busy = true
						m.err = ""
						if kind == "webpage" {
							return m, m.openResultsHTML(j.ID, visual.ID)
						}
						return m, m.openImage(j.ID, visual.ID)
					}
				}
			case "pgdown":
				m.detail.PageDown()
			case "pgup":
				m.detail.PageUp()
			case "down", "j":
				m.detail.ScrollDown(1)
			case "up", "k":
				m.detail.ScrollUp(1)
			case "c":
				if j := m.watchedJob(); m.connected && j != nil && !bench.Terminal(j.Status) {
					m.cancelPrompt = true
				}
			}
		}
		m.refreshDetail()
		return m, nil
	}
	return m, nil
}
func clamp(v, lo, hi int) int {
	if hi < lo {
		return lo
	}
	return max(lo, min(hi, v))
}
func clean(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, ansi.Strip(s))
}
func fit(s string, w int) string { return ansi.Truncate(s, max(1, w), "...") }
func duration(seconds int) string {
	seconds = max(0, seconds)
	return fmt.Sprintf("%dm %02ds", seconds/60, seconds%60)
}
func statusStyle(s string) lip.Style {
	switch s {
	case "passed":
		return good
	case "running", "queued", "needs_visual_review":
		return accent
	default:
		return danger
	}
}
func ratedTaskStatus(r bench.Result) (string, bool) {
	if visualTask(r.Task) && r.Status == "needs_visual_review" && r.HumanScore != nil && *r.HumanScore >= 0 && *r.HumanScore <= 10 {
		return fmt.Sprintf("%d/10", *r.HumanScore), true
	}
	return clean(r.Status), false
}
func ratedRunStatus(j *bench.Job) (string, bool) {
	visuals := 0
	for _, task := range j.Template.Tasks {
		if visualTask(task) {
			visuals++
		}
	}
	if j.Status != "needs_visual_review" || j.Template.Repeat < 1 || visuals == 0 {
		return clean(j.Status), false
	}
	rated := 0
	score := 0
	for _, r := range j.Results {
		if !visualTask(r.Task) {
			continue
		}
		if _, ok := ratedTaskStatus(r); !ok {
			return clean(j.Status), false
		}
		rated++
		score = *r.HumanScore
	}
	if rated != j.Template.Repeat*visuals {
		return clean(j.Status), false
	}
	if rated == 1 {
		return fmt.Sprintf("%d/10", score), true
	}
	return fmt.Sprintf("%d/%d IMAGES RATED", rated, rated), true
}
func (m *Model) resize() {
	m.detail.SetWidth(max(1, m.width-4))
	m.detail.SetHeight(max(1, m.height-6))
}
func (m Model) historyJob() *bench.Job {
	if len(m.state.Jobs) == 0 {
		return nil
	}
	return m.state.Jobs[len(m.state.Jobs)-1-clamp(m.historyCursor, 0, len(m.state.Jobs)-1)]
}
func (m Model) watchedJob() *bench.Job {
	for _, j := range m.state.Jobs {
		if j.ID == m.watchID {
			return j
		}
	}
	return nil
}
func (m *Model) refreshDetail() {
	if m.screen != runScreen {
		return
	}
	if j := m.watchedJob(); j != nil {
		m.detail.SetContent(m.runDetail(j))
	} else {
		m.detail.SetContent("Starting your run...\n\nWaiting for the manager to report progress.\nNo second start request will be sent.")
	}
}
func runDate(j *bench.Job) string {
	t := j.QueuedAt
	if j.StartedAt != nil {
		t = *j.StartedAt
	}
	return t.In(eastern).Format("Jan 02 3:04 PM MST")
}
func (m Model) homeView() string {
	lines := []string{"What would you like to do?", ""}
	for i, label := range []string{"Start a new run", "View Results", "View previous runs"} {
		line := "  " + label
		if i == m.homeCursor {
			line = selected.Render("> " + label)
		}
		lines = append(lines, line, "")
	}
	active := 0
	for _, j := range m.state.Jobs {
		if !bench.Terminal(j.Status) {
			active++
		}
	}
	lines = append(lines, fmt.Sprintf("%d recorded runs. %d still active.", len(m.state.Jobs), active))
	return strings.Join(lines, "\n")
}
func taskWallSeconds(_ string, configured int) int { return configured }
func (m Model) modelsView() string {
	lines := []string{accent.Render("START A NEW RUN"), "Choose one model. Enter starts it immediately.", ""}
	options := m.modelSetups()
	if len(options) == 0 {
		return strings.Join(append(lines, "No models are configured."), "\n")
	}
	capacity := max(1, m.height-16)
	start := max(0, m.modelCursor-capacity+1)
	for i := start; i < len(options) && i < start+capacity; i++ {
		model := options[i].Models[0]
		label := "  " + clean(model.Model+" / "+model.Thinking)
		if i == m.modelCursor {
			label = selected.Render("> " + clean(model.Model+" / "+model.Thinking))
		}
		lines = append(lines, label)
	}
	t := options[m.modelCursor]
	limitText := fmt.Sprintf("Limit each: %dm / %d requests.", t.WallSeconds/60, t.MaxRequests)
	lines = append(lines, "", "Provider: "+clean(t.Models[0].Provider), "Tasks: "+strings.Join(t.Tasks, ", "), fmt.Sprintf("%d tests in this run. %s", t.Attempts(), limitText), fmt.Sprintf("$%.2f per test; $%.2f estimated total.", t.MaxEstimatedUSD, t.EstimatedBudget()), "Not a hard billing cap. Results stay in history.", "Transient errors: up to 2 retries per response.")
	return strings.Join(lines, "\n")
}
func (m Model) historyView() string {
	lines := []string{accent.Render("PREVIOUS RUNS"), "Choose a run to see its progress or results.", ""}
	if len(m.state.Jobs) == 0 {
		return strings.Join(append(lines, "No runs yet. Esc returns to the main menu."), "\n")
	}
	count := max(1, (m.height-11)/3)
	start := max(0, m.historyCursor-count+1)
	for i := start; i < len(m.state.Jobs) && i < start+count; i++ {
		j := m.state.Jobs[len(m.state.Jobs)-1-i]
		status, rated := ratedRunStatus(j)
		if !rated {
			status = strings.ToUpper(status)
		}
		name := clean(j.Model.Model + " / " + j.Model.Thinking)
		label := name + "  " + status
		if rated {
			label = name + "  " + good.Render(status)
		}
		if i == m.historyCursor {
			if rated {
				label = selected.Render(fit("> "+name, m.width-6-ansi.StringWidth(status))) + "  " + good.Render(status)
			} else {
				label = selected.Render(fit("> "+label, m.width-4))
			}
		} else {
			label = fit("  "+label, m.width-4)
		}
		lines = append(lines, label, "  "+runDate(j), "")
	}
	return strings.Join(lines, "\n")
}
func resultCost(r bench.Result) string {
	if r.Metrics != nil {
		if r.Metrics.Estimated != nil {
			return fmt.Sprintf("$%.4f estimated", *r.Metrics.Estimated)
		}
		if r.Metrics.Reported != nil {
			return fmt.Sprintf("$%.4f observed, incomplete", *r.Metrics.Reported)
		}
	}
	return "cost unknown"
}
func (m Model) runDetail(j *bench.Job) string {
	terminal := bench.Terminal(j.Status)
	title := "RUN IN PROGRESS"
	if terminal {
		title = "RUN RESULTS"
	}
	status, rated := ratedRunStatus(j)
	if !rated {
		status = strings.ToUpper(status)
	}
	style := statusStyle(j.Status)
	if rated {
		style = good
	}
	lines := []string{accent.Render(title), clean(j.Model.Provider + " / " + j.Model.Model + " / " + j.Model.Thinking), style.Render(status), ""}
	if j.Error != "" {
		lines = append(lines, danger.Render("Failure: "+clean(j.Error)), "")
	}
	if !terminal {
		lines = append(lines, testProgress(j, m.width)...)
		lines = append(lines, "", "Task: "+clean(j.Task), "Stage: "+clean(j.Stage))
		if j.StartedAt != nil {
			lines = append(lines, "Run elapsed: "+duration(int(m.now.Sub(*j.StartedAt).Seconds())))
		}
		if a := j.Activity; a != nil {
			lines = append(lines, "Activity: "+clean(a.Phase), fmt.Sprintf("Test time: %s / %s", duration(a.Elapsed), duration(taskWallSeconds(j.Task, j.Template.WallSeconds))), fmt.Sprintf("Tools: %d completed. Writes/edits: %d. Errors: %d.", a.ToolsCompleted, a.Writes, a.ToolErrors))
			if a.Retries > 0 {
				lines = append(lines, fmt.Sprintf("Retries scheduled: %d, within the same run limits.", a.Retries))
			}
			silence := a.Silence + max(0, int(m.now.Sub(j.UpdatedAt).Seconds()))
			if silence >= 60 {
				lines = append(lines, fmt.Sprintf("No events for %s; this does not prove a hang.", duration(silence)))
			}
		}
		lines = append(lines, "")
	}
	if terminal {
		lines = append(lines, scoreSummary(j)...)
		lines = append(lines, "")
		lines = append(lines, accent.Render("COMPARE RECORDED RESULTS"), "Settings and retries may differ; not a ranking.")
		lines = append(lines, m.comparison(j)...)
		lines = append(lines, "", accent.Render("TASK DETAILS"))
		lines = append(lines, testProgress(j, m.width)...)
	}
	if !terminal && len(j.Results) > 0 {
		lines = append(lines, "Completed tests:")
	}
	for _, r := range j.Results {
		grade := "not graded"
		if r.Grade != nil {
			grade = fmt.Sprintf("%d/%d checks", r.Grade.Passed, r.Grade.Total)
		}
		status, rated := ratedTaskStatus(r)
		style := statusStyle(r.Status)
		if rated {
			style = good
		}
		lines = append(lines, "", clean(r.Task)+"  "+style.Render(status), "  "+grade+" | "+duration(int(r.Elapsed)), "  "+resultCost(r))
		if r.Artifact != nil {
			lines = append(lines, "  SVG for human review: "+clean(r.Artifact.File))
			if r.Artifact.PNGFile != "" {
				lines = append(lines, "  PNG: "+clean(r.Artifact.PNGFile))
				if r.Artifact.PNGPublicFile != "" || r.Artifact.PNGOwnedFile != "" {
					lines = append(lines, selected.Render("  > Open PNG with Windows (Enter or v), then rate 0-10"))
				}
			}
			if r.Artifact.Collision {
				lines = append(lines, "  Existing named SVG preserved; candidate remains in this run.")
			}
		}
		if len(r.Presentations) > 0 {
			lines = append(lines, "  Live webpage in the HTML results report.", selected.Render("  > Open HTML results (Enter or v), then rate 0-10"))
		}
		if r.HumanScore != nil && !rated {
			lines = append(lines, fmt.Sprintf("  Your visual rating: %d/10", *r.HumanScore))
		}
		if r.Metrics != nil && r.Metrics.RetryCount > 0 {
			lines = append(lines, fmt.Sprintf("  Retries scheduled: %d; recovered interruptions: %d.", r.Metrics.RetryCount, len(r.Metrics.RecoveredProviderErrors)))
		}
		if cause := r.FailureMessage(); cause != "" && cause != j.Error {
			lines = append(lines, "  "+clean(cause))
		}
		if recovery := r.Recovery; recovery != nil {
			if recovery.State == "graded" && recovery.Grade != nil {
				lines = append(lines, fmt.Sprintf("  Recovered snapshot: %d/%d checks. Not a completed pass.", recovery.Grade.Passed, recovery.Grade.Total))
			} else {
				lines = append(lines, "  Recovery: "+clean(strings.ReplaceAll(recovery.State, "_", " ")))
			}
			if recovery.Error != "" {
				lines = append(lines, "  "+clean(recovery.Error))
			}
		}
	}
	lines = append(lines, "", "Artifacts: "+clean(j.RunDir))
	return strings.Join(lines, "\n")
}
func jobCost(j *bench.Job) string {
	total := 0.0
	observed := false
	complete := len(j.Results) == j.Template.Attempts() && (j.Status == "passed" || j.Status == "failed" || j.Status == "needs_visual_review")
	for _, r := range j.Results {
		if r.Metrics == nil {
			complete = false
			continue
		}
		if r.Metrics.Estimated != nil {
			total += *r.Metrics.Estimated
			observed = true
		} else {
			complete = false
			if r.Metrics.Reported != nil {
				total += *r.Metrics.Reported
				observed = true
			}
		}
	}
	if !observed {
		return "cost unknown"
	}
	if complete {
		return fmt.Sprintf("$%.4f estimated", total)
	}
	return fmt.Sprintf("$%.4f observed, incomplete", total)
}
func (m Model) comparison(current *bench.Job) []string {
	rows := []string{}
	others := 0
	// The current run is always first; recovered grades never count as passes.
	jobs := []*bench.Job{current}
	for i := len(m.state.Jobs) - 1; i >= 0; i-- {
		j := m.state.Jobs[i]
		if j.ID != current.ID && bench.Terminal(j.Status) {
			if len(jobs) < 11 {
				jobs = append(jobs, j)
			}
			others++
		}
	}
	for i, j := range jobs {
		passed, checks, total, retries := 0, 0, 0, 0
		seconds := 0.0
		for _, r := range j.Results {
			if r.Status == "passed" {
				passed++
			}
			if r.Grade != nil {
				checks += r.Grade.Passed
				total += r.Grade.Total
			}
			seconds += r.Elapsed
			if r.Metrics != nil {
				retries += r.Metrics.RetryCount
			}
		}
		label := clean(j.Model.Model + " / " + j.Model.Thinking)
		if i == 0 {
			label += "  [this run]"
		}
		grade := "not graded"
		if total > 0 {
			grade = fmt.Sprintf("%d/%d graded checks", checks, total)
		}
		attemptText := fmt.Sprintf("%d/%d tests passed", passed, j.Template.Attempts())
		visualTypes := 0
		for _, task := range j.Template.Tasks {
			if visualTask(task) {
				visualTypes++
			}
		}
		if visualTypes > 0 {
			expectedVisuals := visualTypes * j.Template.Repeat
			visual := fmt.Sprintf("0/%d visuals rated", expectedVisuals)
			rated := 0
			for _, r := range j.Results {
				if visualTask(r.Task) && r.HumanScore != nil {
					rated++
				}
			}
			if rated > 0 {
				visual = fmt.Sprintf("%d/%d visuals rated", rated, expectedVisuals)
			}
			attemptText = fmt.Sprintf("%d/%d coding tests passed; %s", passed, j.Template.Attempts()-expectedVisuals, visual)
		}
		status, rated := ratedRunStatus(j)
		style := statusStyle(j.Status)
		if rated {
			style = good
		}
		rows = append(rows, "", label+"  "+style.Render(status), fmt.Sprintf("  %s | %s | %s", attemptText, grade, duration(int(seconds))), "  "+runDate(j)+" | "+jobCost(j))
		if retries > 0 {
			rows = append(rows, fmt.Sprintf("  Retries scheduled: %d; incomplete usage/cost.", retries))
		}
	}
	if others > 10 {
		rows = append(rows, "", "Showing the 10 most recent other runs. All runs remain in history.")
	}
	if others == 0 {
		rows = append(rows, "", "No other results yet. Future runs will appear here.")
	}
	return rows
}
func (m Model) View() tea.View {
	if m.width < 55 || m.height < 18 {
		v := tea.NewView("HemSoft Bench\n\nResize to at least 55 columns x 18 rows.\nq exits; background runs continue.")
		v.AltScreen = true
		return v
	}
	body := ""
	footer := "Up/Down select   Enter choose   q exit"
	switch m.screen {
	case homeScreen:
		body = m.homeView()
	case modelScreen:
		body = m.modelsView()
		footer = "Up/Down select  Enter START  Esc back  q exit"
	case resultsScreen:
		body = m.resultsView()
		footer = "v HTML view  Up/Down select  Enter latest run  Esc home  q exit"
	case historyScreen:
		body = m.historyView()
		footer = "Up/Down select  Enter open  d delete  Esc home  q exit"
	case runScreen:
		body = m.detail.View()
		footer = "PgUp/PgDn scroll  d delete  Esc home  q exit"
		if _, kind := reviewableVisual(m.watchedJob()); kind == "image" {
			footer = "Enter/v open PNG  PgUp/PgDn scroll  d delete  Esc home  q exit"
		} else if kind == "webpage" {
			footer = "Enter/v open HTML  PgUp/PgDn scroll  d delete  Esc home  q exit"
		}
		if j := m.watchedJob(); j != nil && !bench.Terminal(j.Status) {
			footer = "c cancel   PgDn scroll   Esc home   q disconnect"
		}
	}
	if m.ratingPrompt {
		body = accent.Render("RATE THE PNG") + "\n\nThe image has opened in your Windows default app. View it there, then return here.\n\nScore from 0 to 10: " + m.ratingInput + "_\n\nThis is your visual rating only. It does not change the coding grade."
		footer = "Type 0-10   Enter save   Esc skip   q exit"
	}
	if m.cancelPrompt {
		body = "Cancel this run?\n\nSaved code and results will be retained.\n\ny cancels this run. Esc keeps it running."
		footer = "y cancel run   Esc keep running   q disconnect"
	}
	if j := m.deleteTarget; j != nil {
		body = danger.Render("DELETE THIS RUN PERMANENTLY?") + "\n\n" + clean(j.Model.Model+" / "+j.Model.Thinking) + "\n" + runDate(j) + "\nRun: " + j.ID + "\n\nRemoves all artifacts and its history entry:\nlogs, saved code, results, and diagnostics.\nOther runs and model settings stay unchanged.\n\nThis cannot be undone."
		footer = "y DELETE permanently  Esc keep run  q exit"
	}
	note := ""
	if !m.connected {
		note = "Connecting to the manager. Starting runs is disabled."
	}
	if m.busy {
		note = "Working..."
	}
	if m.success != "" {
		note = good.Render(clean(m.success))
	}
	if m.err != "" {
		note = danger.Render(clean(m.err))
	}
	lines := strings.Split(body, "\n")
	limit := max(1, m.height-6)
	if len(lines) > limit {
		lines = lines[:limit]
	}
	for i := range lines {
		lines[i] = fit(lines[i], m.width-4)
	}
	content := accent.Render("HEMSOFT BENCH") + "\n\n" + lip.NewStyle().Height(limit).Render(strings.Join(lines, "\n")) + "\n" + fit(note, m.width-4) + "\n" + muted.Render(fit(footer, m.width-4))
	v := tea.NewView(lip.NewStyle().Padding(0, 2).Render(content))
	v.AltScreen = true
	v.WindowTitle = "HemSoft Bench"
	return v
}
