//go:build !windows

package bench

import "errors"

func openDefaultFile(string) error {
	return errors.New("opening files requires Windows")
}
