// ==UserScript==
// @name         Torn NTP-Style Time Sync
// @namespace    https://github.com/xentac/torn_fix_time_sync
// @version      1.1.1
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

(() => {
  if (window.__timeSync) return; // double-injection guard (Tampermonkey + PDA)

  const CONFIG = {
    windowSize: 8, // Samples kept for the Clock Filter
    burstCount: 4, // Samples in a Burst
    burstSpacingMs: 1500,
    minPollMs: 120000, // Poll Interval floor (matches native cadence)
    maxPollMs: 1200000, // Poll Interval cap (20 min)
    agreementMs: 50, // Sample agreeing with prediction within this doubles the Poll Interval
    stepThresholdMs: 750, // corrections above this Step, below it Slew
    slewDurationMs: 30000,
    wallDeltaAnomalyMs: 1000, // Date.now()-performance.now() shift that signals a Timebase Anomaly
    anomalyAdoptMs: 300000, // after an anomaly, shared Samples younger than this are adopted, not discarded
    fetchTimeoutMs: 10000,
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
  let burstRemaining = 0;
  let lastWallPerfDelta = null;
  let fallbackAnchor = null; // {timeNow, perf} — native clock carried forward until first Sample
  let storageOk = true; // flips false permanently on the first storage failure
  let logging = false;

  function log(...args) {
    if (logging) console.log("[timeSync]", ...args);
  }

  function getCookie(name) {
    const r = document.cookie.match(`\\b${name}=([^;]*)\\b`);
    return r ? r[1] : undefined;
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
    if (offset === null) {
      // No Sample yet: carry the native clock forward from patch time.
      return Math.round(fallbackAnchor.timeNow + (perf - fallbackAnchor.perf));
    }
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
    if (targetOffset !== null && burstRemaining === 0) {
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
        clearWindowAndBurst();
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
  function takeSample() {
    let settled = false;
    function settle() {
      // continue a Burst exactly once per attempt, taken or skipped
      if (settled) return;
      settled = true;
      if (burstRemaining > 0) {
        burstRemaining--;
        if (burstRemaining > 0) setTimeout(takeSample, CONFIG.burstSpacingMs);
      }
    }

    if (inFlight || document.hidden || getCookie("isLoggedIn") !== "1")
      return settle();

    const sh = readShared();
    if (
      sh?.attemptBy &&
      sh.attemptBy !== tabId &&
      Number.isFinite(sh.attemptAtWall) &&
      Math.abs(Date.now() - sh.attemptAtWall) < CONFIG.attemptGuardMs
    ) {
      log("another tab is sampling; deferring"); // Attempt Guard
      return settle();
    }

    inFlight = true;
    updateShared((o) => {
      o.attemptAtWall = Date.now();
      o.attemptBy = tabId;
    });

    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const timeout =
      controller &&
      setTimeout(() => {
        controller.abort();
      }, CONFIG.fetchTimeoutMs);
    const t0 = performance.now();

    fetch(`/sidebarAjaxAction.php?action=servertime&t=${Date.now()}`, {
      credentials: "same-origin",
      signal: controller?.signal,
    })
      .then((resp) => resp.text())
      .then((text) => {
        const t3 = performance.now();
        const data = JSON.parse(text);
        if (!data || !Number.isFinite(data.time))
          throw new Error("bad servertime payload");
        const rtt = t3 - t0;
        addSample({ offset: data.time + rtt / 2 - t3, rtt: rtt, atPerf: t3 });
      })
      .catch((e) => {
        log("sample failed", e);
      })
      .finally(() => {
        if (timeout) clearTimeout(timeout);
        inFlight = false;
        settle();
      });
  }

  function startBurst() {
    if (burstRemaining > 0) return;
    burstRemaining = CONFIG.burstCount;
    takeSample();
  }

  function clearWindowAndBurst() {
    samples = [];
    pollMs = CONFIG.minPollMs;
    updateShared((o) => {
      o.samples = [];
      o.pollMs = pollMs;
    });
    startBurst();
  }

  // Timebase Anomaly: our perf clock paused (sleep) or the wall clock stepped.
  // Don't destroy the shared window blindly — another tab may already have
  // rebuilt it after the same discontinuity. Adopt fresh shared Samples and
  // verify with one request; Burst only if nothing fresh exists. The
  // verification is backed by the self-heal rule in addSample.
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
      takeSample(); // verification Sample
    } else {
      lastWallPerfDelta = wallPerfDelta();
      clearWindowAndBurst();
    }
  }

  // Every native Sync Trigger (focus listener, 120s interval, 20s post-load
  // kick) lands here, as do visibility and storage events; the Poll Interval
  // decides whether a Sample is actually taken.
  function patchedSync() {
    if (document.hidden) return;
    if (
      lastWallPerfDelta !== null &&
      Math.abs(wallPerfDelta() - lastWallPerfDelta) > CONFIG.wallDeltaAnomalyMs
    ) {
      handleTimebaseAnomaly();
      return;
    }
    if (mergeFromShared()) recomputeFromWindow();
    if (samples.length === 0) {
      startBurst();
    } else if (Date.now() >= samples[samples.length - 1].atWall + pollMs) {
      takeSample();
    }
  }

  // --- patch application ---------------------------------------------------
  function apply(service) {
    fallbackAnchor = { timeNow: service.timeNow, perf: performance.now() };

    service.syncTimeWithServer = patchedSync;
    Object.defineProperty(service, "timeNow", {
      configurable: true,
      get: serverNow,
      set: () => {}, // writes ignored by design: the worker tick += 1000 must not drift the clock
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) patchedSync();
    });
    // Prompt refresh when another tab writes; correctness never depends on
    // this event (PDA webviews may not deliver it) — every trigger re-reads.
    window.addEventListener("storage", (e) => {
      if (e && e.key === CONFIG.storageKey) patchedSync();
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

    patchedSync(); // adopt the shared window if fresh; Burst only if it isn't
    log("patched serverTimeService, tab", tabId);
  }

  // Torn PDA gives no injection-order guarantee relative to base.js, so wait
  // for the service to exist rather than assuming it does.
  (function waitForService(deadline) {
    const service = window.serverTimeService;
    if (service && typeof service.syncTimeWithServer === "function") {
      apply(service);
    } else if (performance.now() < deadline) {
      setTimeout(() => {
        waitForService(deadline);
      }, CONFIG.waitRetryMs);
    }
    // else: base.js changed shape — give up quietly, native behavior stays intact
  })(performance.now() + CONFIG.waitGiveUpMs);
})();
