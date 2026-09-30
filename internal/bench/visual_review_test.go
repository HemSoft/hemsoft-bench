package bench

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func visualReviewFixture(t *testing.T) (*Manager, *Job, string, string) {
	t.Helper()
	m := manager(t)
	v := template()
	v.Tasks = []string{"kangaroo-bike"}
	if _, err := m.Enqueue(v); err != nil {
		t.Fatal(err)
	}
	j := m.Snapshot().Jobs[0]
	svg, png := filepath.Join(m.root, ".local", "results", "kimi-k3-bike.svg"), filepath.Join(m.root, ".local", "results", "kimi-k3-bike.png")
	if err := os.MkdirAll(filepath.Dir(svg), 0700); err != nil {
		t.Fatal(err)
	}
	svgData, pngData := []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`), []byte("png fixture")
	if err := os.WriteFile(svg, svgData, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(png, pngData, 0600); err != nil {
		t.Fatal(err)
	}
	svgSum, pngSum := sha256.Sum256(svgData), sha256.Sum256(pngData)
	path := filepath.Join(j.RunDir, "runs", "attempt", "result.json")
	result := Result{ID: "attempt", Task: "kangaroo-bike", Status: "needs_visual_review", Path: path, Artifact: &VisualArtifact{Published: true, PublicFile: svg, SHA256: hex.EncodeToString(svgSum[:]), PNGPublicFile: png, PNGSHA256: hex.EncodeToString(pngSum[:])}}
	if err := AtomicJSON(path, result); err != nil {
		t.Fatal(err)
	}
	m.update(j.ID, true, func(job *Job) { job.Status = "needs_visual_review"; job.Results = []Result{result} })
	return m, j, svg, png
}

func TestVisualReviewOpensPNGAndPersistsSeparateHumanScore(t *testing.T) {
	m, j, _, png := visualReviewFixture(t)
	opened := ""
	m.openImage = func(path string) error { opened = path; return nil }
	if err := m.OpenImage(j.ID, "attempt"); err != nil {
		t.Fatal(err)
	}
	if opened != png {
		t.Fatalf("opened %q instead of PNG", opened)
	}
	if err := m.ScoreImage(j.ID, "attempt", 8); err != nil {
		t.Fatal(err)
	}
	if err := m.ScoreImage(j.ID, "attempt", 10); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewManager(m.root)
	if err != nil {
		t.Fatal(err)
	}
	r := reloaded.Snapshot().Jobs[0].Results[0]
	if r.HumanScore == nil || *r.HumanScore != 10 || r.Grade != nil || r.Status != "needs_visual_review" {
		t.Fatalf("rating changed benchmark grade/status: %+v", r)
	}
}

func TestVisualReviewRejectsTamperingAndDeletesBothExportsSafely(t *testing.T) {
	m, j, svg, png := visualReviewFixture(t)
	if err := m.ScoreImage(j.ID, "attempt", -1); err == nil {
		t.Fatal("accepted negative score")
	}
	if err := m.ScoreImage(j.ID, "attempt", 11); err == nil {
		t.Fatal("accepted out-of-range score")
	}
	if err := os.WriteFile(png, []byte("modified"), 0600); err != nil {
		t.Fatal(err)
	}
	m.openImage = func(string) error { t.Fatal("must not open changed image"); return nil }
	if err := m.OpenImage(j.ID, "attempt"); err == nil {
		t.Fatal("opened modified PNG")
	}
	if err := m.ScoreImage(j.ID, "attempt", 5); err == nil {
		t.Fatal("scored modified PNG")
	}
	if err := m.Delete(j.ID); err == nil {
		t.Fatal("deleted changed PNG")
	}
	if _, err := os.Stat(svg); err != nil {
		t.Fatal("SVG was removed before checking PNG")
	}
	if err := os.WriteFile(png, []byte("png fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := m.Delete(j.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(svg); !os.IsNotExist(err) {
		t.Fatal("owned SVG not removed")
	}
	if _, err := os.Stat(png); !os.IsNotExist(err) {
		t.Fatal("owned PNG not removed")
	}
}

func TestCollidingRunCanStillOpenAndRateItsOwnedPNG(t *testing.T) {
	m, j, _, _ := visualReviewFixture(t)
	owned := filepath.Join(j.RunDir, "runs", "attempt", "bike.png")
	if err := os.WriteFile(owned, []byte("png fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	m.update(j.ID, true, func(job *Job) {
		r := &job.Results[0]
		r.Status = "artifact_conflict"
		r.Artifact.Published = false
		r.Artifact.PNGPublicFile = ""
		r.Artifact.PNGOwnedFile = owned
	})
	opened := ""
	m.openImage = func(path string) error { opened = path; return nil }
	if err := m.OpenImage(j.ID, "attempt"); err != nil {
		t.Fatal(err)
	}
	if opened != owned {
		t.Fatalf("opened wrong candidate: %q", opened)
	}
	if err := m.ScoreImage(j.ID, "attempt", 4); err != nil {
		t.Fatal(err)
	}
	if got := m.Snapshot().Jobs[0].Results[0]; got.HumanScore == nil || *got.HumanScore != 4 || got.Status != "artifact_conflict" {
		t.Fatalf("candidate status or rating changed: %+v", got)
	}
}

func TestWorldClockRatingRequiresOwnedWebpageAndPersists(t *testing.T) {
	m := manager(t)
	v := template()
	v.Tasks = []string{"world-clock"}
	if _, err := m.Enqueue(v); err != nil {
		t.Fatal(err)
	}
	j := m.Snapshot().Jobs[0]
	attempt := filepath.Join(j.RunDir, "runs", "clock")
	page := filepath.Join(attempt, "world-clock.html")
	if err := os.MkdirAll(attempt, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(page, []byte("<!doctype html><title>Clock</title>"), 0600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(attempt, "result.json")
	result := Result{ID: "clock", Task: "world-clock", Status: "needs_visual_review", Path: path, Presentations: []PresentationArtifact{{Kind: "webpage", File: page}}}
	if err := AtomicJSON(path, result); err != nil {
		t.Fatal(err)
	}
	m.update(j.ID, true, func(job *Job) { job.Status = "needs_visual_review"; job.Results = []Result{result} })
	if err := m.ScoreVisual(j.ID, "clock", 9); err != nil {
		t.Fatal(err)
	}
	saved := m.Snapshot().Jobs[0].Results[0]
	if saved.HumanScore == nil || *saved.HumanScore != 9 || saved.Grade != nil {
		t.Fatalf("unexpected rating: %+v", saved)
	}
	if err := os.Remove(page); err != nil {
		t.Fatal(err)
	}
	if err := m.ScoreVisual(j.ID, "clock", 4); err == nil {
		t.Fatal("rated missing webpage")
	}
}

func TestVisualReviewAPIRejectsMissingScore(t *testing.T) {
	m, j, _, _ := visualReviewFixture(t)
	h := Handler(m, "private-test-token")
	req := httptest.NewRequest("POST", "/jobs/"+j.ID+"/score-image", strings.NewReader(`{"resultId":"attempt"}`))
	req.Header.Set("Authorization", "Bearer private-test-token")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatalf("missing score returned %d", w.Code)
	}
	req = httptest.NewRequest("POST", "/jobs/"+j.ID+"/score-image", strings.NewReader(`{"resultId":"attempt","score":0}`))
	req.Header.Set("Authorization", "Bearer private-test-token")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("score zero returned %d: %s", w.Code, w.Body.String())
	}
	var saved Result
	data, err := os.ReadFile(filepath.Join(j.RunDir, "runs", "attempt", "result.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.HumanScore == nil || *saved.HumanScore != 0 {
		t.Fatal("zero rating lost")
	}
}
