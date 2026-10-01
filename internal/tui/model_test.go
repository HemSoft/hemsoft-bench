package tui

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/HemSoft/hemsoft-bench/internal/bench"
	"github.com/charmbracelet/x/ansi"
)

func demo() Model {
	m := New(nil)
	m.connected = true
	m.polling = false
	m.now = time.Date(2026, 9, 23, 6, 0, 0, 0, time.UTC)
	setup := bench.Template{Name: "GPT", Models: []bench.Model{{Provider: "openai-codex", Model: "gpt-5.6-sol", Thinking: "high"}}, Tasks: []string{"resilient-scheduler", "kangaroo-bike"}, Repeat: 1, WallSeconds: 2700, MaxRequests: 40, MaxEstimatedUSD: 5, Concurrency: 1}
	kimi := setup
	kimi.Name = "Kimi"
	kimi.Models = []bench.Model{{Provider: "opencode-go", Model: "kimi-k3", Thinking: "max"}}
	start := m.now.Add(-3 * time.Minute)
	cost := 0.125
	result := bench.Result{Task: "resilient-scheduler", Status: "passed", Grade: &bench.Grade{Passed: 60, Total: 60, Success: true}, Elapsed: 169, Metrics: &bench.Metrics{Estimated: &cost, Reported: &cost}}
	oldTemplate := kimi
	oldTemplate.Tasks = []string{"resilient-scheduler"}
	old := &bench.Job{ID: "old", BatchID: "old-batch", Model: kimi.Models[0], Template: oldTemplate, Status: "passed", StartedAt: &start, FinishedAt: &m.now, Results: []bench.Result{result}, RunDir: ".local/managed-runs/old"}
	active := &bench.Job{ID: "active", BatchID: "active-batch", Model: setup.Models[0], Template: setup, Status: "running", Task: "resilient-scheduler", Stage: "Model running", StartedAt: &start, UpdatedAt: m.now, Activity: &bench.Activity{Phase: "Reasoning stream", Elapsed: 25, ToolsCompleted: 4, Writes: 1}, RunDir: ".local/managed-runs/active"}
	m.state = bench.State{Version: 1, Limit: 2, Templates: []bench.Template{kimi, setup}, Jobs: []*bench.Job{old, active}}
	m.resize()
	return m
}
func press(m Model, key string) (Model, tea.Cmd) {
	msg := tea.KeyPressMsg{Text: key}
	switch key {
	case "enter":
		msg = tea.KeyPressMsg{Code: tea.KeyEnter}
	case "esc":
		msg = tea.KeyPressMsg{Code: tea.KeyEscape}
	case "down":
		msg = tea.KeyPressMsg{Code: tea.KeyDown}
	case "up":
		msg = tea.KeyPressMsg{Code: tea.KeyUp}
	}
	next, cmd := m.Update(msg)
	return next.(Model), cmd
}
func TestTwoTaskRunStartsWithoutExtraNavigation(t *testing.T) {
	m := demo()
	m, _ = press(m, "enter")
	view := ansi.Strip(m.View().Content)
	if !strings.Contains(view, "resilient-scheduler, kangaroo-bike") || !strings.Contains(view, "2 tests") || !strings.Contains(view, "$10.00 estimated total") {
		t.Fatal("model picker did not show both tasks and their budget: " + view)
	}
	if len(m.modelSetups()) != 2 {
		t.Fatal("visual task must not add a separate model choice")
	}
}
func TestHomeHasResultsBetweenStartAndHistory(t *testing.T) {
	m := demo()
	view := ansi.Strip(m.View().Content)
	for _, want := range []string{"Start a new run", "View Results", "View previous runs"} {
		if !strings.Contains(view, want) {
			t.Fatal(want)
		}
	}
	for _, unwanted := range []string{"Templates", "Suites", "Review", "[1]", "[2]"} {
		if strings.Contains(view, unwanted) {
			t.Fatal("old navigation: " + unwanted)
		}
	}
	next, cmd := press(m, "enter")
	if cmd != nil || next.screen != modelScreen {
		t.Fatal("home must open the model picker, not start work")
	}
	m, _ = press(m, "down")
	m, cmd = press(m, "enter")
	if cmd != nil || m.screen != resultsScreen {
		t.Fatal("second home choice must open the results table")
	}
	m, _ = press(m, "esc")
	m, _ = press(m, "down")
	m, _ = press(m, "down")
	m, cmd = press(m, "enter")
	if cmd != nil || m.screen != historyScreen {
		t.Fatal("third home choice must open history")
	}
}

