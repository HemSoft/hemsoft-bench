package bench

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func template() Template {
	return Template{Name: "Test", Models: []Model{{Provider: "opencode-go", Model: "kimi-k3", Thinking: "max"}}, Tasks: []string{"authority-ledger", "kangaroo-bike"}, Repeat: 1, WallSeconds: 60, MaxRequests: 4, MaxEstimatedUSD: 1, Concurrency: 1}
}
func manager(t *testing.T) *Manager {
	t.Helper()
	root := t.TempDir()
	v := template()
	data := map[string]any{"model": v.Models[0], "tasks": v.Tasks, "repeat": v.Repeat, "wallSeconds": v.WallSeconds, "maxRequests": v.MaxRequests, "maxEstimatedUsd": v.MaxEstimatedUSD}
	if e := AtomicJSON(filepath.Join(root, "run.json"), data); e != nil {
		t.Fatal(e)
	}
	m, e := NewManager(root)
	if e != nil {
		t.Fatal(e)
	}
	return m
}
func TestManagerOnlyStopsWhenIdle(t *testing.T) {
	m := manager(t)
	_, _ = m.Enqueue(template())
	id := m.Snapshot().Jobs[0].ID
	if m.StopIdle() == nil {
		t.Fatal("stopped with queued work")
	}
	if e := m.Cancel(id); e != nil {
		t.Fatal(e)
	}
	if e := m.StopIdle(); e != nil {
		t.Fatal(e)
	}
	if _, e := m.Enqueue(template()); e == nil {
		t.Fatal("queued during shutdown")
	}
}

