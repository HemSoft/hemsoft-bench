package tui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/HemSoft/hemsoft-bench/internal/bench"
	"github.com/charmbracelet/x/ansi"
)

func TestFullSuiteReportsCodeChecksAndVisualReviewSeparately(t *testing.T) {
	m := demo()
	j := m.state.Jobs[0]
	j.Template.Tasks = []string{"resilient-scheduler", "kangaroo-bike"}
	j.Results = append(j.Results, bench.Result{Task: "kangaroo-bike", Status: "needs_visual_review", Artifact: &bench.VisualArtifact{File: "D:\\example\\.local\\results\\kimi-k3-bike.svg", Published: true}})
	j.Status = "needs_visual_review"
	text := m.runDetail(j)
	for _, want := range []string{"Check pass rate: 100.0% (60/60 hidden checks)", "Coding tests passed: 1/1.", "SVG saved for human review; appearance ungraded.", "kimi-k3-bike.svg"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in %s", want, text)
		}
	}
	if strings.Contains(text, "3/3 tests passed") {
		t.Fatal("visual task counted as a scored pass")
	}
}
func TestOpenPNGThenRateWithoutChangingCodingGrade(t *testing.T) {
	calls := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path)
		var body struct {
			ResultID string `json:"resultId"`
			Score    *int   `json:"score"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.ResultID != "picture" {
			t.Errorf("wrong image %q", body.ResultID)
		}
		if strings.HasSuffix(r.URL.Path, "/score-image") && (body.Score == nil || *body.Score != 10) {
			t.Errorf("wrong rating %+v", body.Score)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	m := demo()
	m.client = &bench.Client{Endpoint: bench.Endpoint{URL: server.URL, Token: "test"}, HTTP: server.Client()}
	j := m.state.Jobs[0]
	j.Status = "needs_visual_review"
	j.Template.Tasks = []string{"resilient-scheduler", "kangaroo-bike"}
	j.Results = append(j.Results, bench.Result{ID: "picture", Task: "kangaroo-bike", Status: "needs_visual_review", Artifact: &bench.VisualArtifact{File: "bike.svg", PNGFile: "bike.png", PNGPublicFile: "bike.png", Published: true}})
	m.screen = runScreen
	m.watchID = j.ID
	m.refreshDetail()
	if !strings.Contains(ansi.Strip(m.View().Content), "1 open PNG") {
		t.Fatal("PNG action not selectable")
	}
	m, cmd := press(m, "1")
	if cmd == nil || !m.busy {
		t.Fatal("1 did not request opening the image")
	}
	next, _ := m.Update(cmd())
	m = next.(Model)
	if !m.ratingPrompt || m.ratingKind != "image" || m.busy || !strings.Contains(ansi.Strip(m.View().Content), "RATE THE PNG") {
		t.Fatal("no PNG prompt after opening image")
	}
	m, _ = press(m, "1")
	m, _ = press(m, "0")
	m, cmd = press(m, "enter")
	if cmd == nil || !m.busy {
		t.Fatal("did not submit rating")
	}
	next, _ = m.Update(cmd())
	m = next.(Model)
	if m.ratingPrompt || m.busy {
		t.Fatal("rating prompt not closed")
	}
	if m.err != "" || m.success != "Rating saved." || !strings.Contains(m.runDetail(j), good.Render("10/10")) || !strings.Contains(m.View().Content, good.Render("Rating saved.")) {
		t.Fatal("saved rating did not immediately replace the review label with green success")
	}
	if len(calls) != 2 || !strings.HasSuffix(calls[0], "/open-image") || !strings.HasSuffix(calls[1], "/score-image") {
		t.Fatalf("unexpected API calls: %v", calls)
	}
	if j.Results[0].Grade.Passed != 60 {
		t.Fatal("coding grade changed")
	}
}
func TestNumberKeysChoosePNGAndHTMLWhenBothVisualsNeedReview(t *testing.T) {
	calls := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	m := demo()
	m.client = &bench.Client{Endpoint: bench.Endpoint{URL: server.URL, Token: "test"}, HTTP: server.Client()}
	j := m.state.Jobs[0]
	j.Status = "needs_visual_review"
	j.Template.Tasks = []string{"resilient-scheduler", "kangaroo-bike", "world-clock"}
	j.Results = append(j.Results,
		bench.Result{ID: "picture", Task: "kangaroo-bike", Status: "needs_visual_review", Artifact: &bench.VisualArtifact{PNGFile: "bike.png", PNGPublicFile: "bike.png", Published: true}},
		bench.Result{ID: "clock", Task: "world-clock", Status: "needs_visual_review", Presentations: []bench.PresentationArtifact{{Kind: "webpage", File: "world-clock.html"}}},
	)
	m.screen, m.watchID = runScreen, j.ID
	m.refreshDetail()
	view := ansi.Strip(m.View().Content)
	if !strings.Contains(view, "1 open PNG") || !strings.Contains(view, "2 open HTML results") {
		t.Fatal("numbered visual actions are not shown: " + view)
	}
	unchanged, oldCmd := press(m, "v")
	if oldCmd != nil || unchanged.busy || len(calls) != 0 {
		t.Fatal("v must not choose between visual reviews")
	}
	m, cmd := press(m, "1")
	if cmd == nil {
		t.Fatal("1 did not open the PNG")
	}
	next, _ := m.Update(cmd())
	m = next.(Model)
	if !m.ratingPrompt || m.ratingKind != "image" || m.ratingResultID != "picture" {
		t.Fatal("PNG rating prompt missing")
	}
	m, _ = press(m, "esc")
	m, cmd = press(m, "2")
	if cmd == nil {
		t.Fatal("2 did not open the HTML results")
	}
	next, _ = m.Update(cmd())
	m = next.(Model)
	if !m.ratingPrompt || m.ratingKind != "webpage" || m.ratingResultID != "clock" {
		t.Fatal("world-clock rating prompt missing")
	}
	if len(calls) != 2 || !strings.HasSuffix(calls[0], "/open-image") || calls[1] != "/results/open-html" {
		t.Fatalf("unexpected calls: %v", calls)
	}
}

func TestWorldClockOpensHTMLThenAcceptsSeparateRating(t *testing.T) {
	calls := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	m := demo()
	m.client = &bench.Client{Endpoint: bench.Endpoint{URL: server.URL, Token: "test"}, HTTP: server.Client()}
	j := m.state.Jobs[0]
	j.Status = "needs_visual_review"
	j.Template.Tasks = []string{"resilient-scheduler", "world-clock"}
	j.Results = append(j.Results, bench.Result{ID: "clock", Task: "world-clock", Status: "needs_visual_review", Presentations: []bench.PresentationArtifact{{Kind: "webpage", File: "world-clock.html"}}})
	m.screen, m.watchID = runScreen, j.ID
	m.refreshDetail()
	if _, kind := reviewableVisualTask(j, "world-clock"); kind != "webpage" {
		t.Fatal("world clock is not reviewable")
	}
	m, cmd := press(m, "2")
	if cmd == nil {
		t.Fatal("2 did not open HTML report")
	}
	next, _ := m.Update(cmd())
	m = next.(Model)
	if !m.ratingPrompt || m.ratingKind != "webpage" || m.ratingResultID != "clock" || !strings.Contains(ansi.Strip(m.View().Content), "RATE THE WORLD CLOCK") {
		t.Fatal("world-clock rating prompt missing")
	}
	m, _ = press(m, "9")
	m, cmd = press(m, "enter")
	next, _ = m.Update(cmd())
	m = next.(Model)
	if m.ratingPrompt || j.Results[len(j.Results)-1].HumanScore == nil || *j.Results[len(j.Results)-1].HumanScore != 9 {
		t.Fatal("world-clock rating was not saved")
	}
	if len(calls) != 2 || calls[0] != "/results/open-html" || !strings.HasSuffix(calls[1], "/score-image") {
		t.Fatalf("unexpected calls: %v", calls)
	}
}

func TestRatingCanBeSkippedAndOlderSVGOnlyRunsHaveNoOpenAction(t *testing.T) {
	m := demo()
	m.screen = runScreen
	m.watchID = m.state.Jobs[0].ID
	m.ratingPrompt = true
	m.ratingInput = "7"
	m.ratingJobID = "old"
	m.ratingResultID = "picture"
	m, cmd := press(m, "esc")
	if cmd != nil || m.ratingPrompt || m.ratingInput != "" || m.screen != runScreen {
		t.Fatal("escape did not skip rating")
	}
	m, cmd = press(m, "1")
	if cmd != nil || m.busy {
		t.Fatal("older run should not open a nonexistent PNG")
	}
}
func TestCollidingCandidatePNGIsStillSelectable(t *testing.T) {
	m := demo()
	j := m.state.Jobs[0]
	j.Status = "artifact_conflict"
	j.Results = append(j.Results, bench.Result{ID: "picture", Task: "kangaroo-bike", Status: "artifact_conflict", Artifact: &bench.VisualArtifact{PNGFile: "run/bike.png", PNGOwnedFile: "run/bike.png", Collision: true}})
	m.screen = runScreen
	m.watchID = j.ID
	m.refreshDetail()
	if reviewableImage(j) == nil || !strings.Contains(ansi.Strip(m.View().Content), "1 open PNG") {
		t.Fatal("colliding image should remain viewable")
	}
}

func TestSavedHumanRatingStaysSeparateFromCodingScore(t *testing.T) {
	m := demo()
	j := m.state.Jobs[0]
	j.Template.Tasks = []string{"resilient-scheduler", "kangaroo-bike"}
	score := 0
	j.Results = append(j.Results, bench.Result{ID: "picture", Task: "kangaroo-bike", Status: "needs_visual_review", HumanScore: &score, Artifact: &bench.VisualArtifact{File: "bike.svg", PNGFile: "bike.png", PNGPublicFile: "bike.png", Published: true}})
	j.Status = "needs_visual_review"
	detail := m.runDetail(j)
	for _, text := range []string{"60/60 hidden checks", "Visual rating: 0/10", "PNG: bike.png", "1 open PNG with Windows"} {
		if !strings.Contains(detail, text) {
			t.Fatalf("missing %q", text)
		}
	}
	if strings.Contains(detail, "needs_visual_review") || strings.Contains(detail, "SVG saved for human review; appearance ungraded.") {
		t.Fatal("rated image still described as needing review")
	}
	if strings.Count(detail, good.Render("0/10")) != 3 {
		t.Fatal("expected one green run status, one summary rating and one green task status")
	}
	if got := j.Status; got != "needs_visual_review" {
		t.Fatal("display change must not rewrite the recorded status")
	}
	m.state.Jobs = []*bench.Job{j}
	m.width = 55
	m.screen = historyScreen
	if history := m.historyView(); !strings.Contains(history, good.Render("0/10")) || strings.Contains(history, "needs_visual_review") {
		t.Fatal("selected history row must show the green rating")
	}
}
func TestUnratedOrFailedRunsKeepTheirRealStatus(t *testing.T) {
	m := demo()
	j := m.state.Jobs[0]
	j.Template.Tasks = []string{"resilient-scheduler", "kangaroo-bike"}
	j.Status = "needs_visual_review"
	r := bench.Result{Task: "kangaroo-bike", Status: "needs_visual_review"}
	j.Results = append(j.Results, r)
	if label, rated := ratedRunStatus(j); label != "needs_visual_review" || rated {
		t.Fatalf("unrated status hidden: %q %v", label, rated)
	}
	score := 5
	j.Results[1].HumanScore = &score
	j.Status = "failed"
	if label, rated := ratedRunStatus(j); label != "failed" || rated {
		t.Fatalf("coding failure hidden by visual rating: %q %v", label, rated)
	}
	j.Status = "needs_visual_review"
	j.Template.Repeat = 2
	if label, rated := ratedRunStatus(j); label != "needs_visual_review" || rated {
		t.Fatalf("second image still needs a rating: %q %v", label, rated)
	}
}
func TestVisualReviewRunCanReportCompleteObservedUsage(t *testing.T) {
	m := demo()
	j := m.state.Jobs[0]
	j.Template.Tasks = []string{"resilient-scheduler", "kangaroo-bike"}
	v := 0.05
	j.Results[0].Metrics = &bench.Metrics{Estimated: &v, Reported: &v, UsageComplete: true}
	j.Results = append(j.Results, bench.Result{Task: "kangaroo-bike", Status: "needs_visual_review", Metrics: &bench.Metrics{Estimated: &v, Reported: &v, UsageComplete: true}})
	j.Status = "needs_visual_review"
	if got := jobCost(j); strings.Contains(got, "incomplete") || !strings.Contains(got, "estimated") {
		t.Fatal(got)
	}
}
func TestVisualArtifactIsNeverScoredAsCodingPass(t *testing.T) {
	m := demo()
	j := m.state.Jobs[0]
	j.Template.Tasks = []string{"kangaroo-bike"}
	j.Results = []bench.Result{{Task: "kangaroo-bike", Status: "needs_visual_review", Artifact: &bench.VisualArtifact{File: "D:\\example\\.local\\results\\kimi-k3-bike.svg", Published: true}}}
	j.Status = "needs_visual_review"
	text := m.runDetail(j)
	for _, want := range []string{"Visual task: human review required; no automatic score.", "SVG saved for human review; appearance ungraded.", "kimi-k3-bike.svg"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in %s", want, text)
		}
	}
	if strings.Contains(text, "Check pass rate:") || strings.Contains(text, "1/1 tests passed") {
		t.Fatal("visual existence was incorrectly scored")
	}
}
