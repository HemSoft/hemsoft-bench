package bench

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var jobIDPattern = regexp.MustCompile(`^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`)

func safeStore(root string) error {
	p := filepath.Join(root, ".local", "managed-runs")
	if st, e := os.Lstat(p); e == nil {
		if st.Mode()&os.ModeSymlink != 0 || !st.IsDir() {
			return errors.New("managed run store must be a real directory")
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	return nil
}
func ID() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func AtomicJSON(path string, value any) error {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	data, e := json.MarshalIndent(value, "", "  ")
	if e != nil {
		return e
	}
	temp, e := os.CreateTemp(filepath.Dir(path), ".save-*")
	if e != nil {
		return e
	}
	name := temp.Name()
	defer os.Remove(name)
	if _, e = temp.Write(data); e == nil {
		e = temp.Sync()
	}
	closeErr := temp.Close()
	if e != nil {
		return e
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(name, path)
}

type Manager struct {
	mu         sync.Mutex
	root       string
	path       string
	state      State
	execute    func(string)
	stop       chan struct{}
	stopping   bool
	openImage  func(string) error
	openReport func(string) error
}

func NewManager(root string) (*Manager, error) {
	root, e := filepath.Abs(root)
	if e != nil {
		return nil, e
	}
	m := &Manager{root: root, path: filepath.Join(root, ".local", "companion", "state.json"), stop: make(chan struct{}), openImage: openDefaultFile, openReport: openDefaultFile}
	data, e := os.ReadFile(m.path)
	if e == nil {
		if e = json.Unmarshal(data, &m.state); e != nil {
			return nil, fmt.Errorf("invalid manager state: %w", e)
		}
		if m.state.Version != 1 {
			return nil, errors.New("unsupported state version")
		}
	} else if !os.IsNotExist(e) {
		return nil, e
	} else {
		m.state = State{Version: 1, Limit: 2, Templates: []Template{}, Jobs: []*Job{}}
		t, e := ImportDefault(root)
		if e != nil {
			return nil, e
		}
		m.state.Templates = append(m.state.Templates, t)
	}
	if m.state.Limit < 1 || m.state.Limit > 8 {
		return nil, errors.New("invalid saved worker limit")
	}
	if e := safeStore(root); e != nil {
		return nil, e
	}
	for _, t := range m.state.Templates {
		if e := t.Validate(); e != nil {
			return nil, fmt.Errorf("invalid saved template: %w", e)
		}
	}
	for _, j := range m.state.Jobs {
		if !jobIDPattern.MatchString(j.ID) || j.RunDir != filepath.Join(root, ".local", "managed-runs", j.ID) {
			return nil, errors.New("invalid saved job ownership path")
		}
		if Terminal(j.Status) {
			for i, previous := range j.Results {
				rel, e := filepath.Rel(j.RunDir, previous.Path)
				if e != nil || filepath.IsAbs(rel) || strings.HasPrefix(rel, "..") {
					continue
				}
				data, e := os.ReadFile(previous.Path)
				if e != nil {
					continue
				}
				var restored Result
				if json.Unmarshal(data, &restored) == nil && restored.ID == previous.ID && restored.Task == previous.Task {
					restored.Path = previous.Path
					j.Results[i] = restored
				}
			}
			if j.Status == "provider_error" && len(j.Results) > 0 {
				if cause := j.Results[len(j.Results)-1].FailureMessage(); cause != "" {
					j.Error = cause
				}
			}
		}
		if j.Status == "running" || j.Status == "cancelling" || j.Status == "recovering" {
			j.Status = "recovering"
			j.CancelRequested = true
			j.Error = "Manager restarted; stopping the previous worker. No automatic paid retry."
			if e := os.WriteFile(filepath.Join(j.RunDir, "cancel"), []byte("recovery"), 0600); e != nil {
				return nil, e
			}
		}
	}
	m.execute = m.runJob
	if e = m.saveLocked(); e != nil {
		return nil, e
	}
	return m, nil
}
func ImportDefault(root string) (Template, error) {
	var c struct {
		Model       Model    `json:"model"`
		Tasks       []string `json:"tasks"`
		Repeat      int      `json:"repeat"`
		WallSeconds int      `json:"wallSeconds"`
		MaxRequests int      `json:"maxRequests"`
		USD         float64  `json:"maxEstimatedUsd"`
	}
	data, e := os.ReadFile(filepath.Join(root, "run.json"))
	if e != nil {
		return Template{}, e
	}
	if e = json.Unmarshal(data, &c); e != nil {
		return Template{}, e
	}
	c.Model.Name = c.Model.Model
	t := Template{Name: "Default", Models: []Model{c.Model}, Tasks: c.Tasks, Repeat: c.Repeat, WallSeconds: c.WallSeconds, MaxRequests: c.MaxRequests, MaxEstimatedUSD: c.USD, Concurrency: 1}
	return t, t.Validate()
}
func (m *Manager) saveLocked() error { return AtomicJSON(m.path, m.state) }
func (m *Manager) Snapshot() State {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := clone(m.state)
	if _, e := os.Stat(filepath.Join(m.root, ".local", "run-lock")); e == nil {
		s.Notice = "Legacy CLI lock exists. Its run and artifacts are separate and untouched."
	}
	return s
}
func (m *Manager) SaveTemplate(t Template) error {
	if e := t.Validate(); e != nil {
		return e
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	old := clone(m.state)
	found := false
	for i, x := range m.state.Templates {
		if x.Name == t.Name {
			m.state.Templates[i] = clone(t)
			found = true
			break
		}
	}
	if !found {
		if len(m.state.Templates) >= 100 {
			return errors.New("template limit reached")
		}
		m.state.Templates = append(m.state.Templates, clone(t))
	}
	if e := m.saveLocked(); e != nil {
		m.state = old
		return e
	}
	return nil
}
func (m *Manager) SetLimit(n int) error {
	if n < 1 || n > 8 {
		return errors.New("worker limit must be 1–8")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	old := m.state.Limit
	m.state.Limit = n
	if e := m.saveLocked(); e != nil {
		m.state.Limit = old
		return e
	}
	return nil
}
func (m *Manager) Enqueue(t Template) (string, error) {
	if e := t.Validate(); e != nil {
		return "", e
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stopping {
		return "", errors.New("manager is stopping")
	}
	if len(m.state.Jobs)+len(t.Models) > 500 {
		return "", errors.New("500-job limit reached; delete completed jobs")
	}
	if e := safeStore(m.root); e != nil {
		return "", e
	}
	batch := ID()
	created := []string{}
	oldLen := len(m.state.Jobs)
	for _, model := range t.Models {
		id := ID()
		dir := filepath.Join(m.root, ".local", "managed-runs", id)
		if e := os.MkdirAll(dir, 0700); e != nil {
			for _, d := range created {
				_ = os.RemoveAll(d)
			}
			m.state.Jobs = m.state.Jobs[:oldLen]
			return "", e
		}
		created = append(created, dir)
		now := time.Now()
		m.state.Jobs = append(m.state.Jobs, &Job{ID: id, BatchID: batch, Template: clone(t), Model: model, Status: "queued", Stage: "Waiting for a worker", QueuedAt: now, UpdatedAt: now, Results: []Result{}, RunDir: dir})
	}
	if e := m.saveLocked(); e != nil {
		m.state.Jobs = m.state.Jobs[:oldLen]
		for _, d := range created {
			_ = os.RemoveAll(d)
		}
		return "", e
	}
	return batch, nil
}
func (m *Manager) find(id string) *Job {
	for _, j := range m.state.Jobs {
		if j.ID == id {
			return j
		}
	}
	return nil
}
func (m *Manager) update(id string, persist bool, f func(*Job)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if j := m.find(id); j != nil {
		f(j)
		j.UpdatedAt = time.Now()
		if persist {
			if e := m.saveLocked(); e != nil {
				m.state.Notice = "Could not save state: " + e.Error()
			}
		}
	}
}
func (m *Manager) Cancel(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	j := m.find(id)
	if j == nil {
		return errors.New("job not found")
	}
	if Terminal(j.Status) {
		return errors.New("job is already finished")
	}
	if e := os.WriteFile(filepath.Join(j.RunDir, "cancel"), []byte("cancel requested"), 0600); e != nil {
		return e
	}
	j.CancelRequested = true
	if j.Status == "queued" {
		j.Status = "cancelled"
		now := time.Now()
		j.FinishedAt = &now
	} else {
		j.Status = "cancelling"
	}
	j.Stage = "Cancellation requested; waiting for cleanup"
	return m.saveLocked()
}
func (m *Manager) cancelled(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	j := m.find(id)
	return j == nil || j.CancelRequested
}
func (m *Manager) checkExport(j *Job, path, suffix, hash string, maxSize int64) (bool, error) {
	expected := filepath.Join(m.root, ".local", "results", filepath.Base(j.Model.Model)+"-bike"+suffix)
	if path != expected || len(hash) != 64 {
		return false, errors.New("unexpected visual export path or hash")
	}
	store, e := os.Lstat(filepath.Dir(expected))
	if e != nil || !store.IsDir() || store.Mode()&os.ModeSymlink != 0 {
		return false, errors.New("linked or missing visual export store")
	}
	info, e := os.Lstat(path)
	if os.IsNotExist(e) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	if !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > maxSize {
		return false, errors.New("visual export changed; operation refused")
	}
	data, e := os.ReadFile(path)
	if e != nil {
		return false, e
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != hash {
		return false, errors.New("visual export modified; operation refused")
	}
	return true, nil
}
func (m *Manager) visualResult(id, resultID string) (*Job, *Result, string, error) {
	j := m.find(id)
	if j == nil || !Terminal(j.Status) || j.PID != 0 {
		return nil, nil, "", errors.New("finished run not found")
	}
	for i := range j.Results {
		r := &j.Results[i]
		if r.ID != resultID || r.Task != "kangaroo-bike" || r.Artifact == nil {
			continue
		}
		if r.Artifact.Published && r.Artifact.PNGPublicFile != "" {
			ok, e := m.checkExport(j, r.Artifact.PNGPublicFile, ".png", r.Artifact.PNGSHA256, 8*1048576)
			if e != nil {
				return nil, nil, "", e
			}
			if !ok {
				return nil, nil, "", errors.New("PNG is missing")
			}
			return j, r, r.Artifact.PNGPublicFile, nil
		}
		// A later run may collide with a protected model-named pair. Its own
		// PNG is still safe to review and rate without overwriting that pair.
		path := r.Artifact.PNGOwnedFile
		rel, e := filepath.Rel(j.RunDir, r.Path)
		if e != nil || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || path != filepath.Join(filepath.Dir(r.Path), "bike.png") || len(r.Artifact.PNGSHA256) != 64 {
			return nil, nil, "", errors.New("unexpected owned PNG path")
		}
		if e = safeStore(m.root); e != nil {
			return nil, nil, "", e
		}
		for _, dir := range []string{j.RunDir, filepath.Dir(r.Path)} {
			info, err := os.Lstat(dir)
			if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return nil, nil, "", errors.New("linked or missing visual run directory")
			}
		}
		info, e := os.Lstat(path)
		if e != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > 8*1048576 {
			return nil, nil, "", errors.New("owned PNG missing or changed")
		}
		data, e := os.ReadFile(path)
		if e != nil {
			return nil, nil, "", e
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != r.Artifact.PNGSHA256 {
			return nil, nil, "", errors.New("owned PNG modified")
		}
		return j, r, path, nil
	}
	return nil, nil, "", errors.New("PNG not found for this run")
}
func (m *Manager) OpenImage(id, resultID string) error {
	m.mu.Lock()
	_, _, path, e := m.visualResult(id, resultID)
	m.mu.Unlock()
	if e != nil {
		return e
	}
	return m.openImage(path)
}
func (m *Manager) reviewableResult(id, resultID string) (*Job, *Result, error) {
	if j, r, _, e := m.visualResult(id, resultID); e == nil {
		return j, r, nil
	}
	j := m.find(id)
	if j == nil || !Terminal(j.Status) || j.PID != 0 {
		return nil, nil, errors.New("finished run not found")
	}
	for i := range j.Results {
		r := &j.Results[i]
		if r.ID != resultID || r.Task != "world-clock" {
			continue
		}
		for _, presentation := range r.Presentations {
			if presentation.Kind == "webpage" {
				if _, e := readOwnedPresentation(j, presentation.File); e != nil {
					return nil, nil, e
				}
				return j, r, nil
			}
		}
	}
	return nil, nil, errors.New("visual artifact not found for this run")
}
func (m *Manager) ScoreVisual(id, resultID string, score int) error {
	if score < 0 || score > 10 {
		return errors.New("score must be 0 through 10")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	j, r, e := m.reviewableResult(id, resultID)
	if e != nil {
		return e
	}
	rel, e := filepath.Rel(j.RunDir, r.Path)
	if e != nil || filepath.IsAbs(rel) || rel == "." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || rel == ".." {
		return errors.New("unexpected result path")
	}
	info, e := os.Lstat(r.Path)
	if e != nil || !info.Mode().IsRegular() {
		return errors.New("result record is missing or linked")
	}
	copy := *r
	copy.HumanScore = &score
	if e = AtomicJSON(r.Path, copy); e != nil {
		return e
	}
	*r = copy
	j.UpdatedAt = time.Now()
	return m.saveLocked()
}
func (m *Manager) ScoreImage(id, resultID string, score int) error {
	return m.ScoreVisual(id, resultID, score)
}
func (m *Manager) deleteLocked(id string) error {
	j := m.find(id)
	if j == nil {
		return errors.New("job not found")
	}
	if !Terminal(j.Status) || j.PID != 0 || j.Status == "interrupted" || j.Status == "cleanup_error" || j.CleanupUncertain {
		return errors.New("job may still own resources; deletion refused")
	}
	if e := safeStore(m.root); e != nil {
		return e
	}
	expected := filepath.Join(m.root, ".local", "managed-runs", j.ID)
	if j.RunDir != expected {
		return errors.New("unexpected artifact path")
	}
	if s, e := os.Lstat(expected); e == nil && s.Mode()&os.ModeSymlink != 0 {
		return errors.New("linked artifact directory refused")
	}
	// Check every named export before removing any. A modified PNG must not
	// cause us to delete the SVG while retaining only the PNG, or vice versa.
	var exports []string
	for _, r := range j.Results {
		if r.Artifact == nil || !r.Artifact.Published {
			continue
		}
		for _, spec := range []struct {
			path, suffix, hash string
			maxSize            int64
		}{
			{r.Artifact.PublicFile, ".svg", r.Artifact.SHA256, 1048576},
			{r.Artifact.PNGPublicFile, ".png", r.Artifact.PNGSHA256, 8 * 1048576},
		} {
			if spec.path == "" {
				continue
			} // Older runs published only SVG.
			present, e := m.checkExport(j, spec.path, spec.suffix, spec.hash, spec.maxSize)
			if e != nil {
				return e
			}
			if present {
				exports = append(exports, spec.path)
			}
		}
	}
	for _, path := range exports {
		if e := os.Remove(path); e != nil {
			return e
		}
	}
	if e := os.RemoveAll(expected); e != nil {
		return e
	}
	for i, x := range m.state.Jobs {
		if x.ID == id {
			m.state.Jobs = append(m.state.Jobs[:i], m.state.Jobs[i+1:]...)
			break
		}
	}
	return m.saveLocked()
}
func (m *Manager) Delete(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.deleteLocked(id)
}
func (m *Manager) StopIdle() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, j := range m.state.Jobs {
		if !Terminal(j.Status) {
			return errors.New("cancel or finish all queued/running jobs before stopping the manager")
		}
	}
	if !m.stopping {
		m.stopping = true
		close(m.stop)
	}
	return nil
}
func (m *Manager) Start() {
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				m.schedule()
			case <-m.stop:
				return
			}
		}
	}()
}
func (m *Manager) schedule() {
	m.mu.Lock()
	if m.stopping {
		m.mu.Unlock()
		return
	}
	active := 0
	byBatch := map[string]int{}
	for _, j := range m.state.Jobs {
		if j.Status == "recovering" && !ProcessAlive(j.PID) {
			now := time.Now()
			j.Status = "interrupted"
			j.PID = 0
			j.FinishedAt = &now
			j.Stage = "Interrupted; inspect retained artifacts before retry"
			_ = m.saveLocked()
		}
		if j.Status == "running" || j.Status == "cancelling" || j.Status == "recovering" {
			active++
			byBatch[j.BatchID]++
		}
	}
	ids := []string{}
	for _, j := range m.state.Jobs {
		if active >= m.state.Limit {
			break
		}
		if j.Status != "queued" || byBatch[j.BatchID] >= j.Template.Concurrency {
			continue
		}
		now := time.Now()
		j.Status = "running"
		j.StartedAt = &now
		j.Stage = "Checking readiness"
		j.Concurrency = m.state.Limit
		active++
		byBatch[j.BatchID]++
		ids = append(ids, j.ID)
	}
	if len(ids) > 0 {
		if e := m.saveLocked(); e != nil {
			m.state.Notice = e.Error()
			for _, id := range ids {
				j := m.find(id)
				j.Status = "queued"
				j.StartedAt = nil
			}
			ids = nil
		}
	}
	m.mu.Unlock()
	for _, id := range ids {
		go m.execute(id)
	}
}
func (m *Manager) finish(id, status string, err error) {
	m.update(id, true, func(j *Job) {
		if j.CancelRequested && status != "cleanup_error" && !j.CleanupUncertain {
			status = "cancelled"
		}
		j.Status = status
		j.Stage = "Finished"
		j.PID = 0
		now := time.Now()
		j.FinishedAt = &now
		if err != nil {
			j.Error = err.Error()
		}
	})
	m.mu.Lock()
	defer m.mu.Unlock()
	j := m.find(id)
	if j == nil || j.Template.KeepHistory {
		return
	}
	// Only prune older complete batches for this template, once this whole batch ends.
	for _, x := range m.state.Jobs {
		if x.BatchID == j.BatchID && !Terminal(x.Status) {
			return
		}
	}
	blocked := map[string]bool{}
	for _, x := range m.state.Jobs {
		if !Terminal(x.Status) || x.PID != 0 || x.Status == "interrupted" || x.Status == "cleanup_error" || x.CleanupUncertain {
			blocked[x.BatchID] = true
		}
	}
	ids := []string{}
	for _, x := range m.state.Jobs {
		if x.Template.Name == j.Template.Name && x.BatchID != j.BatchID && x.QueuedAt.Before(j.QueuedAt) && !x.Template.KeepHistory && !blocked[x.BatchID] {
			ids = append(ids, x.ID)
		}
	}
	for _, old := range ids {
		if e := m.deleteLocked(old); e != nil {
			m.state.Notice = "Retention: " + e.Error()
			break
		}
	}
}
func (m *Manager) runJob(id string) {
	m.mu.Lock()
	job := clone(m.find(id))
	m.mu.Unlock()
	if job == nil {
		return
	}
	config := filepath.Join(job.RunDir, "config.json")
	c := map[string]any{"model": job.Model, "executionContext": map[string]int{"concurrency": job.Concurrency}}
	if e := AtomicJSON(config, c); e != nil {
		m.finish(id, "infrastructure_error", e)
		return
	}
	steps := [][]string{{"doctor"}, {"verify"}, {"self-test", "--config", config, "--wall-seconds", "60", "--progress-json"}}
	for _, task := range job.Template.Tasks {
		steps = append(steps, []string{"run", task, "--config", config, "--repeat", strconv.Itoa(job.Template.Repeat), "--wall-seconds", strconv.Itoa(job.Template.WallSeconds), "--max-requests", strconv.Itoa(job.Template.MaxRequests), "--max-estimated-usd", strconv.FormatFloat(job.Template.MaxEstimatedUSD, 'f', -1, 64), "--execute", "--progress-json"})
	}
	for _, args := range steps {
		if m.cancelled(id) {
			m.finish(id, "cancelled", nil)
			return
		}
		m.update(id, true, func(j *Job) { j.Stage = args[0]; j.Activity = nil })
		if e := m.command(id, args); e != nil {
			status := "infrastructure_error"
			m.mu.Lock()
			j := m.find(id)
			if len(j.Results) > 0 {
				last := j.Results[len(j.Results)-1]
				if last.Status != "passed" && last.Status != "failed" && last.Status != "needs_visual_review" {
					status = last.Status
					if cause := last.FailureMessage(); cause != "" {
						e = fmt.Errorf("%s: %s", status, cause)
					}
				}
			}
			m.mu.Unlock()
			m.finish(id, status, e)
			return
		}
	}
	status := "passed"
	visual := false
	m.mu.Lock()
	j := m.find(id)
	if len(j.Results) != len(j.Template.Tasks)*j.Template.Repeat {
		status = "incomplete"
	} else {
		for _, r := range j.Results {
			if r.Status == "needs_visual_review" {
				visual = true
			} else if r.Status != "passed" {
				status = "failed"
			}
		}
	}
	m.mu.Unlock()
	if status == "passed" && visual {
		status = "needs_visual_review"
	}
	m.finish(id, status, nil)
}

type boundedLog struct {
	mu sync.Mutex
	w  io.Writer
	n  int
}

func (l *boundedLog) Write(b []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	size := len(b)
	if l.n < 1024*1024 {
		end := min(size, 1024*1024-l.n)
		n, e := l.w.Write(b[:end])
		l.n += n
		if e != nil {
			return n, e
		}
	}
	return size, nil
}
func (m *Manager) command(id string, args []string) error {
	m.mu.Lock()
	job := clone(m.find(id))
	m.mu.Unlock()
	log, e := os.OpenFile(filepath.Join(job.RunDir, "runner.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if e != nil {
		return e
	}
	defer log.Close()
	info, _ := log.Stat()
	out := &boundedLog{w: log, n: int(info.Size())}
	args = append([]string{filepath.Join(m.root, "src", "cli.mjs")}, args...)
	args = append(args, "--managed-run", id)
	cmd := exec.Command("node", args...)
	cmd.Dir = m.root
	ConfigureChild(cmd)
	pipe, e := cmd.StdoutPipe()
	if e != nil {
		return e
	}
	var stderr bytes.Buffer
	cmd.Stderr = io.MultiWriter(out, &boundedLog{w: &stderr})
	if e = cmd.Start(); e != nil {
		return e
	}
	m.update(id, true, func(j *Job) { j.PID = cmd.Process.Pid })
	scanner := bufio.NewScanner(pipe)
	scanner.Buffer(make([]byte, 65536), 1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		var event struct {
			Type       string    `json:"type"`
			Task       string    `json:"task"`
			Stage      string    `json:"stage"`
			Activity   *Activity `json:"activity"`
			ResultFile string    `json:"resultFile"`
		}
		if json.Unmarshal(line, &event) != nil {
			_, _ = out.Write(append(append([]byte{}, line...), '\n'))
			continue
		}
		if event.Type == "progress" {
			m.update(id, false, func(j *Job) { j.Stage = event.Stage; j.Task = event.Task; j.Activity = event.Activity })
			continue
		}
		if event.ResultFile != "" {
			rel, e := filepath.Rel(job.RunDir, event.ResultFile)
			if e != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
				continue
			}
			data, e := os.ReadFile(event.ResultFile)
			if e != nil {
				continue
			}
			var result Result
			if json.Unmarshal(data, &result) != nil {
				continue
			}
			result.Path = event.ResultFile
			if result.Status == "cleanup_error" {
				m.update(id, true, func(j *Job) { j.CleanupUncertain = true })
			}
			if !result.SelfTest {
				m.update(id, true, func(j *Job) { j.Results = append(j.Results, result) })
			}
		}
	}
	scanErr := scanner.Err()
	if scanErr != nil {
		_ = os.WriteFile(filepath.Join(job.RunDir, "cancel"), []byte("stream error"), 0600)
		_, _ = io.Copy(io.Discard, pipe)
	}
	waitErr := cmd.Wait()
	uncertain := false
	if entries, e := os.ReadDir(filepath.Join(job.RunDir, "runs")); e == nil {
		for _, entry := range entries {
			if entry.IsDir() {
				data, e := os.ReadFile(filepath.Join(job.RunDir, "runs", entry.Name(), "result.json"))
				var r Result
				if e != nil || json.Unmarshal(data, &r) != nil || r.Status == "cleanup_error" {
					uncertain = true
				}
			}
		}
	}
	m.update(id, true, func(j *Job) { j.PID = 0; j.CleanupUncertain = j.CleanupUncertain || uncertain })
	if scanErr != nil {
		return scanErr
	}
	if waitErr != nil {
		message := strings.ToLower(stderr.String())
		if args[1] == "doctor" && strings.Contains(message, "docker") && (strings.Contains(message, "failed to connect to the docker api") || strings.Contains(message, "cannot connect to the docker daemon") || strings.Contains(message, "is the docker daemon running")) {
			return fmt.Errorf("Docker engine is unavailable. Make sure Docker Desktop is running, then start a new run. No model calls were made. Diagnostics: %s", filepath.Join(job.RunDir, "runner.log"))
		}
		return fmt.Errorf("%s stopped: %w. Diagnostics: %s", args[1], waitErr, filepath.Join(job.RunDir, "runner.log"))
	}
	return nil
}
