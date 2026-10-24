// The on-device assistant's state in the panel (OpenSpec change assistant-on-device):
// this device's setup (provider, model, key), whether the device is locked, and
// the status the panel renders: for an encrypted account in device mode the
// provider, model and consent come from this device's setup.
import { useCallback, useEffect, useState } from 'react'
import { useEncryption } from '../../lib/e2ee'
import type { AssistantStatus } from '../../lib/assistantStatus'
import { clearDeviceSetup, getDeviceSetup, originOf, saveDeviceSetup, type DeviceSetup } from '../../lib/assistantDevice/settings'
import { t } from '../../lib/i18n'

/** The provider's name in the disclosure and the composer's hint. */
export function deviceProviderLabel(s: Pick<DeviceSetup, 'provider' | 'baseUrl'>): string {
  switch (s.provider) {
    case 'anthropic': return 'Anthropic (Claude)'
    case 'openai': return 'OpenAI'
    case 'gemini': return 'Google Gemini'
  }
  return t('the model server at {origin}', { origin: originOf(s.baseUrl ?? '') ?? '' })
}

/** The status with this device's provider and consent (device mode only). */
export function withDevice(status: AssistantStatus | null, setup: DeviceSetup | null): AssistantStatus | null {
  if (!status || status.mode !== 'device') return status
  return {
    ...status, available: true, enabled: true,
    provider: setup?.provider ?? '', provider_label: setup ? deviceProviderLabel(setup) : '', model: setup?.model ?? '',
    consented: !!setup && status.device?.consented_provider === setup.provider,
  }
}

export interface DeviceMode {
  active: boolean
  loaded: boolean
  setup: DeviceSetup | null
  locked: boolean
  /** The setup form is open over an existing setup. */
  editing: boolean
  save: (s: DeviceSetup) => Promise<void>
  clear: () => Promise<void>
  edit: (on: boolean) => void
}

export function useDeviceAssistant(status: AssistantStatus | null): DeviceMode {
  const active = status?.mode === 'device'
  const enc = useEncryption()
  const [setup, setSetup] = useState<DeviceSetup | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [editing, edit] = useState(false)
  useEffect(() => {
    if (!active) return
    let live = true
    void getDeviceSetup().then((s) => { if (live) { setSetup(s); setLoaded(true) } })
    return () => { live = false }
  }, [active])
  const save = useCallback(async (s: DeviceSetup) => {
    await saveDeviceSetup(s)
    setSetup(s)
    edit(false)
  }, [])
  const clear = useCallback(async () => {
    await clearDeviceSetup()
    setSetup(null)
    edit(false)
  }, [])
  return { active, loaded, setup, locked: active && !enc.unlocked, editing, save, clear, edit }
}
