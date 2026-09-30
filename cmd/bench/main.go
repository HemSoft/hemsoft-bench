package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	tea "charm.land/bubbletea/v2"
	"github.com/HemSoft/hemsoft-bench/internal/bench"
	"github.com/HemSoft/hemsoft-bench/internal/tui"
)

func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, "bench:", e)
		os.Exit(1)
	}
}
func projectRoot(given string) (string, error) {
	if given != "" {
		p, e := filepath.Abs(given)
		if e != nil {
			return "", e
		}
		if _, e = os.Stat(filepath.Join(p, "src", "cli.mjs")); e != nil {
			return "", fmt.Errorf("not a benchmark directory: %s", p)
		}
		return p, nil
	}
	cwd, _ := os.Getwd()
	exe, _ := os.Executable()
	for _, start := range []string{cwd, filepath.Dir(exe)} {
		for p := start; ; p = filepath.Dir(p) {
			if _, e := os.Stat(filepath.Join(p, "src", "cli.mjs")); e == nil {
				return p, nil
			}
			if filepath.Dir(p) == p {
				break
			}
		}
	}
	return "", fmt.Errorf("cannot locate benchmark files; use --root PATH")
}
func run() error {
	rootFlag := flag.String("root", "", "benchmark project directory")
	serve := flag.Bool("serve", false, "run the background manager")
	status := flag.Bool("status", false, "print managed job state without opening the TUI")
	stop := flag.Bool("stop-manager", false, "stop the background manager only when no jobs are active or queued")
	flag.Parse()
	root, e := projectRoot(*rootFlag)
	if e != nil {
		return e
	}
	if *serve {
		return bench.Serve(root)
	}
	if *stop {
		c, e := bench.ReadClient(root)
		if e != nil {
			return e
		}
		return c.Call("POST", "/shutdown", nil, nil)
	}
	client, e := bench.Ensure(root)
	if e != nil {
		return e
	}
	if *status {
		var s bench.State
		if e = client.Call("GET", "/state", nil, &s); e != nil {
			return e
		}
		return json.NewEncoder(os.Stdout).Encode(s)
	}
	_, e = tea.NewProgram(tui.New(client)).Run()
	return e
}
