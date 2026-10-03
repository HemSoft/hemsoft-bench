package hemsoftbench

import (
	_ "embed"
	"encoding/json"
)

//go:embed package.json
var packageMetadata []byte

// Version is embedded at build time from the project's single version source.
var Version = func() string {
	var metadata struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(packageMetadata, &metadata); err != nil || metadata.Version == "" {
		panic("package.json must contain a valid application version")
	}
	return metadata.Version
}()
