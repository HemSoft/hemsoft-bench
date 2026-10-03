package tui

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/HemSoft/hemsoft-bench/internal/bench"
)

func TestSuccessfulStreamRecoveryRetainsGradeAndQualifiedCost(t *testing.T) {
	m := demo()
	j := m.state.Jobs[0]
	var metrics bench.Metrics
	err := json.Unmarshal([]byte(`{"usageComplete":false,"estimatedCostUsd":null,"reportedEstimatedCostUsd":0.25,"retryCount":1,"recoveredProviderErrors":["Stream ended without finish_reason"],"providerErrors":[]}`), &metrics)
	if err != nil {
		t.Fatal(err)
	}
	j.Results[0].Metrics = &metrics
	text := m.runDetail(j)
	for _, want := range []string{"Check pass rate: 100.0%", "Provider retries: 1; recovered: 1.", "observed, incomplete"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in %s", want, text)
		}
	}
	if j.Results[0].FailureMessage() != "" {
		t.Fatal("recovered stream was presented as terminal failure")
	}
	if strings.Contains(text, "Recovered snapshot:") {
		t.Fatal("completed retry was confused with offline snapshot grading")
	}
	if metrics.RetryCount != 1 || len(metrics.RecoveredProviderErrors) != 1 {
		t.Fatal("manager lost retry metadata")
	}
}

func TestRetryWaitIsVisibleInProgress(t *testing.T) {
	m := demo()
	j := m.state.Jobs[1]
	j.Activity.Phase = "Retrying response"
	j.Activity.Retries = 1
	text := m.runDetail(j)
	if !strings.Contains(text, "Activity: Retrying response") || !strings.Contains(text, "Retries scheduled: 1, within the same run limits.") {
		t.Fatal(text)
	}
}