func TestResultsTableShowsLatestTestOutcomePerModel(t *testing.T) {
	m := demo()
	m.state.Jobs[1].Results = append(m.state.Jobs[1].Results, bench.Result{Task: "resilient-scheduler", Status: "failed", Grade: &bench.Grade{Passed: 37, Total: 60}})
	m.screen = resultsScreen
	view := ansi.Strip(m.resultsView())
	for _, want := range []string{"RESULTS BY MODEL", "MODEL / THINKING", "SCHED", "gpt-5.6-sol / high", "kimi-k3 / max", "60/60", "37/60"} {
		if !strings.Contains(view, want) {
			t.Fatalf("missing %q in results table:\n%s", want, view)
		}
	}
	m, cmd := press(m, "enter")
	if cmd != nil || m.screen != runScreen || m.watchID != "active" {
		t.Fatal("results row did not open its latest run")
	}
}

func TestResultsTwoOpensHTMLReportWithoutStartingWork(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "POST" || r.URL.Path != "/results/open-html" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"path":"results.html"}`))
	}))
	defer server.Close()
	m := demo()
	m.screen = resultsScreen
	m.client = &bench.Client{Endpoint: bench.Endpoint{URL: server.URL, Token: "test"}, HTTP: server.Client()}
	m, cmd := press(m, "2")
	if cmd == nil || !m.busy {
		t.Fatal("2 did not request the HTML report")
	}
	next, _ := m.Update(cmd())
	m = next.(Model)
	if calls != 1 || m.busy || m.success != "Opened HTML results." || m.screen != resultsScreen {
		t.Fatal("HTML report did not open cleanly")
	}
}
func TestOneEnterStartsExactlySelectedModelAndTracksReturnedBatch(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/queue" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		calls++
		var request bench.Template
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		if len(request.Models) != 1 || request.Models[0].Model != "gpt-5.6-sol" || !request.KeepHistory || request.Concurrency != 1 {
			t.Errorf("wrong run: %+v", request)
		}
		_, _ = w.Write([]byte(`{"batchId":"new-batch"}`))
	}))
	defer server.Close()
	m := demo()
	m.client = &bench.Client{Endpoint: bench.Endpoint{URL: server.URL, Token: "test"}, HTTP: server.Client()}
	m, _ = press(m, "enter")
	m, _ = press(m, "down")
	m, cmd := press(m, "enter")
	if cmd == nil || !m.busy {
		t.Fatal("model Enter must start immediately")
	}
	duplicate, again := press(m, "enter")
	if again != nil || !duplicate.busy {
		t.Fatal("repeated Enter duplicated submission")
	}
	next, _ := m.Update(cmd())
	m = next.(Model)
	if m.screen != runScreen || m.watchBatch != "new-batch" || calls != 1 {
		t.Fatal("did not open the started run")
	}
	if m.watchedJob() != nil {
		t.Fatal("attached to an unrelated old run")
	}
	m.state.Jobs = append(m.state.Jobs, &bench.Job{ID: "new", BatchID: "new-batch", Status: "running"})
	next, _ = m.Update(stateMsg{State: m.state})
	m = next.(Model)
	if m.watchID != "new" {
		t.Fatal("did not bind returned batch")
	}
	_, again = press(m, "enter")
	if again != nil {
		t.Fatal("progress Enter started another run")
	}
}
func TestCompletionShowsResultsAndComparisonWithoutMoreInput(t *testing.T) {
	m := demo()
	m.screen = runScreen
	m.watchID = "active"
	m.refreshDetail()
	if !strings.Contains(ansi.Strip(m.View().Content), "RUN IN PROGRESS") {
		t.Fatal("missing progress")
	}
	m.height = 18
	m.resize()
	m.detail.ScrollDown(4)
	finished := *m.state.Jobs[1]
	finished.Status = "passed"
	finished.Results = append(finished.Results, bench.Result{Task: "resilient-scheduler", Status: "passed", Grade: &bench.Grade{Passed: 60, Total: 60, Success: true}})
	s := m.state
	s.Jobs = append([]*bench.Job{}, m.state.Jobs...)
	s.Jobs[1] = &finished
	next, _ := m.Update(stateMsg{State: s})
	m = next.(Model)
	if !m.detail.AtTop() {
		t.Fatal("finished run did not bring results into view")
	}
	detail := ansi.Strip(m.detail.GetContent())
	for _, want := range []string{"RUN RESULTS", "COMPARE RECORDED RESULTS", "kimi-k3", "60/60 graded checks"} {
		if !strings.Contains(detail, want) {
			t.Fatal("missing " + want)
		}
	}
}
func TestHistoryAndDisconnectNeverQueue(t *testing.T) {
	m := demo()
	m.screen = historyScreen
	m, cmd := press(m, "enter")
	if cmd != nil || m.watchID != "active" {
		t.Fatal("history did not open selected run")
	}
	m, cmd = press(m, "esc")
	if cmd != nil || m.screen != homeScreen {
		t.Fatal("Esc should only navigate")
	}
	_, cmd = press(m, "q")
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatal("quit mutated jobs")
	}
}
func TestOfflineAndSmallWindowCannotStart(t *testing.T) {
	m := demo()
	m.screen = modelScreen
	m.connected = false
	if _, cmd := press(m, "enter"); cmd != nil {
		t.Fatal("started offline")
	}
	m.connected = true
	m.width = 40
	m.height = 12
	if _, cmd := press(m, "enter"); cmd != nil {
		t.Fatal("started with hidden UI")
	}
}
func TestLostStartResponseCannotAutomaticallyRetry(t *testing.T) {
	m := demo()
	m.screen = modelScreen
	m.busy = true
	next, _ := m.Update(queuedMsg{Err: errors.New("connection closed")})
	m = next.(Model)
	if m.screen != historyScreen || m.busy {
		t.Fatal("did not direct ambiguous submission to history")
	}
	_, cmd := press(m, "enter")
	if cmd != nil {
		t.Fatal("repeated Enter retried paid work")
	}
}
func TestRecoveredGradesAreSeparateInComparison(t *testing.T) {
	m := demo()
	j := m.state.Jobs[1]
	j.Status = "provider_error"
	j.Results = []bench.Result{{Task: "resilient-scheduler", Status: "provider_error", Recovery: &bench.Recovery{State: "graded", Grade: &bench.Grade{Passed: 60, Total: 60, Success: true}}}}
	text := strings.Join(m.comparison(j), "\n")
	if !strings.Contains(text, "0/1 coding tests passed; 0/1 visuals rated | not graded") {
		t.Fatal("recovery counted as a completed pass: " + text)
	}
}
func TestPollPreservesModelSelection(t *testing.T) {
	m := demo()
	m.screen = modelScreen
	m.modelCursor = 1
	s := m.state
	s.Templates = []bench.Template{s.Templates[1], s.Templates[0]}
	next, _ := m.Update(stateMsg{State: s})
	m = next.(Model)
	if m.modelSetups()[m.modelCursor].Models[0].Model != "gpt-5.6-sol" {
		t.Fatal("poll switched visible model")
	}
}
func TestNoPollingFanout(t *testing.T) {
	m := demo()
	m.polling = true
	next, cmd := m.Update(stateMsg{Err: errors.New("offline")})
	if cmd != nil || next.(Model).polling {
		t.Fatal("response created another poll loop")
	}
}
func TestUntrustedTextCannotControlTerminal(t *testing.T) {
	if strings.ContainsRune(clean("\x1b[2Jbad\ntext"), '\x1b') || strings.ContainsRune(clean("a\nb"), '\n') {
		t.Fatal("terminal controls survived")
	}
}
func TestBubbleTeaProgramDisconnectsWithoutMutation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Error("disconnect mutated manager")
		}
		_, _ = w.Write([]byte(`{"version":1,"limit":2,"templates":[],"jobs":[]}`))
	}))
	defer server.Close()
	client := &bench.Client{Endpoint: bench.Endpoint{URL: server.URL, Token: "test"}, HTTP: server.Client()}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var output bytes.Buffer
	p := tea.NewProgram(New(client), tea.WithContext(ctx), tea.WithInput(strings.NewReader("q")), tea.WithOutput(&output), tea.WithoutRenderer())
	if _, err := p.Run(); err != nil {
		t.Fatal(err)
	}
}
func TestLayoutsAndSnapshots(t *testing.T) {
	for _, screen := range []string{homeScreen, modelScreen, resultsScreen, historyScreen, runScreen, "completed", "visual-results", "visual-rated", "interrupted", "empty-history", "delete"} {
		for _, size := range [][2]int{{120, 36}, {80, 28}, {55, 20}} {
			name := screen + "-" + stringSize(size[0])
			t.Run(name, func(t *testing.T) {
				m := demo()
				m.width, m.height = size[0], size[1]
				m.screen = screen
				if screen == runScreen || screen == "completed" || screen == "visual-results" || screen == "visual-rated" {
					m.screen = runScreen
					m.watchID = "active"
				}
				if screen == "completed" {
					m.state.Jobs[1].Status = "passed"
					m.state.Jobs[1].Results = []bench.Result{{Task: "resilient-scheduler", Status: "passed", Grade: &bench.Grade{Passed: 60, Total: 60, Success: true}, Elapsed: 169}}
				}
				if screen == "visual-results" || screen == "visual-rated" {
					j := m.state.Jobs[1]
					j.Status = "needs_visual_review"
					visual := bench.Result{Task: "kangaroo-bike", Status: "needs_visual_review", Artifact: &bench.VisualArtifact{File: `D:\github\HemSoft\hemsoft-bench\.local\results\gpt-5.6-sol-bike.svg`, Published: true}}
					if screen == "visual-rated" {
						score := 5
						visual.HumanScore = &score
						visual.Artifact.PNGFile = `D:\github\HemSoft\hemsoft-bench\.local\results\gpt-5.6-sol-bike.png`
						visual.Artifact.PNGPublicFile = visual.Artifact.PNGFile
						m.success = "Rating saved."
					}
					j.Results = []bench.Result{{Task: "resilient-scheduler", Status: "passed", Grade: &bench.Grade{Passed: 60, Total: 60, Success: true}}, visual}
				}
				if screen == "interrupted" {
					m.screen = runScreen
					m.watchID = "active"
					j := m.state.Jobs[1]
					j.Status = "provider_error"
					j.Error = "WebSocket error"
					j.Results = []bench.Result{{Task: "resilient-scheduler", Status: "provider_error", Recovery: &bench.Recovery{State: "graded", Grade: &bench.Grade{Passed: 60, Total: 60, Success: true}}}}
				}
				if screen == "delete" {
					m.screen = historyScreen
					target := *m.state.Jobs[0]
					m.deleteTarget = &target
				}
				if screen == "empty-history" {
					m.screen = historyScreen
					m.state.Jobs = nil
				}
				m.resize()
				m.refreshDetail()
				text := ansi.Strip(m.View().Content) + "\n"
				for _, line := range strings.Split(text, "\n") {
					if ansi.StringWidth(line) > m.width {
						t.Fatal("width overflow")
					}
				}
				if len(strings.Split(strings.TrimSuffix(text, "\n"), "\n")) > m.height {
					t.Fatal("height overflow")
				}
				path := filepath.Join("testdata", name+".txt")
				if os.Getenv("UPDATE_GOLDEN") == "1" {
					if err := os.WriteFile(path, []byte(text), 0600); err != nil {
						t.Fatal(err)
					}
				}
				want, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				if text != string(want) {
					t.Fatalf("inspect changed frame before updating snapshots:\n%s", text)
				}
			})
		}
	}
}
func stringSize(width int) string {
	switch width {
	case 120:
		return "wide"
	case 80:
		return "narrow"
	default:
		return "small"
	}
}
