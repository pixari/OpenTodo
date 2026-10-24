## MODIFIED Requirements

### Requirement: Account and General section contents
Account SHALL hold profile, sessions, password, two-factor, passkeys, linked accounts and encryption; General SHALL hold start view, the briefing (one synced "Show the briefing" switch, the same preference as the day pages' Hide briefing, screen id `settings/briefing`), date and time, calendar, keyboard, language and Focus (the timer mode and lengths, auto-start, the break reminder and the sound of OpenSpec change `focus-mode`, screen id `settings/focus`).

#### Scenario: Where a setting lives
- **WHEN** the user looks for passkeys and for the date and time format
- **THEN** passkeys are found in the Account section and date and time in the General section

#### Scenario: Focus settings
- **WHEN** the user looks for the Pomodoro work length or the break reminder
- **THEN** both are found in the Focus card of the General section, and its Help link opens the focus guide

#### Scenario: Briefing switch
- **WHEN** the user searches settings for "briefing"
- **THEN** "Show the briefing" is listed under General, and its card says the choice applies on all the user's devices
