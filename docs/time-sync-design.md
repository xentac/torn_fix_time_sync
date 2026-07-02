# NTP-style time sync patch for Torn's `base.js`

Design record from the grilling session (2026-07-02). Each decision below was a fork in
the design tree; the chosen answer is stated with its rationale. Vocabulary is defined in
[../CONTEXT.md](../CONTEXT.md). Decisions marked **(assumed)** were taken on the
recommended answer without user confirmation and are the first things to revisit.

## What `base.js` does today

`ServerTimeService` (`base.js:27-86`) holds `timeNow` (ms), ticks it +1000ms/s via a web
worker, and every 120s — plus on window focus and once 20s after load — snaps
`timeNow = data.time + RTT/2` from a single request to
`/sidebarAjaxAction.php?action=servertime&t=<start>`. Reads funnel through
`serverTimeService.timeNow` (`getCurrentTimestamp()` at `base.js:88`); all Sync Triggers
call `self.syncTimeWithServer()` late-bound on the instance.

Defects: single-Sample trust (one slow response skews time by its asymmetry), Stepping on
every sync (visible countdown jumps), tick-accumulation drift between syncs, fixed 120s
polling forever, and `data && data.time + latency` (`base.js:67`) can set `timeNow = NaN`
on a malformed-but-truthy response.

## Decisions

### D1. Delivery: userscript for Tampermonkey **and Torn PDA** (confirmed)
Single `.user.js` that works in both hosts. Tampermonkey: `@run-at document-idle`,
`@grant none`, page context. Torn PDA's engine ignores most metadata, guarantees no
injection order relative to base.js, and has no `GM_*` APIs — so the script must be
self-contained (plain `fetch`, no GM calls) and must not assume `serverTimeService`
exists yet: it polls for `window.serverTimeService` (~250ms interval, ~30s give-up)
before patching. PDA's webview is suspended aggressively on mobile, making the
Timebase Anomaly recovery (D11) load-bearing there.

### D2. Patch surface: two instance-level interceptions
1. `serverTimeService.syncTimeWithServer = ourSampler` — every existing Sync Trigger
   resolves the method at call time, so this reroutes all of them. The anonymous 120s
   interval never needs cancelling.
2. `Object.defineProperty(serverTimeService, 'timeNow', { get, set: ignore })` — getter
   returns `LocalTimebase + FilteredOffset (+ skew term)`. The worker's `+= 1000` tick
   becomes a no-op; time becomes continuous instead of stepped.

Writes to `timeNow` are ignored by design; honoring them would let the worker tick
re-introduce drift. Confirmed acceptable: the user runs no other scripts that write to
`timeNow`, so no compatibility escape hatch is built. Guard clause: if
`window.serverTimeService` never appears (Torn shipped a new base.js), give up quietly
and leave native behavior untouched.

### D3. Local Timebase: `performance.now()`
`Date.now()` steps when the OS adjusts the wall clock, corrupting a stored Offset.
`performance.now()` is monotonic but may pause across system sleep — recovery from that
is handled by Timebase Anomaly detection (D11), which supersedes the earlier
"invalidate after 60s hidden" rule: a shift in the `Date.now() − performance.now()`
delta is a direct, reliable signal that the timebase broke, whereas hidden-duration was
only a proxy for it.

### D4. Sampling: same endpoint, four-timestamp math, Clock Filter
No server changes are possible. Per Sample: `t0` (perf at send), `t3` (perf at receive),
`T` (server ms); `rtt = t3 − t0`; Offset candidate `= T + rtt/2` anchored at `t3`. Keep
the last 8 Samples; the Filtered Offset comes from the minimum-RTT Sample. Startup Burst:
4 Samples ~1.5s apart. Validate `Number.isFinite(data.time)`. Preserve existing guards:
`getAction` exists, `isLoggedIn` cookie is `1`, tab visible.

### D5. Correction: Slew ≤750ms, Step above
Corrections up to 750ms are amortized over ~30s (invisible at 1-second countdown
resolution). Larger ones (first sync, wake-from-sleep) Step immediately.

