// The on-device assistant's manifest (OpenSpec change assistant-on-device, design
// D8): tool definitions, fixed instructions, limits and skills generated from the
// server's one tool registry by `go test ./internal/assistant -run Device -update`
// and checked by that test, so the device never offers a second toolset.
import data from './manifest.json'

export interface ManifestTool {
  name: string
  kind: 'read' | 'write'
  description: string
  input_schema: Record<string, unknown>
  strict_schema: Record<string, unknown>
  strict_nullable_schema: Record<string, unknown>
}

export interface ManifestSkill {
  id: string
  name: string
  description: string
  example: string
  result: 'changes' | 'answer'
  subject?: 'selection' | 'pasted'
  instructions: string
  tools: string[]
}

export interface Manifest {
  version: number
  rules: string
  device_note: string
  notice: string
  untrusted_note: string
  views: Record<string, string>
  messages: { refusal: string; cut_off: string; round_limit: string }
  limits: { max_rounds: number; max_output_tokens: number; max_entities: number; max_items: number }
  default_anthropic_model: string
  anthropic_models: string[]
  endpoints: Record<'anthropic' | 'openai' | 'gemini', string>
  tools: ManifestTool[]
  skills: ManifestSkill[]
}

export const manifest = data as unknown as Manifest

export function manifestTool(name: string): ManifestTool | undefined {
  return manifest.tools.find((t) => t.name === name)
}

export function manifestSkill(id: string): ManifestSkill | undefined {
  return manifest.skills.find((s) => s.id === id)
}
