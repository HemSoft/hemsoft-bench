package tui

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/HemSoft/hemsoft-bench/internal/bench"
)

func TestDeleteRequiresConfirmationAndKeepsExactTargetAcrossPoll(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != "POST" || r.URL.Path != "/jobs/old/delete" {
			t.Errorf("wrong deletion: %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	m := demo()
	m.client = &bench.Client{Endpoint: bench.Endpoint{URL: server.URL, Token: "test"}, HTTP: server.Client()}
	m.screen = historyScreen
	m.historyCursor = 1
	m, cmd := press(m, "d")
	if cmd != nil || m.deleteTarget == nil || requests != 0 {
		t.Fatal("delete did not wait for confirmation")
	}
	m, cmd = press(m, "enter")
	if cmd != nil {
		t.Fatal("Enter must not confirm deletion")
	}
	// New jobs arriving must not change which run the confirmation deletes.
	s := m.state
	s.Jobs = append(append([]*bench.Job{}, s.Jobs...), &bench.Job{ID: "new", Status: "running"})
	next, _ := m.Update(stateMsg{State: s})
	m = next.(Model)
	m, cmd = press(m, "y")
	if cmd == nil {
		t.Fatal("explicit confirmation ignored")
	}
	_, again := press(m, "y")
	if again != nil {
		t.Fatal("duplicate delete")
	}
	next, _ = m.Update(cmd())
	m = next.(Model)
	if requests != 1 || len(m.state.Jobs) != 2 || m.screen != historyScreen {
		t.Fatal("history not updated")
	}
	next, _ = m.Update(stateMsg{State: s})
	m = next.(Model)
	for _, j := range m.state.Jobs {
		if j.ID == "old" {
			t.Fatal("stale poll restored deleted run")
		}
	}
}
func TestDeleteActiveOrUncertainRunsIsBlocked(t *testing.T) {
	for _, uncertain := range []bool{false, true} {
		m := demo()
		m.screen = historyScreen
		if uncertain {
			m.state.Jobs[1].Status = "passed"
			m.state.Jobs[1].CleanupUncertain = true
		}
		m, cmd := press(m, "d")
		if cmd != nil || m.deleteTarget != nil {
			t.Fatal("unsafe delete allowed")
		}
	}
	m := demo()
	m.screen = historyScreen
	m.historyCursor = 1
	m, _ = press(m, "d")
	m, cmd := press(m, "esc")
	if cmd != nil || m.deleteTarget != nil || len(m.state.Jobs) != 2 {
		t.Fatal("Esc must preserve the run")
	}
}
func TestScoreExplainsCoverageAndExcludesRecoveredSnapshots(t *testing.T) {
	m := demo()
	j := m.state.Jobs[0]
	text := strings.Join(scoreSummary(j), "\n")
	for _, want := range []string{"100.0% (60/60 hidden checks)", "Coding tests passed: 1/1", "1 task type; difficulty uncalibrated"} {
		if !strings.Contains(text, want) {
			t.Fatal(text)
		}
	}
	j.Results[0].Status = "provider_error"
	j.Results[0].Recovery = &bench.Recovery{State: "graded", Grade: j.Results[0].Grade}
	j.Results[0].Grade = nil
	text = strings.Join(scoreSummary(j), "\n")
	if strings.Contains(text, "100.0%") || !strings.Contains(text, "Not scored") {
		t.Fatal(text)
	}
	j.Results = nil
	if !strings.Contains(strings.Join(scoreSummary(j), "\n"), "Not scored") {
		t.Fatal("preflight failure was scored")
	}
}
