// ==UserScript==
// @name         Torn NTP-Style Time Sync
// @namespace    https://github.com/xentac/torn_fix_time_sync
// @version      1.1.0
// @description  Replaces Torn's single-sample time sync with an NTP-style clock filter shared across tabs: smoother timers, fewer requests.
// @match        https://www.torn.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// Design record: docs/time-sync-design.md. Vocabulary: CONTEXT.md.
// Works in Tampermonkey and Torn PDA: no GM_* APIs, no assumption that
// serverTimeService exists at injection time. All tabs share one Sample window
// through localStorage (Wall-Anchored, since each tab's performance.timeOrigin
// differs); any storage failure degrades silently to per-tab operation.

(function () {
    'use strict';

    if (window.__timeSync) return; // double-injection guard (Tampermonkey + PDA)

    var CONFIG = {
        windowSize: 8,          // Samples kept for the Clock Filter
        burstCount: 4,          // Samples in a Burst
        burstSpacingMs: 1500,
        minPollMs: 120000,      // Poll Interval floor (matches native cadence)
        maxPollMs: 1200000,     // Poll Interval cap (20 min)
        agreementMs: 50,        // Sample agreeing with prediction within this doubles the Poll Interval
        stepThresholdMs: 750,   // corrections above this Step, below it Slew
        slewDurationMs: 30000,
        wallDeltaAnomalyMs: 1000,  // Date.now()-performance.now() shift that signals a Timebase Anomaly
        anomalyAdoptMs: 300000,    // after an anomaly, shared Samples younger than this are adopted, not discarded
        fetchTimeoutMs: 10000,
        skewMinSamples: 3,
        skewMinSpanMs: 300000,  // don't trust a skew slope fit over less than 5 min
        skewClamp: 2e-4,        // ±200ppm
        waitRetryMs: 250,
        waitGiveUpMs: 30000,
        storageKey: '__tornNtpTimeSync.v1',
        attemptGuardMs: 5000,   // Attempt Guard: another tab's claim younger than this defers our Sample
        sampleMaxAgeMs: 7200000,
    };

    var tabId = Math.random().toString(36).slice(2) + Date.now().toString(36);

    // --- state ---------------------------------------------------------------
    var samples = [];           // Wall-Anchored: {wallOffset, rtt, atWall}, ascending atWall
    var pollMs = CONFIG.minPollMs;
    var targetOffset = null;    // perf-anchored offset of the min-RTT Sample (this tab only)
    var targetAnchor = 0;       // perf instant that offset was measured at
    var skewSlope = 0;          // ms of offset drift per ms of perf time
    var slewCorrection = null;  // {startPerf, amount} — decays to zero over slewDurationMs
    var inFlight = false;
    var burstRemaining = 0;
    var lastWallPerfDelta = null;
    var fallbackAnchor = null;  // {timeNow, perf} — native clock carried forward until first Sample
    var storageOk = true;       // flips false permanently on the first storage failure
    var logging = false;

    function log() {
        if (logging) console.log.apply(console, ['[timeSync]'].concat([].slice.call(arguments)));
    }

    function getCookie(name) {
        var r = document.cookie.match('\\b' + name + '=([^;]*)\\b');
        return r ? r[1] : undefined;
    }

    function wallPerfDelta() {
        return Date.now() - performance.now();
    }

    // --- the Shared Sample Window ---------------------------------------------
    function readShared() {
        if (!storageOk) return null;
        var raw;
        try {
            raw = localStorage.getItem(CONFIG.storageKey);
        } catch (e) {
            storageOk = false;
            return null;
        }
        if (!raw) return null;
        try {
            var obj = JSON.parse(raw);
            return (obj && obj.v === 1 && Array.isArray(obj.samples)) ? obj : null;
        } catch (e) {
            return null; // corrupt entry; next write replaces it
        }
    }

    function updateShared(mutate) {
        if (!storageOk) return;
        try {
            var obj = readShared() || { v: 1, samples: [] };
            mutate(obj);
            localStorage.setItem(CONFIG.storageKey, JSON.stringify(obj));
        } catch (e) {
            storageOk = false;
        }
    }

    function sampleKey(s) {
        return Math.round(s.atWall) + ':' + Math.round(s.rtt * 10);
    }

    function isValidSample(s) {
        return s && Number.isFinite(s.wallOffset) && Number.isFinite(s.rtt) && Number.isFinite(s.atWall);
    }

    // Merge the shared window into ours: dedupe, drop stale or future-dated
    // Samples, keep the newest windowSize. Deterministic, so all tabs converge
    // to the same window. Returns whether our window changed.
    function mergeFromShared(adoptPoll) {
        var sh = readShared();
        var before = samples.map(sampleKey).join(',');
        var byKey = {};
        samples.concat(sh ? sh.samples : []).forEach(function (s) {
            if (isValidSample(s)) byKey[sampleKey(s)] = s;
        });
        var now = Date.now();
        var merged = Object.keys(byKey).map(function (k) { return byKey[k]; })
            .filter(function (s) { return s.atWall >= now - CONFIG.sampleMaxAgeMs && s.atWall <= now + 1000; })
            .sort(function (a, b) { return a.atWall - b.atWall; });
        if (merged.length > CONFIG.windowSize) merged = merged.slice(merged.length - CONFIG.windowSize);
        samples = merged;
        if (adoptPoll !== false && sh && Number.isFinite(sh.pollMs)) {
            pollMs = Math.min(Math.max(sh.pollMs, CONFIG.minPollMs), CONFIG.maxPollMs);
        }
        return samples.map(sampleKey).join(',') !== before;
    }

    // --- the clock -----------------------------------------------------------
    function targetValue(perf) {
        return targetOffset + skewSlope * (perf - targetAnchor);
    }

    function offsetValue(perf) {
        if (targetOffset === null) return null;
        var v = targetValue(perf);
        if (slewCorrection) {
            var f = (perf - slewCorrection.startPerf) / CONFIG.slewDurationMs;
            if (f >= 1) slewCorrection = null;
            else v += slewCorrection.amount * (1 - f);
        }
        return v;
    }

    function serverNow() {
        var perf = performance.now();
        var offset = offsetValue(perf);
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
        var delta = wallPerfDelta();
        var ps = samples.map(function (s) {
            return { offset: s.wallOffset + delta, rtt: s.rtt, atPerf: s.atWall - delta };
        });

        var best = ps[0];
        for (var i = 1; i < ps.length; i++) {
            if (ps[i].rtt < best.rtt) best = ps[i];
        }

        var slope = 0;
        var span = ps[ps.length - 1].atPerf - ps[0].atPerf;
        if (ps.length >= CONFIG.skewMinSamples && span >= CONFIG.skewMinSpanMs) {
            var n = ps.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
            ps.forEach(function (s) {
                sx += s.atPerf; sy += s.offset;
                sxx += s.atPerf * s.atPerf; sxy += s.atPerf * s.offset;
            });
            slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
            slope = Math.max(-CONFIG.skewClamp, Math.min(CONFIG.skewClamp, slope));
        }

        var perf = performance.now();
        var previous = offsetValue(perf);
        targetOffset = best.offset;
        targetAnchor = best.atPerf;
        skewSlope = slope;
        lastWallPerfDelta = delta; // conversions are calibrated to this delta from here on

        var diff = previous === null ? Infinity : previous - targetValue(perf);
        if (Math.abs(diff) > CONFIG.stepThresholdMs) {
            slewCorrection = null; // Step
            log('step', diff === Infinity ? '(first sync)' : Math.round(diff) + 'ms');
        } else if (diff !== 0) {
            slewCorrection = { startPerf: perf, amount: diff }; // Slew
            log('slew', Math.round(diff) + 'ms over ' + CONFIG.slewDurationMs / 1000 + 's');
        }
    }

    function addSample(perfSample) {
        if (targetOffset !== null && burstRemaining === 0) {
            var predicted = targetValue(perfSample.atPerf);
            var bestRtt = samples.reduce(function (m, s) { return Math.min(m, s.rtt); }, Infinity);
            var disagreement = Math.abs(perfSample.offset - predicted);
            var credible = perfSample.rtt <= bestRtt * 2;
            if (credible && disagreement > 2 * CONFIG.stepThresholdMs) {
                // Self-heal: a credible Sample wildly disagreeing means the window is
                // poisoned (e.g. Samples written just before a wall-clock step).
                log('credible sample disagrees by ' + Math.round(disagreement) + 'ms; rebuilding window');
                clearWindowAndBurst();
            } else if (disagreement <= CONFIG.agreementMs) {
                // Adaptive Poll Interval: agreement with the prediction earns backoff.
                pollMs = Math.min(pollMs * 2, CONFIG.maxPollMs);
            } else if (credible) {
                pollMs = CONFIG.minPollMs;
            } // high-RTT disagreement: likely the sample's own asymmetry noise —
              // the Clock Filter discards it, so poll policy ignores it too
        }

        var delta = wallPerfDelta();
        samples.push({
            wallOffset: perfSample.offset - delta,
            rtt: perfSample.rtt,
            atWall: perfSample.atPerf + delta,
        });
        mergeFromShared(false); // pull other tabs' Samples; keep our poll decision
        updateShared(function (o) { o.samples = samples; o.pollMs = pollMs; });
        recomputeFromWindow();
        log('sample rtt=' + Math.round(perfSample.rtt) + 'ms offset=' + Math.round(perfSample.offset) +
            'ms poll=' + pollMs / 1000 + 's window=' + samples.length);
    }

    // --- sampling ------------------------------------------------------------
    function takeSample() {
        var settled = false;
        function settle() { // continue a Burst exactly once per attempt, taken or skipped
            if (settled) return;
            settled = true;
            if (burstRemaining > 0) {
                burstRemaining--;
                if (burstRemaining > 0) setTimeout(takeSample, CONFIG.burstSpacingMs);
            }
        }

        if (inFlight || document.hidden || getCookie('isLoggedIn') !== '1') return settle();

        var sh = readShared();
        if (sh && sh.attemptBy && sh.attemptBy !== tabId &&
            Number.isFinite(sh.attemptAtWall) &&
            Math.abs(Date.now() - sh.attemptAtWall) < CONFIG.attemptGuardMs) {
            log('another tab is sampling; deferring'); // Attempt Guard
            return settle();
        }

        inFlight = true;
        updateShared(function (o) { o.attemptAtWall = Date.now(); o.attemptBy = tabId; });

        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        var timeout = controller && setTimeout(function () { controller.abort(); }, CONFIG.fetchTimeoutMs);
        var t0 = performance.now();

        fetch('/sidebarAjaxAction.php?action=servertime&t=' + Date.now(), {
            credentials: 'same-origin',
            signal: controller && controller.signal,
        }).then(function (resp) {
            return resp.text();
        }).then(function (text) {
            var t3 = performance.now();
            var data = JSON.parse(text);
            if (!data || !Number.isFinite(data.time)) throw new Error('bad servertime payload');
            var rtt = t3 - t0;
            addSample({ offset: data.time + rtt / 2 - t3, rtt: rtt, atPerf: t3 });
        }).catch(function (e) {
            log('sample failed', e);
        }).finally(function () {
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
        updateShared(function (o) { o.samples = []; o.pollMs = pollMs; });
        startBurst();
    }

    // Timebase Anomaly: our perf clock paused (sleep) or the wall clock stepped.
    // Don't destroy the shared window blindly — another tab may already have
    // rebuilt it after the same discontinuity. Adopt fresh shared Samples and
    // verify with one request; Burst only if nothing fresh exists. The
    // verification is backed by the self-heal rule in addSample.
    function handleTimebaseAnomaly() {
        log('timebase anomaly: resynchronizing');
        slewCorrection = null;
        samples = [];
        var sh = readShared();
        if (sh) {
            var floor = Date.now() - CONFIG.anomalyAdoptMs;
            samples = sh.samples.filter(function (s) {
                return isValidSample(s) && s.atWall >= floor && s.atWall <= Date.now() + 1000;
            }).sort(function (a, b) { return a.atWall - b.atWall; });
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
        if (lastWallPerfDelta !== null &&
            Math.abs(wallPerfDelta() - lastWallPerfDelta) > CONFIG.wallDeltaAnomalyMs) {
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
        Object.defineProperty(service, 'timeNow', {
            configurable: true,
            get: serverNow,
            set: function () {}, // writes ignored by design: the worker tick += 1000 must not drift the clock
        });

        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) patchedSync();
        });
        // Prompt refresh when another tab writes; correctness never depends on
        // this event (PDA webviews may not deliver it) — every trigger re-reads.
        window.addEventListener('storage', function (e) {
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
            enableLog: function (on) { logging = on !== false; },
        };

        patchedSync(); // adopt the shared window if fresh; Burst only if it isn't
        log('patched serverTimeService, tab', tabId);
    }

    // Torn PDA gives no injection-order guarantee relative to base.js, so wait
    // for the service to exist rather than assuming it does.
    (function waitForService(deadline) {
        var service = window.serverTimeService;
        if (service && typeof service.syncTimeWithServer === 'function') {
            apply(service);
        } else if (performance.now() < deadline) {
            setTimeout(function () { waitForService(deadline); }, CONFIG.waitRetryMs);
        }
        // else: base.js changed shape — give up quietly, native behavior stays intact
    })(performance.now() + CONFIG.waitGiveUpMs);
})();