func TestTemplateValidation(t *testing.T) {
	v := template()
	if e := v.Validate(); e != nil {
		t.Fatal(e)
	}
	v.Models[0].Thinking = "auto"
	if v.Validate() == nil {
		t.Fatal("accepted implicit thinking")
	}
	v = template()
	v.Concurrency = 9
	if v.Validate() == nil {
		t.Fatal("accepted 9 workers")
	}
	v = template()
	if e := v.Validate(); e != nil || v.Attempts() != 2 {
		t.Fatalf("two-task run must be valid: %v", e)
	}
	v = template()
	v.Tasks = append(v.Tasks, "unknown")
	if v.Validate() == nil {
		t.Fatal("accepted unknown task")
	}
}
func TestQueuePersistenceAndIndependentConfigs(t *testing.T) {
	m := manager(t)
	v := template()
	v.Models = append(v.Models, Model{Provider: "openrouter", Model: "some/model", Thinking: "high"})
	_, e := m.Enqueue(v)
	if e != nil {
		t.Fatal(e)
	}
	v.Models[0].Model = "changed"
	s := m.Snapshot()
	if s.Jobs[0].Model.Model != "kimi-k3" || s.Jobs[0].RunDir == s.Jobs[1].RunDir {
		t.Fatal("jobs share mutable config or directories")
	}
	m2, e := NewManager(m.root)
	if e != nil {
		t.Fatal(e)
	}
	if len(m2.Snapshot().Jobs) != 2 || m2.Snapshot().Jobs[0].Status != "queued" {
		t.Fatal("queue not restored")
	}
}
func TestSchedulerHonorsGlobalAndSeriesLimits(t *testing.T) {
	m := manager(t)
	v := template()
	v.Models = append(v.Models, v.Models[0], v.Models[0])
	v.Concurrency = 1
	batch, _ := m.Enqueue(v)
	other := v
	other.Name = "other"
	other.Concurrency = 2
	_, _ = m.Enqueue(other)
	launched := make(chan string, 8)
	m.execute = func(id string) { launched <- id }
	m.schedule()
	for i := 0; i < 2; i++ {
		select {
		case <-launched:
		case <-time.After(time.Second):
			t.Fatal("not scheduled")
		}
	}
	m.schedule()
	if len(launched) != 0 {
		t.Fatal("exceeded worker limit")
	}
	s := m.Snapshot()
	active := 0
	series := 0
	for _, j := range s.Jobs {
		if j.Status == "running" {
			active++
			if j.BatchID == batch {
				series++
			}
		}
	}
	if active != 2 || series != 1 {
		t.Fatalf("active %d series %d", active, series)
	}
}
func TestCancelAndDeleteOwnership(t *testing.T) {
	m := manager(t)
	_, _ = m.Enqueue(template())
	id := m.Snapshot().Jobs[0].ID
	if m.Delete(id) == nil {
		t.Fatal("deleted queued job")
	}
	if e := m.Cancel(id); e != nil {
		t.Fatal(e)
	}
	j := m.Snapshot().Jobs[0]
	if j.Status != "cancelled" {
		t.Fatal(j.Status)
	}
	if _, e := os.Stat(filepath.Join(j.RunDir, "cancel")); e != nil {
		t.Fatal(e)
	}
	if e := m.Delete(id); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(j.RunDir); !os.IsNotExist(e) {
		t.Fatal("artifacts remain")
	}
}
func TestRetentionNeverRemovesActiveBatchOrLegacy(t *testing.T) {
	m := manager(t)
	legacy := filepath.Join(m.root, ".local", "runs", "legacy")
	_ = os.MkdirAll(legacy, 0700)
	v := template()
	v.Models = append(v.Models, v.Models[0])
	_, _ = m.Enqueue(v)
	old := m.Snapshot().Jobs
	m.update(old[0].ID, true, func(j *Job) { j.Status = "passed" })
	_, _ = m.Enqueue(v)
	newJobs := m.Snapshot().Jobs[2:]
	m.finish(newJobs[0].ID, "passed", nil)
	m.finish(newJobs[1].ID, "passed", nil)
	if len(m.Snapshot().Jobs) != 4 {
		t.Fatal("pruned partially active batch")
	}
	if _, e := os.Stat(legacy); e != nil {
		t.Fatal("legacy affected")
	}
	m.finish(old[1].ID, "passed", nil)
	_, _ = m.Enqueue(v)
	latest := m.Snapshot().Jobs[4:]
	m.finish(latest[0].ID, "passed", nil)
	m.finish(latest[1].ID, "passed", nil)
	if len(m.Snapshot().Jobs) != 2 {
		t.Fatal("old completed batches not removed")
	}
}
func TestRestartDoesNotRepeatPaidJobs(t *testing.T) {
	m := manager(t)
	_, _ = m.Enqueue(template())
	id := m.Snapshot().Jobs[0].ID
	m.update(id, true, func(j *Job) { j.Status = "running"; j.PID = 0 })
	m2, e := NewManager(m.root)
	if e != nil {
		t.Fatal(e)
	}
	m2.execute = func(string) { t.Error("restarted paid job") }
	m2.schedule()
	s := m2.Snapshot()
	if s.Jobs[0].Status != "interrupted" {
		t.Fatal(s.Jobs[0].Status)
	}
	if m2.Delete(id) == nil {
		t.Fatal("allowed unsafe cleanup after crash")
	}
}
func TestCleanupFailureCannotBeHiddenByCancellation(t *testing.T) {
	m := manager(t)
	_, _ = m.Enqueue(template())
	id := m.Snapshot().Jobs[0].ID
	m.update(id, true, func(j *Job) { j.CancelRequested = true })
	m.finish(id, "cleanup_error", nil)
	if m.Snapshot().Jobs[0].Status != "cleanup_error" {
		t.Fatal("cleanup failure hidden")
	}
	if m.Delete(id) == nil {
		t.Fatal("allowed deleting uncertain cleanup")
	}
}
func TestHTTPAuthenticationAndOrigins(t *testing.T) {
	m := manager(t)
	h := Handler(m, "secret")
	for _, auth := range []string{"", "Bearer wrong"} {
		r := httptest.NewRequest("GET", "/state", nil)
		r.Header.Set("Authorization", auth)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatal(w.Code)
		}
	}
	r := httptest.NewRequest("GET", "/state", nil)
	r.Header.Set("Authorization", "Bearer secret")
	r.Header.Set("Origin", "https://evil.example")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("accepted browser origin")
	}
	r = httptest.NewRequest("GET", "/state", nil)
	r.Header.Set("Authorization", "Bearer secret")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatal(w.Code)
	}
	var state State
	if json.Unmarshal(w.Body.Bytes(), &state) != nil {
		t.Fatal("bad response")
	}
	r = httptest.NewRequest("POST", "/queue", strings.NewReader(`{"name":"bad"}`))
	r.Header.Set("Authorization", "Bearer secret")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatal("invalid queue request accepted")
	}
}
