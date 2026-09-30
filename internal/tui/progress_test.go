package tui

import (
	"strings"
	"testing"

	"github.com/HemSoft/hemsoft-bench/internal/bench"
	"github.com/charmbracelet/x/ansi"
)

func TestTestProgressTracksOnlyCompletedResults(t *testing.T) {
	j := demo().state.Jobs[1]
	j.Results = []bench.Result{{Task: "authority-ledger", Status: "passed"}}
	j.Task = "kangaroo-bike"
	lines := testProgress(j, 55)
	if lines[0] != "1 / 2 tests" {
		t.Fatal(lines)
	}
	bar := ansi.Strip(lines[1])
	if !strings.Contains(bar, "█") || !strings.Contains(bar, "▒") {
		t.Fatal("bar must distinguish completed and current tests: " + bar)
	}
	if ansi.StringWidth(bar) > 51 {
		t.Fatal("bar overflows minimum viewport")
	}
	j.Status = "provider_error"
	bar = ansi.Strip(testProgress(j, 55)[1])
	if strings.Contains(bar, "▒") {
		t.Fatal("stopped job must not show a running segment")
	}
	j.Status = "needs_visual_review"
	j.Results = append(j.Results, bench.Result{Task: "kangaroo-bike", Status: "needs_visual_review"})
	lines = testProgress(j, 55)
	if lines[0] != "2 / 2 tests" || strings.Contains(ansi.Strip(lines[1]), "░") {
		t.Fatal("completed visual task omitted: " + strings.Join(lines, " | "))
	}
}

func TestProgressBarNeverClaimsPartialTestAsCompleted(t *testing.T) {
	j := demo().state.Jobs[1]
	j.Results = nil
	j.Task = "authority-ledger"
	j.Status = "running"
	if got := testProgress(j, 80)[0]; got != "0 / 2 tests" {
		t.Fatal(got)
	}
	j.Template.Repeat = 20
	lines := testProgress(j, 55)
	if lines[0] != "0 / 40 tests" || ansi.StringWidth(ansi.Strip(lines[1])) > 51 {
		t.Fatal("large repeated run overflow: " + strings.Join(lines, " | "))
	}
}

func TestProgressAppearsBeforeCurrentTaskAndResults(t *testing.T) {
	m := demo()
	j := m.state.Jobs[1]
	j.Template.Tasks = []string{"authority-ledger"}
	live := ansi.Strip(m.runDetail(j))
	if p, q := strings.Index(live, "0 / 1 tests"), strings.Index(live, "Task: authority-ledger"); p < 0 || q <= p {
		t.Fatal("live progress is not above task name: " + live)
	}
	j.Status = "passed"
	j.Results = []bench.Result{{Task: "authority-ledger", Status: "passed"}}
	finished := ansi.Strip(m.runDetail(j))
	if p, q := strings.Index(finished, "1 / 1 tests"), strings.Index(finished, "authority-ledger  passed"); p < 0 || q <= p {
		t.Fatal("results progress is not above task name: " + finished)
	}
	if strings.Contains(finished, "attempts recorded") {
		t.Fatal("old flat counter remains")
	}
}
