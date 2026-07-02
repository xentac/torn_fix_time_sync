# Context

Glossary of the ubiquitous language for this project. Terms are canonical — use them
exactly as defined here in code, docs, and discussion.

## Glossary

**Server Time** — Torn's authoritative wall-clock time in milliseconds, as reported by
the `servertime` endpoint. All game countdowns and cooldowns are anchored to it.

**Local Timebase** — the monotonic clock on the player's machine used to carry Server
Time forward between Samples. Distinct from the player's wall clock, which may step.

**Sample** — one round-trip measurement against the server: send instant, receive
instant, and the Server Time reported in between. A Sample yields one Offset candidate
and one RTT.

**RTT** — the round-trip time of a Sample. A Sample's asymmetry error is bounded by its
RTT, so lower-RTT Samples are strictly more trustworthy.

**Offset** — the difference between Server Time and the Local Timebase, as estimated by
a Sample. The Filtered Offset is the Offset of the minimum-RTT Sample in the current
window.

**Clock Filter** — the discipline of keeping a window of recent Samples and trusting the
minimum-RTT one, rather than the newest or the average.

**Burst** — several Samples taken in quick succession to seed or re-seed the Clock
Filter, used at startup and after the Local Timebase may have paused (e.g. sleep).

**Slew** — correcting displayed time gradually so no observer sees it jump. Used for
small corrections.

**Step** — correcting displayed time instantaneously. Reserved for corrections too large
to Slew.

**Poll Interval** — the effective time between Samples in steady state. Adaptive: it
backs off while the Filtered Offset is stable and shrinks when dispersion rises.

**Sync Trigger** — any event that requests a sync: window focus, the periodic timer, or
page load. Triggers *request* Samples; the Poll Interval decides whether one is actually
taken.
