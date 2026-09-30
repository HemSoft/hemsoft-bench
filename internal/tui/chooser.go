package tui

import "github.com/HemSoft/hemsoft-bench/internal/bench"

func modelKey(model bench.Model) string {
	return model.Provider + "/" + model.Model + "@" + model.Thinking
}

// Reuse existing saved model settings without exposing storage terminology or
// suites. Every visible choice contains exactly one provider/model/thinking set.
func (m Model) modelSetups() []bench.Template {
	out := []bench.Template{}
	indexes := map[string]int{}
	for _, t := range m.state.Templates {
		if len(t.Models) != 1 {
			continue
		}
		key := modelKey(t.Models[0])
		t.Concurrency = 1
		if i, ok := indexes[key]; ok {
			out[i] = t
		} else {
			indexes[key] = len(out)
			out = append(out, t)
		}
	}
	for _, t := range m.state.Templates {
		for _, model := range t.Models {
			key := modelKey(model)
			if _, ok := indexes[key]; ok {
				continue
			}
			one := t
			one.Models = []bench.Model{model}
			one.Concurrency = 1
			indexes[key] = len(out)
			out = append(out, one)
		}
	}
	return out
}
