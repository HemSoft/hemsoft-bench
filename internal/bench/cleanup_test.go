package bench

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestDeleteRemovesNamedVisualExportOnlyWhenOwnedAndUnchanged(t *testing.T) {
	m := manager(t)
	visual := template()
	visual.Tasks = []string{"kangaroo-bike"}
	_, _ = m.Enqueue(visual)
	j := m.Snapshot().Jobs[0]
	data := []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`)
	dest := filepath.Join(m.root, ".local", "results", "kimi-k3-bike.svg")
	if err := os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dest, data, 0600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	m.update(j.ID, true, func(job *Job) {
		job.Status = "needs_visual_review"
		job.Results = []Result{{Task: "kangaroo-bike", Status: "needs_visual_review", Artifact: &VisualArtifact{Published: true, PublicFile: dest, SHA256: hex.EncodeToString(sum[:])}}}
	})
	if err := os.WriteFile(dest, []byte("modified"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := m.Delete(j.ID); err == nil {
		t.Fatal("modified export should be protected")
	}
	if _, err := os.Stat(j.RunDir); err != nil {
		t.Fatal("job removed despite modified export")
	}
	if err := os.WriteFile(dest, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := m.Delete(j.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatal("owned SVG not removed")
	}
}

func TestDeleteRemovesAllOwnedArtifactsAndOnlyThatRun(t *testing.T) {
	m := manager(t)
	_, _ = m.Enqueue(template())
	_, _ = m.Enqueue(template())
	jobs := m.Snapshot().Jobs
	victim, other := jobs[0], jobs[1]
	for _, rel := range []string{"runner.log", "config.json", "runs/attempt/events.jsonl", "runs/attempt/submission.py", "runs/attempt/result.json", "diagnostics/recovered/solution.py"} {
		path := filepath.Join(victim.RunDir, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.Cancel(victim.ID); err != nil {
		t.Fatal(err)
	}
	if err := m.Delete(victim.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(victim.RunDir); !os.IsNotExist(err) {
		t.Fatalf("artifacts remain: %v", err)
	}
	if _, err := os.Stat(other.RunDir); err != nil {
		t.Fatal("other run was removed")
	}
	reloaded, err := NewManager(m.root)
	if err != nil {
		t.Fatal(err)
	}
	saved := reloaded.Snapshot()
	if len(saved.Jobs) != 1 || saved.Jobs[0].ID != other.ID || len(saved.Templates) == 0 {
		t.Fatal("deletion damaged persisted history or model settings")
	}
}
