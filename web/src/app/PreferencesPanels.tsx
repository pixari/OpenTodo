// Settings → General panels (OpenSpec settings-navigation, settings-redesign D3).
import { useUserPrefsRow } from '../lib/localData'
import { briefingHidden, readLanguage, setBriefingShown, setUserPref } from '../lib/userPrefs'
import type { LanguagePref } from '../lib/types'
import { SHIPPED, nativeName } from '../locales'
import { Notice } from '../ui'
import { useLanguageStatus, type LanguageStatus } from './LanguageProvider'
import { Select } from '../ui'
import { SettingRow, SettingsSection } from '../ui'
import { Switch } from '../ui'
import { DISPLAY_START_VIEWS, setStartView, type StartView } from '../lib/views'
import type { View } from '../lib/types'
import { useStartView, useViews } from './useViews'
import { setVimEnabled, useVimEnabled } from './vim/prefs'
import { setShortcutHints, useShortcutHints } from './shortcuts/hints'
import { type RowClick, setRowClick, useRowClick } from './rowClick'
import { Kbd } from './shortcuts/Kbd'
import { resolveLanguage, t } from '../lib/i18n'
import { act } from './actionError'
import { cardCopy, noticeCopy, rowCopy, SETTINGS_COPY } from '../lib/settingsCopy'

// Settings → General → Focus (focus-mode) lives beside its screen; listed here with the other General cards.
export { FocusSection } from './focus/FocusSettings'

/** Settings → General → Language (OpenSpec app-localization, design D9): synced, applied without a reload. */
export function LanguageSection() {
  const row = useUserPrefsRow()
  const status = useLanguageStatus()
  return <LanguageView value={readLanguage(row)} system={nativeName(resolveLanguage('system'))} status={status}
    onChange={(v) => act(setUserPref('language', v))} />
}

/** Presentational part of the Language panel, rendered without effects for tests and stories. */
export function LanguageView({ value, system, status = 'ready', onChange }: {
  value: LanguagePref
  /** The language `System` resolves to, in its own name. */
  system: string
  status?: LanguageStatus
  onChange: (v: LanguagePref) => void
}) {
  return (
    <SettingsSection {...cardCopy('language')}>
      <SettingRow {...rowCopy('language', 'interface')} htmlFor="language-select" control={
        <Select id="language-select" className="sm:w-56" value={value} onChange={(e) => onChange(e.target.value as LanguagePref)}>
          <option value="system">{t('System ({language})', { language: system })}</option>
          {SHIPPED.map((l) => <option key={l.code} value={l.code} lang={l.code}>{l.name}</option>)}
        </Select>
      } />
      {status === 'loading' && <p className="pt-2 text-meta text-muted" role="status" data-language-status="loading">{t('Loading the language…')}</p>}
      {status === 'failed' && (
        <div className="pt-2" data-language-status="failed">
          <Notice tone="danger">{noticeCopy('language', 'failed')}</Notice>
        </div>
      )}
    </SettingsSection>
  )
}

export function StartViewSection() {
  const views = useViews()
  const startView = useStartView()
  return <StartViewView views={views} startView={startView} onChange={(v) => act(setStartView(v))} />
}

