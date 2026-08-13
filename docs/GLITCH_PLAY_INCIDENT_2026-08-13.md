# Glitch public play incident — Regolith

## Incident summary

As of August 13, 2026 at 01:58 UTC, Regolith's public Glitch play page cannot launch the game even though the active Node build and its Azure Container App are healthy.

The failure is a Glitch platform metadata/routing inconsistency:

- the title record advertises `deployment_type: "wasm"`;
- the active, ready build advertises `deployment_type: "node"` and has a working `cdn_url`;
- the public play flow follows the title-level WASM classification and starts an Aegis GPU/OS streaming session;
- it never embeds or navigates to the healthy Node build URL.

This report contains no title token, distribution token, session credential, private header, or player identifier.

## Impact

- Public players cannot start Regolith from the Glitch play page.
- The launch screen remains in the Aegis allocation/boot sequence and can eventually report that the server took too long to start.
- The game's direct production URL works normally, so the outage is isolated to Glitch's title-to-build launch routing.
- Install validation, behavior analytics, and the Node application remain operational when the direct production URL is used.

Suggested severity: **High — production launch blocked for all public Glitch play-page users**.

## Affected resources

| Resource | Value |
| --- | --- |
| Glitch title | Regolith |
| Title ID | `6bd2c447-1770-441b-b94b-bceed5e81e87` |
| Public play page | `https://www.glitch.fun/games/6bd2c447-1770-441b-b94b-bceed5e81e87/play` |
| Active build | `019ff8d1-faa2-7180-99a8-16da93dc915c` |
| Active version | `1.1.2` |
| Active build type | `node` |
| Active build status | `ready` |
| Active build URL | `https://regolith-node.graywater-acc59434.eastus.azurecontainerapps.io` |
| Azure Container App | `regolith-node` |
| Azure resource group | `openai-resource-group` |
| Active Azure revision | `regolith-node--0000001` |
| Active image | `glitchgames.azurecr.io/regolith-node:1786585979` |

## Current inconsistent state

The server-rendered `window.__ROUTE_DATA__` on the public play page reports this state:

| Field | Title record | Active build |
| --- | --- | --- |
| ID | `6bd2c447-1770-441b-b94b-bceed5e81e87` | `019ff8d1-faa2-7180-99a8-16da93dc915c` |
| Deployment type | `wasm` | `node` |
| Status | `is_live: false`, `approval_status: 0` | `status: ready`, `is_active: true` |
| Version | n/a | `1.1.2` |
| CDN URL | n/a | `https://regolith-node.graywater-acc59434.eastus.azurecontainerapps.io` |
| Build error | n/a | `null` |

The same route data also reports `requires_distribution_fee: true` and `has_distribution_fee_access: false`. Those flags and `is_live: false` should be reviewed against Glitch's publishing rules, but they do not explain why the client explicitly enters the Aegis path. The direct evidence for that branch is the stale title-level `deployment_type: "wasm"` while the active build is `node`.

## Reproduction

Reproduced after version 1.1.2 was active:

1. Open the public play page.
2. Wait for Clip Studio and the **Play Full Game** button.
3. Select **Play Full Game**.
4. Observe the launch overlay.

Actual result:

```text
CONNECTING...ALLOCATING GPU...
Starting a secure play session. Aegis is spinning up a dedicated instance.
Game loading: 8%
Initializing Aegis Session...
```

On an earlier attempt, the progress advanced through GPU allocation and OS boot, then stopped. The final player-facing failure was:

```text
UNABLE TO START GAME
Server took too long to start. Please try again.
The developer needs to publish an active build before this game can be launched.
```

During the failing launch:

- there was no iframe whose source was the Regolith Node URL;
- the only iframes were hidden Stripe support frames;
- no Regolith canvas was created;
- the browser console showed no application error explaining the failure;
- the Glitch API accepted the play request with HTTP 200.

Expected result:

- the play flow should recognize the active build as `node`;
- it should embed or navigate to the active build's `cdn_url`;
- Regolith should reach its menu after online install validation.

## Evidence that the game deployment is healthy

### Direct application checks

The production origin returned HTTP 200 for the root document, runtime configuration, game entry module, and vendored Three.js assets. The generated runtime configuration was:

```json
{
  "glitch": {
    "enabled": true,
    "titleId": "6bd2c447-1770-441b-b94b-bceed5e81e87",
    "environment": "production",
    "apiOrigin": "",
    "cloudSavesEnabled": true,
    "analyticsEnabled": true,
    "gameVersion": "1.1.2",
    "buildType": "production"
  }
}
```

