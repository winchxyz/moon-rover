# Regolith online services

Regolith 1.1 adds an optional same-origin Node backend for Glitch install validation, cloud saves, retention heartbeats, and behavior analytics. The static game remains fully playable without it.

## Current production deployment

- Version: `1.1.2`
- Deployment label: `1.1.2-redeploy`
- Active Glitch build: `019ff951-7bc9-73f3-a127-57779898a0ef`
- Previous Glitch build: `019ff8d1-faa2-7180-99a8-16da93dc915c` (`1.1.2`)
- Deployment type: `node`
- Build type: `production`
- Status verified on August 13, 2026 at 04:21 UTC: `ready`, active
- Azure revision: `regolith-node--0000002`, healthy, two replicas, 100% traffic
- Runtime URL: `https://regolith-node.graywater-acc59434.eastus.azurecontainerapps.io`

The post-deploy smoke test verified that runtime configuration was enabled without exposing a token, the direct runtime loaded through the main menu, install validation returned `valid: true`, and behavior events returned HTTP 201 without a consent prompt. The authenticated Glitch play page returned HTTP 200 from `/play`, embedded the Node URL in a visible Regolith iframe, reported `Online services connected`, and entered Mission 01 without showing Aegis/GPU startup or a launch error.

The previous Glitch metadata/routing incident is resolved. See [Glitch public play incident — August 13, 2026](GLITCH_PLAY_INCIDENT_2026-08-13.md) for the original evidence, platform remediation, and resolution verification. The title still reports `is_live: false`, `approval_status: 0`, and no distribution-fee access, so an anonymous/non-developer launch remains a separate publishing-policy check.

## Architecture

Disabled/static deployment:

```text
Browser ── game files ──> static host
Browser ── saves/settings ──> localStorage
```

Enabled Node deployment:

```text
Browser ── /api/glitch/* ──> Regolith Node server ── title token ──> Glitch API
Browser ── local fallback ──> localStorage
```

The browser never receives the title token. The proxy only exposes the approved install, validation, cloud-save, conflict-resolution, and single-event routes. Unknown fields and arbitrary upstream paths are rejected.

## Configuration

The committed [runtime-config.js](../runtime-config.js) disables Glitch for ordinary static hosting. When the Node server is used, it generates that response from server configuration without including credentials.

Set these environment variables on a private server, or copy `backend/runtime-secrets.example.json` to the ignored `backend/runtime-secrets.json` and fill it only in a private deployment artifact:

| variable | required | purpose |
| --- | --- | --- |
| `GLITCH_BACKEND_ENABLED=1` | yes | Enables the proxy and client integration. |
| `GLITCH_TITLE_TOKEN` | yes | Runtime install/title token. Server-only. |
| `NODE_ENV=production` | recommended | Marks the server runtime as production. |
| `GLITCH_CLOUD_SAVES_ENABLED=0|1` | no | Defaults to enabled when the backend is enabled. |
| `REGOLITH_ALLOWED_ORIGINS` | no | Comma-separated additional trusted browser origins. Same-origin requests are always allowed. |
| `REGOLITH_PUBLIC_API_ORIGIN` | no | Absolute game API origin when the frontend and Node server are intentionally hosted separately. |
| `GLITCH_REQUEST_TIMEOUT_MS` | no | Upstream timeout; defaults to 10 seconds. |
| `GLITCH_RATE_LIMIT_PER_MINUTE` | no | Per-process API limit; defaults to 180 requests per client address. |

The distribution/deploy token is never a runtime setting and must never be placed in the game ZIP.

To package, upload, confirm, wait for processing, and activate a production Node build from a trusted machine:

```bash
GLITCH_DISTRIBUTION_TOKEN='private deploy token' \
GLITCH_TITLE_TOKEN='private runtime title token' \
npm run deploy:glitch
```

The script creates its staging directory outside the repository, adds the runtime title token only to an ignored server-only file in that temporary artifact, excludes the deploy token entirely, and removes the staging directory when it finishes.

## Install and validation lifecycle

1. Read Glitch Desktop launch parameters when present: `title_id`, `game_id`, `install_id`, `user_install_id`, and `session_id`.
2. Otherwise create and persist one stable `user_install_id` and `device_id` in browser storage.
3. Create or reuse the install with `POST /titles/{title_id}/installs`.
4. Persist returned `data.id` as `install_id`.
5. Validate with `POST /titles/{title_id}/installs/{install_id}/validate` before play.
6. Recreate once when validation reports `INSTALL_NOT_FOUND`.
7. Block play with a player-readable message for license, trial, subscription, age-gate, or suspension denials.
8. If Glitch cannot be reached, a previously validated install receives a 24-hour offline grace period. A new/unvalidated install does not bypass validation.
9. Reuse the same `user_install_id` and session ID for an always-on analytics heartbeat every 30 seconds.

