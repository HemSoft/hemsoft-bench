package bench

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

type Endpoint struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	PID   int    `json:"pid"`
}
type Client struct {
	Endpoint Endpoint
	HTTP     *http.Client
}

func (c *Client) Call(method, path string, body any, out any) error {
	var data []byte
	var e error
	if body != nil {
		data, e = json.Marshal(body)
		if e != nil {
			return e
		}
	}
	req, e := http.NewRequest(method, c.Endpoint.URL+path, bytes.NewReader(data))
	if e != nil {
		return e
	}
	req.Header.Set("Authorization", "Bearer "+c.Endpoint.Token)
	req.Header.Set("Content-Type", "application/json")
	res, e := c.HTTP.Do(req)
	if e != nil {
		return e
	}
	defer res.Body.Close()
	data, e = io.ReadAll(io.LimitReader(res.Body, 8*1024*1024))
	if e != nil {
		return e
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("manager: %s", strings.TrimSpace(string(data)))
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}
func ReadClient(root string) (*Client, error) {
	data, e := os.ReadFile(filepath.Join(root, ".local", "companion", "endpoint.json"))
	if e != nil {
		return nil, e
	}
	var endpoint Endpoint
	if e = json.Unmarshal(data, &endpoint); e != nil {
		return nil, e
	}
	u, e := url.Parse(endpoint.URL)
	if e != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || len(endpoint.Token) != 64 {
		return nil, errors.New("invalid local manager endpoint")
	}
	return &Client{Endpoint: endpoint, HTTP: &http.Client{Timeout: 3 * time.Second}}, nil
}
func Ensure(root string) (*Client, error) {
	if c, e := ReadClient(root); e == nil {
		if c.Call("GET", "/health", nil, nil) == nil {
			return c, nil
		}
	}
	directory := filepath.Join(root, ".local", "companion")
	if e := os.MkdirAll(directory, 0700); e != nil {
		return nil, e
	}
	exe, e := os.Executable()
	if e != nil {
		return nil, e
	}
	log, e := os.OpenFile(filepath.Join(directory, "daemon.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if e != nil {
		return nil, e
	}
	cmd := exec.Command(exe, "--serve", "--root", root)
	cmd.Dir = root
	cmd.Stdout = log
	cmd.Stderr = log
	ConfigureDaemon(cmd)
	e = cmd.Start()
	_ = log.Close()
	if e != nil {
		return nil, e
	}
	_ = cmd.Process.Release()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if c, e := ReadClient(root); e == nil {
			if c.Call("GET", "/health", nil, nil) == nil {
				return c, nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return nil, fmt.Errorf("manager did not start; see %s", filepath.Join(directory, "daemon.log"))
}
func Handler(m *Manager, token string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		r.Body = http.MaxBytesReader(w, r.Body, 1024*1024)
		decode := func(v any) error {
			d := json.NewDecoder(r.Body)
			d.DisallowUnknownFields()
			if e := d.Decode(v); e != nil {
				return e
			}
			var extra any
			if d.Decode(&extra) != io.EOF {
				return errors.New("expected one JSON object")
			}
			return nil
		}
		var result any = map[string]bool{"ok": true}
		var e error
		switch {
		case r.Method == "GET" && r.URL.Path == "/health":
		case r.Method == "POST" && r.URL.Path == "/shutdown":
			e = m.StopIdle()
		case r.Method == "GET" && r.URL.Path == "/state":
			result = m.Snapshot()
		case r.Method == "PUT" && r.URL.Path == "/template":
			var t Template
			if e = decode(&t); e == nil {
				e = m.SaveTemplate(t)
			}
		case r.Method == "POST" && r.URL.Path == "/queue":
			var t Template
			if e = decode(&t); e == nil {
				var id string
				id, e = m.Enqueue(t)
				result = map[string]string{"batchId": id}
			}
		case r.Method == "POST" && r.URL.Path == "/limit":
			var v struct {
				Limit int `json:"limit"`
			}
			if e = decode(&v); e == nil {
				e = m.SetLimit(v.Limit)
			}
		case r.Method == "POST" && r.URL.Path == "/results/open-html":
			var path string
			path, e = m.OpenResultsReport()
			result = map[string]string{"path": path}
		case r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/jobs/"):
			parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/jobs/"), "/")
			if len(parts) != 2 {
				e = errors.New("invalid job action")
			} else if parts[1] == "cancel" {
				e = m.Cancel(parts[0])
			} else if parts[1] == "delete" {
				e = m.Delete(parts[0])
			} else if parts[1] == "open-image" || parts[1] == "score-image" || parts[1] == "score-visual" {
				var v struct {
					ResultID string `json:"resultId"`
					Score    *int   `json:"score,omitempty"`
				}
				if e = decode(&v); e == nil {
					if parts[1] == "open-image" {
						e = m.OpenImage(parts[0], v.ResultID)
					}
					if parts[1] == "score-image" || parts[1] == "score-visual" {
						if v.Score == nil {
							e = errors.New("score is required")
						} else {
							e = m.ScoreVisual(parts[0], v.ResultID, *v.Score)
						}
					}
				}
			} else {
				e = errors.New("unknown job action")
			}
		default:
			http.Error(w, "not found", 404)
			return
		}
		if e != nil {
			http.Error(w, e.Error(), 400)
			return
		}
		_ = json.NewEncoder(w).Encode(result)
	})
}
func Serve(root string) error {
	directory := filepath.Join(root, ".local", "companion")
	if e := os.MkdirAll(directory, 0700); e != nil {
		return e
	}
	lock := flock.New(filepath.Join(directory, "daemon.lock"))
	ok, e := lock.TryLock()
	if e != nil {
		return e
	}
	if !ok {
		return errors.New("manager already running")
	}
	defer lock.Unlock()
	m, e := NewManager(root)
	if e != nil {
		return e
	}
	listener, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		return e
	}
	defer listener.Close()
	b := make([]byte, 32)
	if _, e = rand.Read(b); e != nil {
		return e
	}
	endpoint := Endpoint{URL: "http://" + listener.Addr().String(), Token: hex.EncodeToString(b), PID: os.Getpid()}
	if e = AtomicJSON(filepath.Join(directory, "endpoint.json"), endpoint); e != nil {
		return e
	}
	m.Start()
	server := http.Server{Handler: Handler(m, endpoint.Token), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second}
	go func() {
		<-m.stop
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	err := server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
