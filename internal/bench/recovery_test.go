package bench

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReloadKeepsProviderCauseAndDiagnosticGrade(t *testing.T) {
	m := manager(t)
	_, err := m.Enqueue(template())
	if err != nil {
		t.Fatal(err)
	}
	j := m.Snapshot().Jobs[0]
	path := filepath.Join(j.RunDir, "runs", "saved", "result.json")
	r := Result{ID: "saved", Task: "authority-ledger", Status: "provider_error", Metrics: &Metrics{ProviderErrors: []string{"WebSocket error"}}, Recovery: &Recovery{State: "graded", Grade: &Grade{Passed: 60, Total: 60, Success: true}}}
	if err := AtomicJSON(path, r); err != nil {
		t.Fatal(err)
	}
	original, _ := os.ReadFile(path)
	m.update(j.ID, true, func(j *Job) {
		j.Status = "provider_error"
		j.Error = "exit status 1"
		j.Results = []Result{{ID: r.ID, Task: r.Task, Status: r.Status, Path: path}}
	})
	reloaded, err := NewManager(m.root)
	if err != nil {
		t.Fatal(err)
	}
	restored := reloaded.Snapshot().Jobs[0]
	if restored.Status != "provider_error" || restored.Error != "WebSocket error" || restored.Results[0].Grade != nil || restored.Results[0].Recovery.Grade.Passed != 60 {
		t.Fatalf("lost failure or promoted diagnostic: %+v", restored)
	}
	after, _ := os.ReadFile(path)
	if string(after) != string(original) {
		t.Fatal("historical result was rewritten")
	}
}

func TestReloadDoesNotReadResultOutsideJob(t *testing.T) {
	m := manager(t)
	_, _ = m.Enqueue(template())
	j := m.Snapshot().Jobs[0]
	path := filepath.Join(m.root, "outside.json")
	r := Result{ID: "saved", Task: "t", Status: "provider_error", Error: "must not load"}
	if err := AtomicJSON(path, r); err != nil {
		t.Fatal(err)
	}
	m.update(j.ID, true, func(j *Job) {
		j.Status = "provider_error"
		j.Error = "original"
		j.Results = []Result{{ID: r.ID, Task: r.Task, Path: path}}
	})
	reloaded, err := NewManager(m.root)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Snapshot().Jobs[0].Error != "original" {
		t.Fatal("loaded foreign result")
	}
}
