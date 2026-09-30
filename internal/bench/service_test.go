package bench

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// A separate daemon process proves jobs are independent of client lifetimes.
// Its Node CLI is a fixture: it never imports Pi or invokes Docker/providers.
func TestDaemonHelper(t *testing.T) {
	if root := os.Getenv("HB_TEST_DAEMON_ROOT"); root != "" {
		if e := Serve(root); e != nil {
			os.Exit(2)
		}
		os.Exit(0)
	}
}
func TestBackgroundQueueReconnectAndCancellation(t *testing.T) {
	if _, e := exec.LookPath("node"); e != nil {
		t.Skip("Node not installed")
	}
	root := t.TempDir()
	v := template()
	v.Models = append(v.Models, v.Models[0])
	v.Concurrency = 2
	_ = AtomicJSON(filepath.Join(root, "run.json"), map[string]any{"model": v.Models[0], "tasks": v.Tasks, "repeat": 1, "wallSeconds": 60, "maxRequests": 4, "maxEstimatedUsd": 1})
	_ = os.MkdirAll(filepath.Join(root, "src"), 0700)
	fake := `const fs=require('fs'),path=require('path'),crypto=require('crypto');
const args=process.argv.slice(2),command=args[0],job=args[args.indexOf('--managed-run')+1];
const dir=path.join(process.cwd(),'.local','managed-runs',job);
if(command==='doctor'||command==='verify'){console.log('offline ready');process.exit(0)}
const selfTest=command==='self-test',task=selfTest?'authority-ledger':args[1];
const emit=v=>console.log(JSON.stringify(v));
let ticks=0;const timer=setInterval(()=>{
 emit({type:'progress',task,stage:'Model running',activity:{phase:'Reasoning stream',executionElapsedSeconds:ticks,silenceSeconds:0,toolsStarted:1,toolsCompleted:1,writesCompleted:0}});
 ticks++;const cancelled=fs.existsSync(path.join(dir,'cancel'));
 if(!cancelled&&ticks<8)return;clearInterval(timer);
 const id=crypto.randomUUID(),p=path.join(dir,'runs',id,'result.json');fs.mkdirSync(path.dirname(p),{recursive:true});
 fs.writeFileSync(p,JSON.stringify({id,task,selfTest,status:cancelled?'aborted':selfTest?'self_test_passed':'passed',grade:selfTest?null:{passed:20,total:20},elapsedSeconds:0.4}));emit({resultFile:p});if(cancelled)process.exitCode=1;
},50);
`
	if e := os.WriteFile(filepath.Join(root, "src", "cli.mjs"), []byte("import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"+fake), 0600); e != nil {
		t.Fatal(e)
	}
	exe, _ := os.Executable()
	cmd := exec.Command(exe, "-test.run=^TestDaemonHelper$")
	cmd.Env = append(os.Environ(), "HB_TEST_DAEMON_ROOT="+root)
	ConfigureDaemon(cmd)
	if e := cmd.Start(); e != nil {
		t.Fatal(e)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	var client *Client
	waitFor(t, func() bool {
		c, e := ReadClient(root)
		if e != nil {
			return false
		}
		if c.Call("GET", "/health", nil, nil) != nil {
			return false
		}
		client = c
		return true
	})
	if e := client.Call("POST", "/queue", v, nil); e != nil {
		t.Fatal(e)
	}
	sawParallel := false
	waitFor(t, func() bool {
		var s State
		if client.Call("GET", "/state", nil, &s) != nil {
			return false
		}
		active := 0
		for _, j := range s.Jobs {
			if j.Status == "running" {
				active++
			}
		}
		if active == 2 {
			sawParallel = true
		}
		return sawParallel
	})
	// Drop this client's transport, reconnect through the persisted endpoint.
	client.HTTP.CloseIdleConnections()
	client = nil
	reconnected, e := ReadClient(root)
	if e != nil {
		t.Fatal(e)
	}
	waitFor(t, func() bool {
		var s State
		if reconnected.Call("GET", "/state", nil, &s) != nil {
			return false
		}
		if len(s.Jobs) != 2 {
			return false
		}
		for _, j := range s.Jobs {
			if j.Status != "passed" || len(j.Results) != 2 {
				return false
			}
		}
		return true
	})
	v.Name = "Cancel fixture"
	v.Models = v.Models[:1]
	if e = reconnected.Call("POST", "/queue", v, nil); e != nil {
		t.Fatal(e)
	}
	var target string
	waitFor(t, func() bool {
		var s State
		_ = reconnected.Call("GET", "/state", nil, &s)
		for _, j := range s.Jobs {
			if j.Template.Name == v.Name && j.Status == "running" {
				target = j.ID
				return true
			}
		}
		return false
	})
	if e = reconnected.Call("POST", "/jobs/"+target+"/cancel", nil, nil); e != nil {
		t.Fatal(e)
	}
	waitFor(t, func() bool {
		var s State
		_ = reconnected.Call("GET", "/state", nil, &s)
		for _, j := range s.Jobs {
			if j.ID == target {
				return j.Status == "cancelled" && j.PID == 0
			}
		}
		return false
	})
}
func waitFor(t *testing.T, f func() bool) {
	t.Helper()
	end := time.Now().Add(12 * time.Second)
	for time.Now().Before(end) {
		if f() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("condition timed out")
}
