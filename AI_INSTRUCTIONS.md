# Regolith engineering rules

## Online services boundary

- The normal static build must continue to run with `runtime-config.js` set to `glitch.enabled: false`.
- Browser code calls only the same-origin `/api/glitch/*` proxy. It must never contain a Glitch title token, distribution/deploy token, admin JWT, server token, or webhook secret.
- Runtime credentials belong in environment variables or the ignored `backend/runtime-secrets.json` file. Never commit that file.
- `backend/glitch-proxy.js` is the only module allowed to add the Glitch bearer token or map local routes to `https://api.glitch.fun/api`.
- Keep the Glitch title ID fixed to `6bd2c447-1770-441b-b94b-bceed5e81e87` unless the project is intentionally moved to another title.

## Analytics contract

- Behavior analytics is always enabled whenever the optional Glitch backend is enabled.
- Do not add a player-facing opt-out or consent gate for Glitch behavior events unless the product requirement changes again.
- Event `step_key`, `action_key`, and metadata property names are stable, language-independent identifiers. Never use translated UI text as an identifier.
- Do not send passwords, tokens, private/player-entered text, email addresses, chat, raw exceptions, stack traces, or precise location.
- Analytics and cloud-save failures must never interrupt input, local saves, scene changes, or gameplay.

## Save contract

- `user_install_id` is the stable local identifier. `install_id` is the Glitch UUID returned by create install. Never swap them.
- Cloud save slot `0` is the autosave slot.
- Encode the raw UTF-8 JSON bytes as base64 and calculate lowercase SHA-256 over those decoded bytes.
- Preserve the last server `version` as `base_version`. When Glitch cloud saves are available, resolve ambiguous divergence and 409 conflicts automatically with `keep_server`, then download and checksum-verify the cloud payload before replacing the local copy. Do not show a cloud-versus-device choice.
- Local `localStorage` saving remains authoritative when Glitch is disabled, offline, blocked, or unavailable.

## Validation

Run before delivery:

```bash
npm test
node --check server.js
node --check backend/glitch-proxy.js
node --check src/services/backend.js
node --check src/main.js
```

Deploy only from a trusted machine with both credentials supplied through the
process environment:

```bash
npm run deploy:glitch
```

The deployment script must continue staging outside the repository and must
never include the distribution token in the ZIP.
