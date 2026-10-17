## ADDED Requirements

### Requirement: One strict parser for template YAML
The template conformance check SHALL read every YAML template with one shared strict parser, and each platform's checker SHALL name the profile of the subset its files may use. Every profile SHALL refuse YAML outside the subset (anchors, aliases, tags, flow maps, duplicate keys, inconsistent indentation) with the line number.

#### Scenario: Unsupported YAML in a template
- **WHEN** a contributor adds an anchor (`&x`) or a flow map to any platform's YAML template
- **THEN** `make check` fails with "not in the supported YAML subset" and the line number

#### Scenario: A construct the platform's profile does not allow
- **WHEN** a Coolify-style compose file gains a `|` block scalar or a `- key: value` item, or the Umbrel manifest gains a `|` block scalar
- **THEN** `make check` fails and names what the file may use

#### Scenario: Same reading in every check
- **WHEN** two checkers read `'it''s'`, `"a\"b"` or a folded `>` text with a blank line
- **THEN** both read `it's`, `a"b` and a text with one newline for the blank line

#### Scenario: A checker with its own parser
- **WHEN** a platform checker defines its own YAML parsing function
- **THEN** the deploy tests fail and point to the shared parser
