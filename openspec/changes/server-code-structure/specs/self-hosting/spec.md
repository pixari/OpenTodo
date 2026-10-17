## ADDED Requirements

### Requirement: Server code stays navigable
The test suite SHALL fail when a function in a non-test Go file under `internal/` is longer than 150 lines, counted from its `func` line to its closing brace, or when such a file is longer than 1,100 lines. An exception SHALL be listed in the check's allow-list with the reason it stays longer, and an entry that is no longer over the limit SHALL fail the check, so the list only shrinks. Splitting code to meet the limits SHALL NOT change routes, access policies, API responses or the op format.

#### Scenario: A function grows past the limit
- **WHEN** a contributor makes a function in `internal/` longer than 150 lines without listing it
- **THEN** `go test ./internal/codesize/` fails and names the file, the function and its length

#### Scenario: A listed exception is fixed
- **WHEN** a function in the allow-list is split below the limit and its entry stays
- **THEN** the check fails and asks for the entry to be removed

#### Scenario: Routes registered in any order
- **WHEN** a literal route such as `GET /api/v1/invitations/{token}` and the generic `GET /api/v1/{collection}/{id}` are both registered
- **THEN** a request to `/api/v1/invitations/<token>` reaches the invitation handler whichever was registered first, and every route still appears in the route policy table