/** Presentational part of the start view setting, rendered without effects for tests and stories. */
export function StartViewView({ views, startView, onChange }: { views: View[]; startView: StartView; onChange: (v: StartView) => void }) {
  const startIsKnown = !startView.startsWith('view:') || views.some((v) => `view:${v.id}` === startView)
  // A display pinned from the display itself (a project, a saved view, other options) is listed while it is the start view.
  const pinnedDisplay = startView.startsWith('display:') && !DISPLAY_START_VIEWS.some((d) => d.value === startView) ? startView : null
  return (
    <SettingsSection {...cardCopy('start-view')}>
      <SettingRow {...rowCopy('start-view', 'open')} htmlFor="start-view-select" control={
        <Select id="start-view-select" className="sm:w-56" aria-label={t('Start view on this device')} value={startIsKnown ? startView : 'inbox'}
          onChange={(e) => onChange(e.target.value as StartView)}>
          <optgroup label={t('Built-in')}>
            <option value="inbox">{t('Inbox')}</option>
            <option value="today">{t('Today')}</option>
            <option value="upcoming">{t('Upcoming')}</option>
            <option value="completed">{t('Completed')}</option>
            <option value="filter">{t('New view')}</option>
            <option value="loop">{t('Loop home')}</option>
            <option value="next">{t('Next', { context: 'method' })}</option>
            <option value="waiting">{t('Waiting', { context: 'method' })}</option>
          </optgroup>
          {views.length > 0 && (
            <optgroup label={t('Saved views')}>
              {views.map((v) => <option key={v.id} value={`view:${v.id}`}>{v.name}</option>)}
            </optgroup>
          )}
          {/* Display mode (display-mode D6): opens full screen in large type. */}
          <optgroup label={t('Display mode')}>
            {DISPLAY_START_VIEWS.map((d) => <option key={d.value} value={d.value}>{t(d.label)}</option>)}
            {pinnedDisplay && <option value={pinnedDisplay}>{t('Display pinned on this device')}</option>}
          </optgroup>
        </Select>
      } />
    </SettingsSection>
  )
}

/** Settings → General → Briefing (precision-polish-2): the synced user_prefs.briefing, as in the day pages' menu. */
export function BriefingSection() {
  const row = useUserPrefsRow()
  return <BriefingView shown={!briefingHidden(row)} onChange={(on) => act(setBriefingShown(on))} />
}

export function BriefingView({ shown, onChange }: { shown: boolean; onChange: (on: boolean) => void }) {
  return (
    <SettingsSection {...cardCopy('briefing')}>
      <SettingRow {...rowCopy('briefing', 'show')} id="briefing-show" htmlFor="briefing-show-switch"
        control={<span data-briefing-switch><Switch id="briefing-show-switch" checked={shown} onChange={onChange} label={t('Show the briefing')} hideLabel /></span>} />
    </SettingsSection>
  )
}

/** Keyboard switches: Vim keybindings (vim-keybindings) and "Show shortcut hints" (keyboard-shortcuts), both per device, applied at once. */
export function KeyboardSection() {
  const vim = useVimEnabled()
  const hints = useShortcutHints()
  const click = useRowClick()
  return <KeyboardView vim={vim} onVim={setVimEnabled} hints={hints} onHints={setShortcutHints} click={click} onClick={setRowClick} />
}

export function KeyboardView({ vim, onVim, hints = false, onHints = () => {}, click = 'edit', onClick = () => {} }: {
  vim: boolean; onVim: (on: boolean) => void; hints?: boolean; onHints?: (on: boolean) => void
  /** "Click a task to" (inline-task-editing D6), this device only. */
  click?: RowClick; onClick?: (v: RowClick) => void
}) {
  return (
    <SettingsSection {...cardCopy('keyboard')}>
      <SettingRow {...rowCopy('keyboard', 'rowClick')} id="row-click"
        control={(
          <Select id="row-click-select" className="sm:w-56" value={click} onChange={(e) => onClick(e.target.value as RowClick)} aria-label={t('Click a task to')} data-row-click>
            <option value="edit">{t('Edit in place')}</option>
            <option value="open">{t('Open details')}</option>
          </Select>
        )} />
      <SettingRow {...rowCopy('keyboard', 'hints')} id="shortcut-hints"
        control={<span data-hints-switch><Switch checked={hints} onChange={onHints} label={t('Show shortcut hints (this device)')} hideLabel /></span>} />
      <SettingRow label={rowCopy('keyboard', 'vim').label} description={
        <>{t.rich(SETTINGS_COPY.keyboard.rows.vim.description, { kbd: <Kbd k="gg" />, kbd2: <Kbd k="dd" />, kbd3: <Kbd k=":" /> })}</>
      } control={<span data-vim-switch><Switch checked={vim} onChange={onVim} label={t('Vim keybindings (this device)')} hideLabel /></span>} />
    </SettingsSection>
  )
}
