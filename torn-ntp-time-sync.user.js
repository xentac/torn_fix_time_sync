// ==UserScript==
// @name         Torn NTP-Style Time Sync
// @namespace    https://github.com/xentac/torn_fix_time_sync
// @version      1.2.0
// @author       xentac [3354782]
// @description  Replaces Torn's single-sample time sync with an NTP-style clock filter shared across tabs: smoother timers, fewer requests.
// @match        https://www.torn.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// Design record: docs/time-sync-design.md. Vocabulary: CONTEXT.md.
// Works in Tampermonkey and Torn PDA: no GM_* APIs, no assumption that
// serverTimeService exists at injection time. All tabs share one Sample window
// through localStorage (Wall-Anchored, since each tab's performance.timeOrigin
// differs); any storage failure degrades silently to per-tab operation.
//
// The script never sends a request of its own. Samples are taken by observing
// the servertime request that Torn's own syncTimeWithServer sends through
// getAction; the script only decides whether a native Sync Trigger is allowed
// to send that request (Gated Pass-Through, D12).

(() => {
  if (window.__timeSync) return; // double-injection guard (Tampermonkey + PDA)

  const CONFIG = {
    windowSize: 8, // Samples kept for the Clock Filter
    minPollMs: 120000, // Poll Interval floor (matches native cadence)
    maxPollMs: 1200000, // Poll Interval cap (20 min)
    agreementMs: 50, // Sample agreeing with prediction within this doubles the Poll Interval
    stepThresholdMs: 750, // corrections above this Step, below it Slew
    slewDurationMs: 30000,
    wallDeltaAnomalyMs: 1000, // Date.now()-performance.now() shift that signals a Timebase Anomaly
    anomalyAdoptMs: 300000, // after an anomaly, shared Samples younger than this are adopted, not discarded
    responseTimeoutMs: 10000, // getAction has no error callback; give up on a response after this
    skewMinSamples: 3,
    skewMinSpanMs: 300000, // don't trust a skew slope fit over less than 5 min
    skewClamp: 2e-4, // ±200ppm
    waitRetryMs: 250,
    waitGiveUpMs: 30000,
    storageKey: "__tornNtpTimeSync.v1",
    attemptGuardMs: 5000, // Attempt Guard: another tab's claim younger than this defers our Sample
    sampleMaxAgeMs: 7200000,
  };

  const tabId = Math.random().toString(36).slice(2) + Date.now().toString(36);

  // --- state ---------------------------------------------------------------
  let samples = []; // Wall-Anchored: {wallOffset, rtt, atWall}, ascending atWall
  let pollMs = CONFIG.minPollMs;
  let targetOffset = null; // perf-anchored offset of the min-RTT Sample (this tab only)
  let targetAnchor = 0; // perf instant that offset was measured at
  let skewSlope = 0; // ms of offset drift per ms of perf time
  let slewCorrection = null; // {startPerf, amount} — decays to zero over slewDurationMs
  let inFlight = false;
  let inFlightTimer = null;
  let verifyPending = false; // a Timebase Anomaly wants one Sample at the next native Sync Trigger
  let lastWallPerfDelta = null;
  let nativeTimeNow = 0; // native clock, honored only until the first Sample exists
  let service = null;
  let nativeSync = null;
  let storageOk = true; // flips false permanently on the first storage failure
  let logging = false;

  function log(...args) {
    if (logging) console.log("[timeSync]", ...args);
  }

  function wallPerfDelta() {
    return Date.now() - performance.now();
  }

  // --- the Shared Sample Window ---------------------------------------------
  function readShared() {
    if (!storageOk) return null;
    let raw;
    try {
      raw = localStorage.getItem(CONFIG.storageKey);
    } catch (_e) {
      storageOk = false;
      return null;
    }
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      return obj && obj.v === 1 && Array.isArray(obj.samples) ? obj : null;
    } catch (_e) {
      return null; // corrupt entry; next write replaces it
    }
  }

  function updateShared(mutate) {
    if (!storageOk) return;
    try {
      const obj = readShared() || { v: 1, samples: [] };
      mutate(obj);
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(obj));
    } catch (_e) {
      storageOk = false;
    }
  }

  function sampleKey(s) {
    return `${Math.round(s.atWall)}:${Math.round(s.rtt * 10)}`;
  }

  function isValidSample(s) {
    return (
      s &&
      Number.isFinite(s.wallOffset) &&
      Number.isFinite(s.rtt) &&
      Number.isFinite(s.atWall)
    );
  }

  // Merge the shared window into ours: dedupe, drop stale or future-dated
  // Samples, keep the newest windowSize. Deterministic, so all tabs converge
  // to the same window. Returns whether our window changed.
  function mergeFromShared(adoptPoll) {
    const sh = readShared();
    const before = samples.map(sampleKey).join(",");
    const byKey = {};
    for (const s of samples.concat(sh ? sh.samples : [])) {
      if (isValidSample(s)) byKey[sampleKey(s)] = s;
    }
    const now = Date.now();
    let merged = Object.keys(byKey)
      .map((k) => byKey[k])
      .filter(
        (s) =>
          s.atWall >= now - CONFIG.sampleMaxAgeMs && s.atWall <= now + 1000,
      )
      .sort((a, b) => a.atWall - b.atWall);
    if (merged.length > CONFIG.windowSize)
      merged = merged.slice(merged.length - CONFIG.windowSize);
    samples = merged;
    if (adoptPoll !== false && sh && Number.isFinite(sh.pollMs)) {
      pollMs = Math.min(
        Math.max(sh.pollMs, CONFIG.minPollMs),
        CONFIG.maxPollMs,
      );
    }
    return samples.map(sampleKey).join(",") !== before;
  }

  // --- the clock -----------------------------------------------------------
  function targetValue(perf) {
    return targetOffset + skewSlope * (perf - targetAnchor);
  }

  function offsetValue(perf) {
    if (targetOffset === null) return null;
    let v = targetValue(perf);
    if (slewCorrection) {
      const f = (perf - slewCorrection.startPerf) / CONFIG.slewDurationMs;
      if (f >= 1) slewCorrection = null;
      else v += slewCorrection.amount * (1 - f);
    }
    return v;
  }

  function serverNow() {
    const perf = performance.now();
    const offset = offsetValue(perf);
    if (offset === null) return nativeTimeNow; // no Sample yet: native clock, native semantics
    return Math.round(perf + offset);
  }

  // --- the Clock Filter ----------------------------------------------------
  function recomputeFromWindow() {
    if (!samples.length) return;
    // Convert the Wall-Anchored window into this tab's perf-anchored form.
    const delta = wallPerfDelta();
    const ps = samples.map((s) => ({
      offset: s.wallOffset + delta,
      rtt: s.rtt,
      atPerf: s.atWall - delta,
    }));

    let best = ps[0];
    for (let i = 1; i < ps.length; i++) {
      if (ps[i].rtt < best.rtt) best = ps[i];
    }

    let slope = 0;
    const span = ps[ps.length - 1].atPerf - ps[0].atPerf;
    if (ps.length >= CONFIG.skewMinSamples && span >= CONFIG.skewMinSpanMs) {
      const n = ps.length;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      for (const s of ps) {
        sx += s.atPerf;
        sy += s.offset;
        sxx += s.atPerf * s.atPerf;
        sxy += s.atPerf * s.offset;
      }
      slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
      slope = Math.max(-CONFIG.skewClamp, Math.min(CONFIG.skewClamp, slope));
    }

    const perf = performance.now();
    const previous = offsetValue(perf);
    targetOffset = best.offset;
    targetAnchor = best.atPerf;
    skewSlope = slope;
    lastWallPerfDelta = delta; // conversions are calibrated to this delta from here on

    const diff = previous === null ? Infinity : previous - targetValue(perf);
    if (Math.abs(diff) > CONFIG.stepThresholdMs) {
      slewCorrection = null; // Step
      log("step", diff === Infinity ? "(first sync)" : `${Math.round(diff)}ms`);
    } else if (diff !== 0) {
      slewCorrection = { startPerf: perf, amount: diff }; // Slew
      log(
        "slew",
        `${Math.round(diff)}ms over ${CONFIG.slewDurationMs / 1000}s`,
      );
    }
  }

  function addSample(perfSample) {
    if (targetOffset !== null) {
      const predicted = targetValue(perfSample.atPerf);
      const bestRtt = samples.reduce((m, s) => Math.min(m, s.rtt), Infinity);
      const disagreement = Math.abs(perfSample.offset - predicted);
      const credible = perfSample.rtt <= bestRtt * 2;
      if (credible && disagreement > 2 * CONFIG.stepThresholdMs) {
        // Self-heal: a credible Sample wildly disagreeing means the window is
        // poisoned (e.g. Samples written just before a wall-clock step).
        log(
          `credible sample disagrees by ${Math.round(disagreement)}ms; rebuilding window`,
        );
        clearWindow();
      } else if (disagreement <= CONFIG.agreementMs) {
        // Adaptive Poll Interval: agreement with the prediction earns backoff.
        pollMs = Math.min(pollMs * 2, CONFIG.maxPollMs);
      } else if (credible) {
        // Halve rather than reset: persistent disagreement reaches the
        // floor within a few Samples, but one noisy Sample doesn't
        // collapse a 20-minute backoff to 2 minutes.
        pollMs = Math.max(pollMs / 2, CONFIG.minPollMs);
      } // high-RTT disagreement: likely the sample's own asymmetry noise —
      // the Clock Filter discards it, so poll policy ignores it too
    }

    const delta = wallPerfDelta();
    samples.push({
      wallOffset: perfSample.offset - delta,
      rtt: perfSample.rtt,
      atWall: perfSample.atPerf + delta,
    });
    mergeFromShared(false); // pull other tabs' Samples; keep our poll decision
    updateShared((o) => {
      o.samples = samples;
      o.pollMs = pollMs;
    });
    recomputeFromWindow();
    log(
      `sample rtt=${Math.round(perfSample.rtt)}ms offset=${Math.round(perfSample.offset)}ms poll=${pollMs / 1000}s window=${samples.length}`,
    );
  }

  // --- sampling ------------------------------------------------------------
  function clearInFlight(attempt) {
    if (inFlight !== attempt) return; // a late response from an older attempt
    inFlight = false;
    if (inFlightTimer !== null) clearTimeout(inFlightTimer);
    inFlightTimer = null;
  }

  function onServertimeResponse(resp, t0) {
    const t3 = performance.now();
    let data = null;
    try {
      data = JSON.parse(resp);
    } catch (_e) {
      // fall through to the payload check
    }
    if (!data || !Number.isFinite(data.time)) {
      log("sample failed: bad servertime payload");
      return;
    }
    const rtt = t3 - t0;
    addSample({ offset: data.time + rtt / 2 - t3, rtt: rtt, atPerf: t3 });
  }

  // Wraps Torn's getAction for one servertime request: claims the Attempt
  // Guard, times the request, and observes the response before Torn's own
  // success handler runs (that handler's timeNow write is then ignored).
  function observingGetAction(original) {
    return function (opts, ...rest) {
      if (
        !opts ||
        typeof opts.action !== "string" ||
        opts.action.indexOf("action=servertime") === -1 ||
        typeof opts.success !== "function"
      ) {
        return original.call(this, opts, ...rest);
      }
      const attempt = {};
      inFlight = attempt;
      inFlightTimer = setTimeout(() => {
        clearInFlight(attempt);
      }, CONFIG.responseTimeoutMs);
      verifyPending = false;
      updateShared((o) => {
        o.attemptAtWall = Date.now();
        o.attemptBy = tabId;
      });
      const nativeSuccess = opts.success;
      const t0 = performance.now();
      const observed = Object.assign({}, opts, {
        success: function (resp, ...more) {
          clearInFlight(attempt);
          try {
            onServertimeResponse(resp, t0);
          } catch (e) {
            log("sample failed", e);
          }
          return nativeSuccess.call(this, resp, ...more);
        },
      });
      return original.call(this, observed, ...rest);
    };
  }

  // Gated Pass-Through: Torn's own syncTimeWithServer sends the request, with
  // window.getAction wrapped only for the duration of that synchronous call.
  // A scoped wrap cannot be overwritten by a later `function getAction`
  // declaration, and it never sees any other getAction call.
  function passThroughToNative() {
    const original = window.getAction;
    if (typeof original !== "function") {
      // getAction is not a window property (e.g. top-level let/const), so it
      // cannot be observed. Stay exactly native: the window never fills, so
      // every native trigger passes through unwrapped.
      log("window.getAction not found; passing through unobserved");
      nativeSync.call(service);
      return;
    }
    window.getAction = observingGetAction(original);
    try {
      nativeSync.call(service);
    } finally {
      window.getAction = original;
    }
  }

  function sampleIfDue() {
    if (inFlight) return;
    const due =
      verifyPending ||
      samples.length === 0 ||
      Date.now() >= samples[samples.length - 1].atWall + pollMs;
    if (!due) return;
    const sh = readShared();
    if (
      sh?.attemptBy &&
      sh.attemptBy !== tabId &&
      Number.isFinite(sh.attemptAtWall) &&
      Math.abs(Date.now() - sh.attemptAtWall) < CONFIG.attemptGuardMs
    ) {
      log("another tab is sampling; deferring"); // Attempt Guard
      return;
    }
    passThroughToNative();
  }

  // Empties the window; it refills one Sample per native Sync Trigger.
  function clearWindow() {
    samples = [];
    pollMs = CONFIG.minPollMs;
    updateShared((o) => {
      o.samples = [];
      o.pollMs = pollMs;
    });
  }

  // Timebase Anomaly: our perf clock paused (sleep) or the wall clock stepped.
  // Don't destroy the shared window blindly — another tab may already have
  // rebuilt it after the same discontinuity. Adopt fresh shared Samples and
  // verify with one Sample at the next native Sync Trigger; clear the window
  // only if nothing fresh exists. The verification is backed by the self-heal
  // rule in addSample.
  function handleTimebaseAnomaly() {
    log("timebase anomaly: resynchronizing");
    slewCorrection = null;
    samples = [];
    const sh = readShared();
    if (sh) {
      const floor = Date.now() - CONFIG.anomalyAdoptMs;
      samples = sh.samples
        .filter(
          (s) =>
            isValidSample(s) &&
            s.atWall >= floor &&
            s.atWall <= Date.now() + 1000,
        )
        .sort((a, b) => a.atWall - b.atWall);
    }
    if (samples.length) {
      pollMs = CONFIG.minPollMs;
      recomputeFromWindow();
      verifyPending = true;
    } else {
      lastWallPerfDelta = wallPerfDelta();
      clearWindow();
    }
  }

  // Local work only: anomaly detection and merging the shared window. Never
  // causes a request, so any event may call it.
  function refreshFromShared() {
    if (
      lastWallPerfDelta !== null &&
      Math.abs(wallPerfDelta() - lastWallPerfDelta) > CONFIG.wallDeltaAnomalyMs
    ) {
      handleTimebaseAnomaly();
      return;
    }
    if (mergeFromShared()) recomputeFromWindow();
  }

  // Replaces syncTimeWithServer, so every native Sync Trigger (constructor
  // call, focus listener, 120s interval, 20s post-load kick) lands here. Only
  // these triggers may let a request through; the Poll Interval decides.
  function patchedSync() {
    if (document.hidden) return;
    refreshFromShared();
    sampleIfDue();
  }

  // --- patch application ---------------------------------------------------
  function apply(svc) {
    service = svc;
    nativeSync = svc.syncTimeWithServer;
    nativeTimeNow = svc.timeNow;

    svc.syncTimeWithServer = patchedSync;
    Object.defineProperty(svc, "timeNow", {
      configurable: true,
      get: serverNow,
      // Before the first Sample, writes keep native behavior (the response to
      // the constructor's request, the worker tick). After it, writes are
      // ignored by design: the worker tick += 1000 must not drift the clock.
      set: (v) => {
        if (targetOffset === null && Number.isFinite(v)) nativeTimeNow = v;
      },
    });

    // Prompt refresh on our own events; correctness never depends on them
    // (PDA webviews may not deliver storage events), and they never request.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshFromShared();
    });
    window.addEventListener("storage", (e) => {
      if (e && e.key === CONFIG.storageKey && !document.hidden)
        refreshFromShared();
    });

    window.__timeSync = {
      config: CONFIG,
      tabId: tabId,
      get state() {
        return {
          samples: samples.slice(),
          sharedStorage: storageOk,
          offset: offsetValue(performance.now()),
          skewPpm: skewSlope * 1e6,
          pollSeconds: pollMs / 1000,
          slewing: !!slewCorrection,
          serverTime: new Date(serverNow()).toISOString(),
        };
      },
      enableLog: (on) => {
        logging = on !== false;
      },
    };

    refreshFromShared(); // adopt the shared window; the next native trigger samples if due
    log("patched serverTimeService, tab", tabId);
  }

  // Torn PDA gives no injection-order guarantee relative to base.js, so wait
  // for the service to exist rather than assuming it does.
  (function waitForService(deadline) {
    const svc = window.serverTimeService;
    if (svc && typeof svc.syncTimeWithServer === "function") {
      apply(svc);
    } else if (performance.now() < deadline) {
      setTimeout(() => {
        waitForService(deadline);
      }, CONFIG.waitRetryMs);
    }
    // else: base.js changed shape — give up quietly, native behavior stays intact
  })(performance.now() + CONFIG.waitGiveUpMs);
})();
