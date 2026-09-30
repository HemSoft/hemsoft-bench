package bench

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDoctorExposesDockerUnavailableWithoutStartingModels(t *testing.T) {
	m := manager(t)
	_, err := m.Enqueue(template())
	if err != nil {
		t.Fatal(err)
	}
	id := m.Snapshot().Jobs[0].ID
	if err = os.MkdirAll(filepath.Join(m.root, "src"), 0700); err != nil {
		t.Fatal(err)
	}
	script := `console.error('docker failed: 1\nfailed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; The system cannot find the file specified.');process.exitCode=1;`
	if err = os.WriteFile(filepath.Join(m.root, "src", "cli.mjs"), []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	err = m.command(id, []string{"doctor"})
	if err == nil || !strings.Contains(err.Error(), "Docker engine is unavailable") || !strings.Contains(err.Error(), "No model calls were made") {
		t.Fatalf("lost actionable cause: %v", err)
	}
	// A previous command's Docker message must not misclassify a different failure.
	if err = os.WriteFile(filepath.Join(m.root, "src", "cli.mjs"), []byte(`console.error('unrelated startup failure');process.exitCode=1;`), 0600); err != nil {
		t.Fatal(err)
	}
	err = m.command(id, []string{"doctor"})
	if err == nil || strings.Contains(err.Error(), "Docker engine is unavailable") {
		t.Fatalf("used stale log data: %v", err)
	}
}
