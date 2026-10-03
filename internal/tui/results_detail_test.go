package tui

import (
	"strings"
	"testing"

	"github.com/HemSoft/hemsoft-bench/internal/bench"
	"github.com/charmbracelet/x/ansi"
)

func mixedResultsModel() Model {
	m := demo()
	j := m.state.Jobs[0]
	j.Status = "failed"
	j.Template.Tasks = []string{"resilient-scheduler", "kangaroo-bike", "world-clock"}
	full, partial := 1.25, 0.5
	j.Results = []bench.Result{
		{Task: "resilient-scheduler", Status: "failed", Grade: &bench.Grade{Passed: 52, Total: 72}, Elapsed: 600, Metrics: &bench.Metrics{Estimated: &full, UsageComplete: true}},
		{Task: "kangaroo-bike", Status: "missing_or_invalid_submission", Elapsed: 300, Error: "SVG validation failed. Candidate saved at D:\\very-long-path\\bike.svg.", ValidationError: "External or malformed SVG URL", Metrics: &bench.Metrics{Estimated: &full, UsageComplete: true}},
		{ID: "clock", Task: "world-clock", Status: "needs_visual_review", Elapsed: 60, Presentations: []bench.PresentationArtifact{{Kind: "webpage", File: "world-clock.html"}}, Metrics: &bench.Metrics{Reported: &partial, UsageComplete: false, RetryCount: 1, RecoveredProviderErrors: []string{"terminated"}}},
	}
	m.state.Jobs = []*bench.Job{j}
	return m
}

func TestSingleRunResultsSeparateFailuresReviewAndCost(t *testing.T) {
	m := mixedResultsModel()
	j := m.state.Jobs[0]
	text := ansi.Strip(m.runDetail(j))
	for _, want := range []string{"COMPLETED WITH FAILURES", "52/72 hidden checks", "Visuals: 0/2 rated; 1 ready; 1 invalid.", "Total: 16m 00s | $3.0000 observed, incomplete", "kangaroo-bike  invalid submission", "world-clock  ready for review", "External or malformed SVG URL", "Provider retries: 1; recovered: 1."} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in:\n%s", want, text)
		}
	}
	for _, noise := range []string{"COMPARE RECORDED RESULTS", "[this run]", "No other results yet", "missing_or_invalid_submission", "needs_visual_review", "Candidate saved at", "not graded |", "Live webpage in the HTML results report."} {
		if strings.Contains(text, noise) {
			t.Errorf("redundant or technical text %q in:\n%s", noise, text)
		}
	}
	if j.Status != "failed" || j.Results[1].Status != "missing_or_invalid_submission" {
		t.Fatal("display rewrote recorded status")
	}
}

func TestComparisonRetainsOtherRunsWithoutInventingPartialUsage(t *testing.T) {
	m := demo()
	j := m.state.Jobs[0]
	amount := 0.25
	j.Results[0].Metrics = &bench.Metrics{Estimated: &amount, UsageComplete: true, RetryCount: 1, RecoveredProviderErrors: []string{"terminated"}}
	m.state.Jobs[1].Status = "passed"
	text := ansi.Strip(m.runDetail(j))
	if !strings.Contains(text, "COMPARE RECORDED RESULTS") || !strings.Contains(text, "[this run]") {
		t.Fatal("real comparison disappeared")
	}
	if strings.Contains(text, "incomplete usage/cost") {
		t.Fatal("retry alone incorrectly marked complete usage as partial")
	}
}

func TestLegacyCandidatePathIsNotRepeatedAndReasonIsKept(t *testing.T) {
	m := mixedResultsModel()
	j := m.state.Jobs[0]
	j.Results[1].ValidationError = ""
	j.Results[1].Error = "SVG validation failed. Candidate saved at D:\\very-long-path\\bike.svg. ValueError: Foreign attribute namespace"
	text := ansi.Strip(m.runDetail(j))
	if strings.Contains(text, "Candidate saved at") || !strings.Contains(text, "Foreign attribute namespace") {
		t.Fatal("legacy error was either noisy or lost its validation reason: " + text)
	}
}

func TestUnknownValidationErrorRemainsVisible(t *testing.T) {
	m := demo()
	j := m.state.Jobs[0]
	j.Results[0].Error = "Validator infrastructure unavailable"
	if !strings.Contains(ansi.Strip(m.runDetail(j)), "Validator infrastructure unavailable") {
		t.Fatal("unexpected failure was hidden")
	}
}
