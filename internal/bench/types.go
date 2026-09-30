package bench

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"
)

type Model struct {
	Name     string `json:"name"`
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Thinking string `json:"thinking"`
}
type Template struct {
	Name            string   `json:"name"`
	Models          []Model  `json:"models"`
	Tasks           []string `json:"tasks"`
	Repeat          int      `json:"repeat"`
	WallSeconds     int      `json:"wallSeconds"`
	MaxRequests     int      `json:"maxRequests"`
	MaxEstimatedUSD float64  `json:"maxEstimatedUsd"`
	Concurrency     int      `json:"concurrency"`
	KeepHistory     bool     `json:"keepHistory"`
}

var providerPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]*$`)

func (t Template) Validate() error {
	if strings.TrimSpace(t.Name) == "" || len(t.Name) > 80 {
		return errors.New("saved run name must contain 1 to 80 characters")
	}
	if len(t.Models) < 1 || len(t.Models) > 20 {
		return errors.New("choose 1–20 models")
	}
	for _, m := range t.Models {
		if !providerPattern.MatchString(m.Provider) || m.Model == "" || len(m.Model) > 256 || strings.HasPrefix(m.Model, "-") || strings.ContainsAny(m.Model, " \t\r\n*?[]") {
			return fmt.Errorf("invalid exact provider/model: %s/%s", m.Provider, m.Model)
		}
		switch m.Thinking {
		case "off", "minimal", "low", "medium", "high", "xhigh", "max":
		default:
			return errors.New("thinking must be off, minimal, low, medium, high, xhigh, or max")
		}
	}
	if len(t.Tasks) < 1 || len(t.Tasks) > 4 {
		return errors.New("select one to four benchmark tasks")
	}
	seen := map[string]bool{}
	for _, task := range t.Tasks {
		known := task == "resilient-scheduler" || task == "kangaroo-bike" || task == "world-clock" || task == "authority-ledger"
		if !known || seen[task] {
			return errors.New("tasks must be unique known benchmark tasks")
		}
		seen[task] = true
	}
	if t.Repeat < 1 || t.Repeat > 20 || t.WallSeconds < 1 || t.WallSeconds > 2700 || t.MaxRequests < 1 || t.MaxRequests > 200 {
		return errors.New("limits: repeats 1–20, seconds 1–2700, requests 1–200")
	}
	if math.IsNaN(t.MaxEstimatedUSD) || math.IsInf(t.MaxEstimatedUSD, 0) || t.MaxEstimatedUSD <= 0 || t.MaxEstimatedUSD > 100 {
		return errors.New("estimated USD must be greater than 0 and at most 100")
	}
	if t.Concurrency < 1 || t.Concurrency > 8 {
		return errors.New("parallel models must be 1–8")
	}
	return nil
}
func (t Template) Attempts() int            { return len(t.Models) * len(t.Tasks) * t.Repeat }
func (t Template) EstimatedBudget() float64 { return float64(t.Attempts()) * t.MaxEstimatedUSD }

type Activity struct {
	Phase          string `json:"phase"`
	Elapsed        int    `json:"executionElapsedSeconds"`
	Silence        int    `json:"silenceSeconds"`
	Events         int    `json:"events"`
	ToolsStarted   int    `json:"toolsStarted"`
	ToolsCompleted int    `json:"toolsCompleted"`
	ToolErrors     int    `json:"toolErrors"`
	Writes         int    `json:"writesCompleted"`
	LastTool       string `json:"lastTool"`
	Responses      int    `json:"completedResponses"`
	Retries        int    `json:"retriesScheduled,omitempty"`
}
type Grade struct {
	Passed  int  `json:"passed"`
	Total   int  `json:"total"`
	Success bool `json:"success"`
}
type Metrics struct {
	Usage struct {
		TotalTokens int `json:"totalTokens"`
	} `json:"usage"`
	UsageComplete           bool     `json:"usageComplete"`
	Estimated               *float64 `json:"estimatedCostUsd"`
	Reported                *float64 `json:"reportedEstimatedCostUsd"`
	ProviderErrors          []string `json:"providerErrors,omitempty"`
	RecoveredProviderErrors []string `json:"recoveredProviderErrors,omitempty"`
	RetryCount              int      `json:"retryCount,omitempty"`
}
type Recovery struct {
	State      string `json:"state"`
	Kind       string `json:"kind"`
	Grade      *Grade `json:"grade,omitempty"`
	Error      string `json:"error,omitempty"`
	SourceFile string `json:"sourceFile,omitempty"`
}
type VisualArtifact struct {
	File          string `json:"file"`
	PublicFile    string `json:"publicFile,omitempty"`
	OwnedFile     string `json:"ownedFile"`
	Published     bool   `json:"published"`
	Collision     bool   `json:"collision"`
	SHA256        string `json:"sha256"`
	PNGFile       string `json:"pngFile,omitempty"`
	PNGPublicFile string `json:"pngPublicFile,omitempty"`
	PNGOwnedFile  string `json:"pngOwnedFile,omitempty"`
	PNGSHA256     string `json:"pngSha256,omitempty"`
}

// PresentationArtifact is the report-facing contract for future visual tasks.
// Image files become gallery items. Self-contained HTML files render in a
// sandboxed viewport with network access blocked by the generated report.
type PresentationArtifact struct {
	Kind  string `json:"kind"`
	Label string `json:"label,omitempty"`
	File  string `json:"file"`
}

type Result struct {
	ID            string                 `json:"id"`
	Task          string                 `json:"task"`
	Status        string                 `json:"status"`
	Grade         *Grade                 `json:"grade"`
	Metrics       *Metrics               `json:"metrics"`
	Elapsed       float64                `json:"elapsedSeconds"`
	SelfTest      bool                   `json:"selfTest"`
	Error         string                 `json:"error,omitempty"`
	Path          string                 `json:"path"`
	Recovery      *Recovery              `json:"recovery,omitempty"`
	Artifact      *VisualArtifact        `json:"artifact,omitempty"`
	Presentations []PresentationArtifact `json:"presentations,omitempty"`
	HumanScore    *int                   `json:"humanScore,omitempty"`
}

func (r Result) FailureMessage() string {
	if r.Error != "" {
		return r.Error
	}
	if r.Metrics != nil {
		return strings.Join(r.Metrics.ProviderErrors, "; ")
	}
	return ""
}

type Job struct {
	ID               string     `json:"id"`
	BatchID          string     `json:"batchId"`
	Template         Template   `json:"template"`
	Model            Model      `json:"model"`
	Status           string     `json:"status"`
	Stage            string     `json:"stage"`
	Task             string     `json:"task"`
	QueuedAt         time.Time  `json:"queuedAt"`
	StartedAt        *time.Time `json:"startedAt,omitempty"`
	FinishedAt       *time.Time `json:"finishedAt,omitempty"`
	UpdatedAt        time.Time  `json:"updatedAt"`
	Activity         *Activity  `json:"activity,omitempty"`
	Results          []Result   `json:"results"`
	Error            string     `json:"error,omitempty"`
	PID              int        `json:"pid,omitempty"`
	CancelRequested  bool       `json:"cancelRequested"`
	CleanupUncertain bool       `json:"cleanupUncertain,omitempty"`
	RunDir           string     `json:"runDir"`
	Concurrency      int        `json:"concurrency"`
}

func Terminal(status string) bool {
	switch status {
	case "queued", "running", "cancelling", "recovering":
		return false
	}
	return true
}

type State struct {
	Version   int        `json:"version"`
	Limit     int        `json:"limit"`
	Templates []Template `json:"templates"`
	Jobs      []*Job     `json:"jobs"`
	Notice    string     `json:"notice,omitempty"`
}

func clone[T any](value T) T {
	data, _ := json.Marshal(value)
	var out T
	_ = json.Unmarshal(data, &out)
	return out
}
