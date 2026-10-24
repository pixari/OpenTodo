// Settings → Server → Branding (OpenSpec change instance-branding): the owner
// names the instance and uploads a logo. Both are server state read live;
// offline the card shows the last values read-only. The logo is sent as the
// file the owner picked (PNG or JPEG, at most 2 MB); the server renders the
// favicon, touch icon, app icons and sidebar sizes from it.
import { useEffect, useState, type ChangeEvent } from 'react'
import { api, ApiError, isNetworkError } from '../lib/api'
import { type Branding, logoUrl, setBranding, useBranding } from '../lib/branding'
import { t } from '../lib/i18n'
import { useOnline } from '../lib/online'
import { cardCopy, noticeCopy, rowCopy } from '../lib/settingsCopy'
import { Button, Input, Notice, SettingRow, SettingsSection } from '../ui'
import { BrandMark } from '../ui'

export const LOGO_TYPES = ['image/png', 'image/jpeg']
export const LOGO_MAX_BYTES = 2 << 20
export const NAME_MAX = 40

/** The problem with a chosen logo file, or null. */
export function checkLogoFile(file: { type: string; size: number }): string | null {
  if (!LOGO_TYPES.includes(file.type)) return t('Choose a PNG or JPEG image.')
  if (file.size > LOGO_MAX_BYTES) return t('The logo must be at most 2 MB.')
  return null
}

export interface BrandingViewProps {
  value: Branding | null
  online: boolean
  busy: boolean
  error: string | null
  saved: boolean
  onSaveName: (name: string) => void
  onLogo: (file: File) => void
  onRemoveLogo: () => void
}

export function BrandingView({ value, online, busy, error, saved, onSaveName, onLogo, onRemoveLogo }: BrandingViewProps) {
  const [name, setName] = useState(value?.name ?? '')
  const [fileError, setFileError] = useState<string | null>(null)
  useEffect(() => setName(value?.name ?? ''), [value])
  const disabled = !online || busy || !value
  const dirty = !!value && name.trim() !== value.name
  const tooLong = [...name.trim()].length > NAME_MAX
  const logo = value ? logoUrl(192, value) : undefined
  const choose = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const problem = checkLogoFile(file)
    setFileError(problem)
    if (!problem) onLogo(file)
  }
  return (
    <SettingsSection {...cardCopy('branding')} testId="branding-panel">
      {!online && <div className="pb-3"><Notice>{noticeCopy('branding', 'offline')}</Notice></div>}
      <SettingRow {...rowCopy('branding', 'name')} htmlFor="branding-name"
        control={<form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (dirty && !tooLong) onSaveName(name.trim()) }}>
          <Input id="branding-name" className="w-56 max-w-full" value={name} placeholder="OpenTodo" maxLength={NAME_MAX + 10} disabled={disabled}
            onChange={(e) => setName(e.target.value)} autoComplete="off" />
          <Button type="submit" variant="primary" size="sm" disabled={disabled || !dirty || tooLong} busy={busy}>{t('Save')}</Button>
        </form>} />
      <SettingRow {...rowCopy('branding', 'logo')}
        status={<span className="inline-flex items-center gap-2" data-branding-preview>
          {logo ? <img src={logo} width={32} height={32} alt={t('Current logo')} className="rounded-control" /> : <BrandMark size={32} variant="colour" />}
        </span>}
        control={<>
          <label className={`ui-btn ui-btn--secondary ui-btn--sm focus-within:ring-2 focus-within:ring-focus ${disabled ? 'pointer-events-none text-faint' : 'cursor-pointer'}`} aria-disabled={disabled || undefined}>
            {logo ? t('Change logo') : t('Choose logo')}
            <input type="file" accept={LOGO_TYPES.join(',')} className="sr-only" disabled={disabled} onChange={choose} data-branding-file />
          </label>
          {logo && <Button variant="danger" size="sm" disabled={disabled} busy={busy} onClick={onRemoveLogo} data-branding-remove>{t('Remove logo')}</Button>}
        </>} />
      <div className="flex flex-wrap items-center gap-3 pt-3 text-meta">
        {tooLong && <span className="text-danger" role="alert">{t('The name is at most {max} characters.', { max: NAME_MAX })}</span>}
        {(fileError || error) && <span className="text-danger" role="alert">{fileError ?? error}</span>}
        {saved && !dirty && !fileError && !error && <span className="text-muted" role="status">{t('Saved.')}</span>}
      </div>
    </SettingsSection>
  )
}

/** Container: loads and saves the owner's branding and keeps the app's own copy current. */
export function BrandingPanel() {
  const online = useOnline()
  const live = useBranding()
  const [value, setValue] = useState<Branding | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (!online) return
    void api.brandingSettings().then(setValue, (err) => { if (!isNetworkError(err)) setError(err instanceof Error ? err.message : String(err)) })
  }, [online])
  const run = async (fn: () => Promise<Branding>) => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const next = await fn()
      setValue(next)
      setBranding(next)
      setSaved(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <BrandingView value={value ?? (online ? null : live)} online={online} busy={busy} error={error} saved={saved}
      onSaveName={(name) => void run(() => api.putBrandingName(name))}
      onLogo={(file) => void run(() => api.putBrandingLogo(file))}
      onRemoveLogo={() => void run(() => api.deleteBrandingLogo())} />
  )
}
