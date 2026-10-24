## MODIFIED Requirements

### Requirement: Security headers
Responses SHALL carry a Content-Security-Policy restricting scripts, connections and frames to the app's own origin, plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a same-origin referrer policy, and a `Permissions-Policy` that denies the camera and allows geolocation for the app's own origin only. While the owner allows the on-device assistant (OpenSpec `in-app-assistant`), `connect-src` SHALL additionally list exactly the API origins of the providers the owner allowed and the owner's model server origins, never a wildcard; otherwise it SHALL be `'self'` only. The service worker SHALL serve the app shell with the latest policy the server sent. When `OPENTODO_BASE_URL` is https, every response SHALL also carry `Strict-Transport-Security: max-age=31536000`, without `includeSubDomains` or `preload`; without an https base URL it SHALL NOT be sent.

#### Scenario: Headers present
- **WHEN** the app shell is requested
- **THEN** the response includes the Content-Security-Policy with `script-src 'self'` and `frame-ancestors 'none'`

#### Scenario: HSTS with an https base URL
- **WHEN** `OPENTODO_BASE_URL` is `https://todo.example.com` and any route is requested
- **THEN** the response has `Strict-Transport-Security: max-age=31536000`, and a server without a base URL sends no such header

#### Scenario: Geolocation for the app only
- **WHEN** the app shell is requested
- **THEN** the `Permissions-Policy` header allows `geolocation` for `self` and denies `camera`, so the browser can ask the user for their position on the app's own pages and on no embedded page

#### Scenario: On-device assistant origins
- **WHEN** the owner allows the on-device assistant with Anthropic and the model server origin `http://localhost:11434`, and the app shell is requested
- **THEN** `connect-src` is `'self' https://api.anthropic.com http://localhost:11434`, and after the owner turns the switch off it is `'self'` again

#### Scenario: Cached shell follows the server
- **WHEN** the owner turned the switch on after the service worker cached the app shell and the page is loaded twice
- **THEN** the second load carries the new policy without a new release

### Requirement: No telemetry
The server and client SHALL make no network requests to third parties and SHALL collect no usage data, with two exceptions: the map provider, and the model provider a user of an encrypted account set up for the on-device assistant while the owner allows it. The only outbound requests the server makes SHALL be to destinations the owner or a user explicitly configured (such as a backup destination or a webhook endpoint) and, while maps are on, to the map provider (OpenStreetMap-based by default, changeable or turned off by the owner, OpenSpec `task-locations`). None of them SHALL carry usage data beyond the configured payload, and map requests SHALL carry no account information. The browser SHALL never contact the map provider directly, and SHALL contact a model provider only for an on-device assistant turn or connection test the user started.

#### Scenario: Network audit
- **WHEN** the app is used for a session with the network inspected, no integration is configured and no map is shown
- **THEN** every request goes to the server's own origin

#### Scenario: Only configured destinations
- **WHEN** the owner has configured a backup destination, has turned maps off, and the server's outbound traffic is inspected
- **THEN** every outbound request goes to that destination and to nothing else

#### Scenario: Maps on by default
- **WHEN** a server with default settings shows a user a task's map and the server's outbound traffic is inspected
- **THEN** the only outbound requests besides configured destinations go to the default map tile provider, carry no cookie, token or user address, and the browser's own requests all go to the server's origin

#### Scenario: On-device assistant
- **WHEN** an encrypted user with the on-device assistant set up for Anthropic uses the app without asking the assistant anything
- **THEN** the browser sends no request to Anthropic