Cloud saves require a login-backed install with a Glitch `user_id`. Guest players continue with local saves and see a plain-language status message.

## Cloud-save lifecycle

- Slot `0` is Regolith's autosave slot.
- Local saves continue every 20 seconds and on exit.
- The cloud payload is base64 of the raw UTF-8 JSON save bytes.
- The checksum is lowercase SHA-256 of those raw decoded bytes.
- The last synchronized server version is persisted and sent as `base_version`.
- Matching checksums are deduplicated.
- A remote-only save is restored locally after its checksum is verified.
- A local-only or locally newer save uploads in the background.
- A 409 conflict opens a player choice between `keep_server` and `use_client`, then calls the documented resolve endpoint. No conflict is overwritten silently.
- A blocked, failed, or offline provider leaves the local save intact and never pauses gameplay.

## Behavior analytics contract

Events are sent automatically when all of these are true:

1. The optional backend is enabled.
2. Install validation succeeded online.

There is no consent prompt or settings toggle for Glitch behavior analytics. Every event includes `game_install_id`, stable `step_key` and `action_key`, `event_timestamp`, `session_id`, `game_version`, and `build_type`. `previous_step_key` is included when the player changes steps. The client deduplicates repeated events, queues up to 100 events in memory, retries transient failures with bounded exponential backoff, and uses a keepalive flush for page exit.

Metadata is privacy-filtered. Passwords, tokens, secrets, email, chat/private messages, dialogue, player-entered text, raw exceptions, stack traces, and precise location are not sent.

### Event taxonomy and coverage

| journey/system | step key | action keys | important metadata | result coverage |
| --- | --- | --- | --- | --- |
| App/session | `app_launch`, `session_end` | `session_started`, `ended` | session, version, build, duration | start and exit |
| Main menu | `main_menu` | `viewed` | local-save presence | viewed |
| Game entry | `gameplay` | `started` | campaign/free survey, resumed, mission, input | start/resume |
| Mission funnel | `mission_01` … `mission_05`, `operation_complete` | `mission_started`, `objective_completed`, `mission_completed`, `campaign_completed` | mission/objective IDs, duration, distance | progress and success |
| Radar | current mission or `free_survey` | `radar_scan_started`, `radar_scan_completed` | power, returns, coherent returns | start/success/empty result |
| Drilling/samples | current mission or `free_survey` | `drill_started`, `drill_aborted`, `sample_secured` | target/sample type, depth, duration, rare flag | start/success/abort |
| Relay progression | current mission or `free_survey` | `relay_deployed` | relay count, elevation | success |
| Station story beat | current mission | `station_data_recovered` | mission | success |
| Damage/recovery | current mission or `free_survey` | `damage_taken`, `chassis_righted`, `recovery_triggered` | source, amount, hull | failure/recovery |
| Codex | `codex` | `entry_unlocked` | stable entry ID, mission | reward/progression |
| Menus | `menus`, `mission_briefing` | `opened`, `closed`, `acknowledged` | panel and return state | navigation |
| Settings/accessibility | `settings_menu` | `setting_changed` | stable setting key, value/index | changes |
| Saving | `cloud_save` | `synced`, `restored`, `sync_failed`, `conflict_detected`, `conflict_resolved` | version, size, safe error category, choice | success/failure/recovery |
| Performance | `performance` | `sampled` | FPS, quality, viewport, mission, input | periodic health |
| Errors | `errors` | `runtime_error`, `boot_failed` | phase and error class only | failure |

Combat, economy, purchases, multiplayer, and standalone achievements do not exist in this game and therefore have no emitted events. Missions provide the quest/progression coverage.

## Tests

Run:

```bash
npm test
```

The Node test suite covers:

- optional/disabled behavior;
- install creation, desktop launch IDs, validation, recreation, denial, and offline grace;
- automatic analytics startup whenever Glitch is enabled;
- event context, sensitive-field removal, duplicate prevention, and provider failure;
- save encoding, decoded-byte checksum verification, upload fields, remote restore, and 409 resolution;
- exact upstream routes and bearer placement;
- server-only file blocking, path traversal, origin checks, field allowlists, and disabled feature routes.

## Known limits

- Cloud saves are unavailable to guest installs because Glitch requires a login-backed install.
- Event retries are memory-only. Closing an offline tab can discard unsent analytics, but never game progress.
- The in-process rate limiter is per Node instance; a multi-instance deployment should add a shared edge or Redis-backed limit.
- This integration implements Glitch behavior analytics only. Google Analytics and Microsoft Clarity IDs were not provided and are not installed.
- Dashboard funnel definitions are administrator actions and are not created from the shipped client.