A browser opened the direct origin, completed install validation, removed the boot overlay, and displayed the normal main menu. It did not show an analytics consent prompt or analytics setting.

### Azure Container App health

Azure reported:

```text
provisioningState: Succeeded
runningStatus: Running
active revision: regolith-node--0000001
revision health: Healthy
replicas: 2
traffic: 100%
```

Both replicas pulled the production image and started. Application console output reported:

```text
REGOLITH — The Silence at Anaxagoras
running at  http://localhost:3000
online services  enabled
```

Each replica had one transient startup-probe warning approximately one second before the process logged that it was listening. Azure then completed the rolling transition, marked the revision healthy, and routed 100% of traffic to it. There was no crash loop, termination, failed image pull, application exception, or sustained probe failure.

### Glitch API behavior

The production play request issued during the August 13 reproduction was accepted:

```text
2026-08-13T01:57:57Z  POST /api/titles/6bd2c447-1770-441b-b94b-bceed5e81e87/play  200  3.09s
```

The automatic behavior event emitted by the direct Node application was also accepted:

```text
2026-08-13T01:55:38Z  POST /api/titles/6bd2c447-1770-441b-b94b-bceed5e81e87/events  201  1.517s
```

These results show that Glitch's API is reachable and the application can use its configured online-service credentials. The failure occurs after the play endpoint succeeds and before the browser launches the active Node URL.

## Timeline in UTC

| Time | Event |
| --- | --- |
| 2026-08-13 01:29:26 | Version 1.1.0 Node build created; failed because the first upload did not contain the required root `Dockerfile`. |
| 2026-08-13 01:30:26 | Version 1.1.1 Node build created and later became ready. |
| 2026-08-13 01:31:13 | Azure revision `regolith-node--32yhtwj` created and became healthy. |
| 2026-08-13 01:46:29 | Public play request returned HTTP 200, but the UI remained in Aegis streaming startup. |
| 2026-08-13 01:52:18 | Version 1.1.2 Node build created. |
| 2026-08-13 01:53:39 | Azure revision `regolith-node--0000001` created. |
| 2026-08-13 01:53:57 | Regolith 1.1.2 logged that it was listening with online services enabled. |
| 2026-08-13 01:54:04 | Azure completed the rolling transition. |
| 2026-08-13 01:55:38 | Automatic behavior event returned HTTP 201. |
| 2026-08-13 01:57:57 | Failure reproduced again after 1.1.2 activation; `/play` returned HTTP 200 and the UI launched Aegis instead of the Node build. |

## Root-cause assessment

### Most likely root cause

Glitch's title record retained `deployment_type: "wasm"` after a ready Node build was activated. The play-page client or the `/play` session-selection code appears to branch on the title-level field rather than the active build's field. It therefore creates an Aegis streaming session appropriate for a WASM/native-streamed title instead of using the active Node build's `cdn_url`.

Confidence: **high**.

Supporting facts:

1. The title/build deployment-type mismatch is present in the page's own route data.
2. The visible flow explicitly says it is allocating a GPU, booting an OS, and initializing Aegis.
3. No game iframe or navigation to the Node CDN occurs.
4. The active build is ready, active, and has a valid CDN URL.
5. The CDN URL serves the complete game successfully.
6. The `/play` API call returns HTTP 200 instead of reporting an application deployment failure.

### Ruled-out or unlikely causes

- **Regolith process crash:** ruled out by healthy replicas, successful direct requests, and the working menu.
- **Missing active build:** ruled out by `is_active: true`, `status: ready`, and the active CDN URL in route data.
- **Bad container port:** ruled out by successful direct HTTPS requests through Azure ingress and the process listening on port 3000.
- **Broken game assets:** ruled out by HTTP 200 asset responses and successful direct browser startup.
- **Invalid runtime title token:** ruled out by successful install validation and HTTP 201 behavior events through the server-side proxy.
- **Analytics changes:** unrelated; the same Aegis misrouting occurred with version 1.1.1 and after version 1.1.2 became active.

## Required Glitch-side remediation

### Immediate data repair

For title `6bd2c447-1770-441b-b94b-bceed5e81e87`, set the title's effective deployment type to `node`, consistent with active build `019ff8d1-faa2-7180-99a8-16da93dc915c`. Then invalidate any title/play-page cache and server-rendered route-data cache.