### D6. Poll Interval: adaptive 2min → 20min backoff
Our sampler internally rate-limits regardless of how often Sync Triggers fire. Interval
doubles each time a fresh Sample agrees with the Filtered Offset within ~50ms, capped at
20 min; resets toward 2 min when dispersion rises. Steady state ≈3–4 requests/hour vs
today's 30.

Refinement found in simulation: a disagreeing Sample only resets backoff when its RTT is
credible (≤2× the window's best). A high-RTT Sample that disagrees is most likely wrong
by its own asymmetry — the Clock Filter discards it, so poll policy must too, or noisy
links never earn backoff.

### D7. Skew compensation: linear estimate, applied only when trustworthy
Regress Offset against Local Timebase across the window to estimate local clock skew
(ppm); add the term in the getter. This is what makes the 20-min poll cap safe (~20ppm
quartz skew ≈ 24ms per 20 min, mostly cancelled). Skip the term with <3 Samples or a
poor fit.

### D8. Transport: plain `fetch`, not Torn's `getAction`
`fetch` against the same endpoint with same-origin credentials gives precise `t0`/`t3`
capture around the request and removes a dependency that may not exist yet when PDA
injects the script. The native guards are preserved: `isLoggedIn` cookie is `1` and the
tab is visible. 10s abort timeout, mirroring the native ajax wrapper.

### D9. Tuning: ship NTP-informed defaults plus a debug handle
Constants ship as designed (750ms step/slew, 50ms agreement, 2→20min backoff, 8-Sample
window) rather than running a measurement phase first. `window.__timeSync` exposes live
state (Filtered Offset, RTT, Poll Interval, sample window) and a console-logging toggle
so the constants can be tuned from real data later.

### D10. Cross-tab sharing: one Wall-Anchored Sample window in localStorage
People who care about clock sync run multiple tabs; without sharing, every tab Bursts on
open and every visible window polls independently. Tabs therefore share one Sample
window under a versioned localStorage key.

- **Wall Anchoring** — a perf-anchored Offset is meaningless in another tab because each
  tab has its own `performance.timeOrigin`. Samples are stored as
  `{wallOffset: serverTime − Date.now(), rtt, atWall}` and converted back into the
  reading tab's perf-anchored form at recompute time. Accepted trade-off: this makes
  shared Samples sensitive to wall-clock steps, which D11 exists to catch.
- **No leader election** — hidden tabs already never sample, so coordination reduces to:
  read-merge the shared window before deciding a Sample is due (a fresh Sample from any
  tab satisfies every tab), plus a short Attempt Guard (~5s claim with tab id) so two
  visible windows don't double-sample in a tight race. A rare duplicate request is
  accepted over lock machinery.
- **Merging** is deterministic (dedupe by `atWall`+`rtt`, drop >2h old or future-dated,
  keep newest 8), so all tabs converge to the identical Filtered Offset. Slew stays
  per-tab: each tab slews from its own displayed value, so adopting a shared target
  never causes a visible jump anywhere.
- **Storage events are a nicety, not a dependency** — Torn PDA's multi-tab webviews
  share localStorage but event delivery between them is unreliable, so every Sync
  Trigger re-reads the shared window regardless.
- **Any storage failure (quota, privacy mode, corrupt JSON) degrades silently to
  per-tab operation** — v1.0.0 behavior.

### D11. Timebase Anomaly recovery (replaces hidden-invalidate; hardened for D10)
A shift >1s in the `Date.now() − performance.now()` delta means the timebase broke
(system sleep paused perf, or the wall clock stepped). The naive response — clear
everything and Burst — is wrong multi-tab: a tab waking from sleep would destroy the
shared window another tab already rebuilt. Instead, an anomalous tab discards its local
state, **adopts shared Samples newer than 5 minutes** (probably written post-discontinuity
by a tab that already recovered), and takes **one verification Sample**; only if no fresh
shared Samples exist does it clear the shared window and Burst.

The verification Sample is backed by a general self-heal rule: if a credible (low-RTT)
Sample disagrees with the Filtered Offset by more than 2× the step threshold, the window
is presumed poisoned (e.g. Samples written just before a wall step) and is rebuilt from
scratch. This bounds the damage of D10's wall-step sensitivity to roughly one extra
round-trip.
