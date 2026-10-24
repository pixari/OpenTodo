package assistant

import "github.com/pixari/opentodo/internal/agenttools"

// The on-device assistant's manifest (OpenSpec change assistant-on-device, design
// D8): everything the browser's loop needs from the server's assistant, built
// from the one tool registry so the device can never offer a second toolset.
// A test keeps web/src/lib/assistantDevice/manifest.json equal to it.

// ManifestVersion is bumped when the manifest's shape changes.
const ManifestVersion = 1

// DeviceNote is added to the system text of an on-device turn: which tool
// arguments the device does not offer (design D8).
const DeviceNote = "This assistant runs on the user's device and reads the tasks stored there. On this device you cannot set custom field values, repeat rules, locations or origins, reply to comments, or page through results; when asked, say that this is not possible here."

// deviceTool names a registry tool the device offers and the arguments it
// keeps: top-level ones, and for item lists the list's name and its items' ones.
type deviceTool struct {
	name     string
	keep     []string
	itemList string
	itemKeep []string
}

// deviceTools is the device subset in the registry's order (design D8).
var deviceTools = []deviceTool{
	{name: "list_projects", keep: []string{"include_archived"}},
	{name: "list_tasks", keep: []string{"view", "project_id", "label", "priority", "due_from", "due_to", "include_completed", "blocked", "limit", "timezone"}},
	{name: "get_task", keep: []string{"id", "timezone"}},
	{name: "search_tasks", keep: []string{"query", "include_completed", "limit", "timezone"}},
	{name: "today_summary", keep: []string{"timezone"}},
	{name: "create_tasks", keep: []string{"items"}, itemList: "items", itemKeep: []string{"id", "title", "description", "project_id", "section_id", "parent_id", "priority", "due", "labels", "estimate_minutes", "deadline", "start", "evening", "blocked_by"}},
	{name: "update_tasks", keep: []string{"updates"}, itemList: "updates", itemKeep: []string{"id", "title", "description", "priority", "labels", "estimate_minutes", "deadline", "start", "evening", "blocked_by"}},
	{name: "complete_tasks", keep: []string{"ids", "timezone"}},
	{name: "reopen_tasks", keep: []string{"ids"}},
	{name: "move_tasks", keep: []string{"ids", "project_id", "section_id"}},
	{name: "schedule_tasks", keep: []string{"ids", "due"}},
	{name: "create_project", keep: []string{"name", "color", "parent_id"}},
	{name: "create_label", keep: []string{"name", "color"}},
	{name: "add_comment", keep: []string{"task_id", "body"}},
	{name: "trash_tasks", keep: []string{"ids"}},
}

// ManifestTool is one tool as the device offers it.
type ManifestTool struct {
	Name        string         `json:"name"`
	Kind        string         `json:"kind"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"input_schema"`
	// Strict is the schema for Anthropic's strict tools, StrictNullable the
	// one for Gemini (no type lists): both from strictSchema.
	Strict         map[string]any `json:"strict_schema"`
	StrictNullable map[string]any `json:"strict_nullable_schema"`
}

// ManifestSkill is a built-in skill with what the device needs to run it.
type ManifestSkill struct {
	agenttools.Skill
	Instructions string   `json:"instructions"`
	Tools        []string `json:"tools"`
}

// Manifest is the generated file.
type Manifest struct {
	Version        int               `json:"version"`
	Rules          string            `json:"rules"`
	DeviceNote     string            `json:"device_note"`
	Notice         string            `json:"notice"`
	UntrustedNote  string            `json:"untrusted_note"`
	Views          map[string]string `json:"views"`
	Messages       map[string]string `json:"messages"`
	Limits         map[string]int    `json:"limits"`
	AnthropicModel string            `json:"default_anthropic_model"`
	AnthropicList  []string          `json:"anthropic_models"`
	Endpoints      map[string]string `json:"endpoints"`
	Tools          []ManifestTool    `json:"tools"`
	Skills         []ManifestSkill   `json:"skills"`
}

// DeviceManifest builds the manifest from the registry's definitions for an
// in-app caller (the device works on decrypted rows, so schemas are plain).
func DeviceManifest(reg *agenttools.Registry) Manifest {
	defs := map[string]agenttools.Definition{}
	for _, d := range reg.Definitions(Caller("device")) {
		defs[d.Name] = d
	}
	m := Manifest{
		Version: ManifestVersion, Rules: SystemRules, DeviceNote: DeviceNote, Notice: agenttools.Notice, UntrustedNote: UntrustedNote,
		Views:          views,
		Messages:       map[string]string{"refusal": RefusalMessage, "cut_off": CutOffMessage, "round_limit": RoundLimitMessage},
		Limits:         map[string]int{"max_rounds": MaxRounds, "max_output_tokens": MaxOutputTokens, "max_entities": MaxEntities, "max_items": agenttools.MaxItems},
		AnthropicModel: DefaultAnthropicModel, AnthropicList: AnthropicModels,
		Endpoints: map[string]string{Anthropic: "https://api.anthropic.com/v1", OpenAI: OpenAIBaseURL, Gemini: GeminiBaseURL},
	}
	offered := map[string]bool{}
	for _, t := range deviceTools {
		d, ok := defs[t.name]
		if !ok {
			continue
		}
		offered[t.name] = true
		schema := prune(d.InputSchema, t.keep)
		if t.itemList != "" {
			props := schema["properties"].(map[string]any)
			list := copyMap(props[t.itemList].(map[string]any))
			list["items"] = prune(list["items"].(map[string]any), t.itemKeep)
			props[t.itemList] = list
		}
		m.Tools = append(m.Tools, ManifestTool{Name: d.Name, Kind: string(d.Kind), Description: d.Description, InputSchema: schema,
			Strict: strictSchema(schema, false), StrictNullable: strictSchema(schema, true)})
	}
	for _, sk := range agenttools.Skills {
		ms := ManifestSkill{Skill: sk, Instructions: sk.Instructions, Tools: []string{}}
		for _, name := range sk.Tools {
			if offered[name] {
				ms.Tools = append(ms.Tools, name)
			}
		}
		m.Skills = append(m.Skills, ms)
	}
	return m
}

func copyMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// prune keeps the named properties of an object schema (and their required entries).
func prune(schema map[string]any, keep []string) map[string]any {
	out := copyMap(schema)
	props, _ := schema["properties"].(map[string]any)
	np := map[string]any{}
	want := map[string]bool{}
	for _, k := range keep {
		want[k] = true
		if v, ok := props[k]; ok {
			np[k] = v
		}
	}
	out["properties"] = np
	var req []string
	switch r := schema["required"].(type) {
	case []string:
		req = r
	case []any:
		for _, v := range r {
			if s, ok := v.(string); ok {
				req = append(req, s)
			}
		}
	}
	var kept []string
	for _, r := range req {
		if want[r] {
			kept = append(kept, r)
		}
	}
	if len(kept) > 0 {
		out["required"] = kept
	} else {
		delete(out, "required")
	}
	return out
}