Also review whether `is_live`, `approval_status`, `requires_distribution_fee`, and `has_distribution_fee_access` block publication under current business rules. If those values are intended to prevent launch, the UI and `/play` API should return that explicit policy error instead of starting Aegis and eventually claiming that no active build exists.

### Durable application fix

Glitch should make the active build authoritative for runtime selection:

1. Resolve the active build inside the play endpoint or launch service.
2. Read `deployment_type` and `cdn_url` from that active build.
3. For `node`, return the Node/web launch configuration and never allocate Aegis.
4. For a streaming build type, create the Aegis session only when the active build itself requires it.
5. If title and active-build deployment types disagree, fail closed with a specific internal configuration error and emit an alert.

If the product requires a denormalized title-level deployment type, update it transactionally whenever an active build is confirmed or activated:

```text
begin transaction
  lock title
  deactivate prior active build
  activate selected ready build
  set title.deployment_type = selected_build.deployment_type
  update title.active_build_id = selected_build.id
commit
invalidate title and play-page caches
```

The activation endpoint should reject builds that are not ready and should verify the invariant immediately after commit:

```text
title.deployment_type == active_build.deployment_type
```

### Frontend safety fix

The play page should not select its launcher solely from stale server-rendered title metadata. It should use the launch type returned by the successful `/play` request, or fetch the current active build immediately before launch. For a Node launch it should create an iframe or navigate to the returned CDN URL. Aegis-specific progress text must appear only for a confirmed Aegis session.

### Observability and tests

Add structured fields to play/session logs:

- `title_id`
- `active_build_id`
- `title_deployment_type`
- `build_deployment_type`
- `selected_launcher`
- `cdn_url_present`
- `is_live`
- `approval_status`
- `distribution_access_state`

Add an alert for title/build deployment-type mismatch and a metric for `/play` requests that return HTTP 200 but never reach either a Node iframe-ready event or an Aegis stream-ready event.

Recommended regression tests:

1. Activate a ready Node build on a title previously marked WASM; verify the next play launches the Node URL.
2. Activate a streaming build on a title previously marked Node; verify Aegis is selected.
3. Simulate stale route-data cache; verify the `/play` response remains authoritative.
4. Verify a title with no active ready build returns a precise non-200 launch error.
5. Verify policy blocks such as distribution access return the policy error and do not start Aegis.
6. Verify activation updates title/build metadata atomically and cache invalidation occurs.

## Verification checklist after the fix

- [ ] Public route data reports title `deployment_type: "node"`.
- [ ] Active build remains `019ff8d1-faa2-7180-99a8-16da93dc915c`, `ready`, and active.
- [ ] Selecting **Play Full Game** does not show GPU allocation, OS boot, or Aegis messages.
- [ ] The browser embeds or navigates to `https://regolith-node.graywater-acc59434.eastus.azurecontainerapps.io`.
- [ ] The Regolith menu appears.
- [ ] Azure application access/console logs receive the play-page request.
- [ ] Install validation succeeds.
- [ ] The automatic `app_launch/session_started` event returns HTTP 201.
- [ ] Refreshing the play page preserves the corrected launch path, proving cache invalidation.

## Diagnostic commands used

The following commands are safe examples and contain no credentials:

```bash
az containerapp show \
  --resource-group openai-resource-group \
  --name regolith-node

az containerapp revision list \
  --resource-group openai-resource-group \
  --name regolith-node

az containerapp logs show \
  --resource-group openai-resource-group \
  --name regolith-node \
  --type console \
  --tail 50

az containerapp logs show \
  --resource-group openai-resource-group \
  --name regolith-node \
  --type system \
  --tail 50

curl -I https://regolith-node.graywater-acc59434.eastus.azurecontainerapps.io/
curl https://regolith-node.graywater-acc59434.eastus.azurecontainerapps.io/runtime-config.js
```

The Glitch API access-log query filtered `ContainerAppConsoleLogs_CL` to the title's `/play` and `/events` routes. Credentials and request bodies were not printed or retained.

## Ownership boundary

The game repository can ensure that a valid Node build is produced, that its direct URL works, and that credentials stay server-side. It cannot safely correct Glitch's persisted title metadata or launcher-selection logic. The immediate metadata repair and durable routing fix require the Glitch platform team or an authorized Glitch administrative control plane.
