package bench

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResultsReportIncludesResultsVisualsAndSandboxedWebpages(t *testing.T) {
	m, job, _, _ := visualReviewFixture(t)
	if err := m.ScoreImage(job.ID, "attempt", 8); err != nil {
		t.Fatal(err)
	}
	pagePath := filepath.Join(job.RunDir, "runs", "attempt", "site.html")
	if err := os.WriteFile(pagePath, []byte(`<!doctype html><html><head><style>body{background:#123;color:white}</style></head><body><h1>Candidate page</h1><script>document.body.dataset.ready='true'</script></body></html>`), 0600); err != nil {
		t.Fatal(err)
	}
	m.update(job.ID, true, func(saved *Job) {
		saved.Results[0].Presentations = []PresentationArtifact{{Kind: "webpage", Label: "Website concept", File: pagePath}}
	})
	opened := ""
	m.openReport = func(path string) error { opened = path; return nil }
	path, err := m.OpenResultsReport()
	if err != nil {
		t.Fatal(err)
	}
	if path != opened || filepath.Base(path) != "results.html" {
		t.Fatalf("report was not opened: path=%q opened=%q", path, opened)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	html := string(data)
	for _, want := range []string{"Model results, in full view.", "kimi-k3", "8 / 10", "data:image/png;base64,", "Website concept", `sandbox="allow-scripts"`, "Content-Security-Policy", "Candidate page", "Grid", "List"} {
		if !strings.Contains(html, want) {
			t.Fatalf("report missing %q", want)
		}
	}
	if strings.Contains(html, `connect-src *`) || strings.Contains(html, `allow-same-origin`) {
		t.Fatal("webpage preview escaped the network or origin sandbox")
	}
}

func TestResultsReportRejectsPresentationOutsideOwnedRun(t *testing.T) {
	m, job, _, _ := visualReviewFixture(t)
	outside := filepath.Join(m.root, "outside.html")
	if err := os.WriteFile(outside, []byte(`<h1>private</h1>`), 0600); err != nil {
		t.Fatal(err)
	}
	m.update(job.ID, true, func(saved *Job) {
		saved.Results[0].Presentations = []PresentationArtifact{{Kind: "webpage", File: outside}}
	})
	m.openReport = func(string) error { return nil }
	path, err := m.OpenResultsReport()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	html := string(data)
	if strings.Contains(html, "private") || !strings.Contains(html, "outside its owned run") {
		t.Fatal("outside presentation was embedded")
	}
}

func TestResultsReportAPIRegeneratesAndOpensReport(t *testing.T) {
	m, _, _, _ := visualReviewFixture(t)
	opened := ""
	m.openReport = func(path string) error { opened = path; return nil }
	handler := Handler(m, "report-token")
	request := httptest.NewRequest("POST", "/results/open-html", nil)
	request.Header.Set("Authorization", "Bearer report-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 200 || opened == "" {
		t.Fatalf("open report returned %d: %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(opened); err != nil {
		t.Fatal(err)
	}
}
