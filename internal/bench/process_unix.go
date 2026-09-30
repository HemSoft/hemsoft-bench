//go:build !windows

package bench

import (
	"os/exec"
	"syscall"
)

func ConfigureDaemon(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
func ConfigureChild(cmd *exec.Cmd)  {}
func ProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	e := syscall.Kill(pid, 0)
	return e == nil || e == syscall.EPERM
}
