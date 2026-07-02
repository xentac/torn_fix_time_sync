// ==UserScript==
// @name         Torn NTP-Style Time Sync
// @namespace    https://github.com/xentac/torn_fix_time_sync
// @version      1.0.0
// @description  Replaces Torn's single-sample server time sync with an NTP-style clock filter: smoother timers, fewer requests.
// @match        https://www.torn.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// Design record: docs/time-sync-design.md. Vocabulary: CONTEXT.md.
// Works in Tampermonkey and Torn PDA: no GM_* APIs, no assumption that
// serverTimeService exists at injection time.

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
        hiddenInvalidateMs: 60000, // hidden longer than this invalidates the Sample window
        wallDeltaAnomalyMs: 1000,  // Date.now()-performance.now() shift that signals a paused timebase
        fetchTimeoutMs: 10000,
        skewMinSamples: 3,
        skewMinSpanMs: 300000,  // don't trust a skew slope fit over less than 5 min
        skewClamp: 2e-4,        // ±200ppm
        waitRetryMs: 250,
        waitGiveUpMs: 30000,
    };

    // --- state ---------------------------------------------------------------
    var samples = [];           // {offset, rtt, atPerf} — offset maps performance.now() to server ms
    var targetOffset = null;    // offset of the min-RTT Sample
    var targetAnchor = 0;       // perf instant that offset was measured at
    var skewSlope = 0;          // ms of offset drift per ms of perf time
    var slewCorrection = null;  // {startPerf, amount} — decays to zero over slewDurationMs
    var pollMs = CONFIG.minPollMs;
    var nextPollAt = 0;         // perf time the next Sample is due
    var inFlight = false;
    var burstRemaining = 0;
    var hiddenSince = null;
    var lastWallPerfDelta = null;
    var fallbackAnchor = null;  // {timeNow, perf} — native clock carried forward until first Sample
    var logging = false;

    function log() {
        if (logging) console.log.apply(console, ['[timeSync]'].concat([].slice.call(arguments)));
    }

    function getCookie(name) {
        var r = document.cookie.match('\\b' + name + '=([^;]*)\\b');
        return r ? r[1] : undefined;
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
        var best = samples[0];
        for (var i = 1; i < samples.length; i++) {
            if (samples[i].rtt < best.rtt) best = samples[i];
        }

        var slope = 0;
        var span = samples[samples.length - 1].atPerf - samples[0].atPerf;
        if (samples.length >= CONFIG.skewMinSamples && span >= CONFIG.skewMinSpanMs) {
            var n = samples.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
            samples.forEach(function (s) {
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

        var diff = previous === null ? Infinity : previous - targetValue(perf);
        if (Math.abs(diff) > CONFIG.stepThresholdMs) {
            slewCorrection = null; // Step
            log('step', diff === Infinity ? '(first sync)' : Math.round(diff) + 'ms');
        } else if (diff !== 0) {
            slewCorrection = { startPerf: perf, amount: diff }; // Slew
            log('slew', Math.round(diff) + 'ms over ' + CONFIG.slewDurationMs / 1000 + 's');
        }
    }

    function addSample(sample) {
        // Adaptive Poll Interval: agreement with the prediction earns backoff.
        // A disagreeing sample only resets backoff if its RTT is credible —
        // otherwise the disagreement is likely the sample's own asymmetry noise,
        // which the Clock Filter is about to discard anyway.
        if (targetOffset !== null && burstRemaining === 0) {
            var predicted = targetValue(sample.atPerf);
            var bestRtt = samples.reduce(function (m, s) { return Math.min(m, s.rtt); }, Infinity);
            if (Math.abs(sample.offset - predicted) <= CONFIG.agreementMs) {
                pollMs = Math.min(pollMs * 2, CONFIG.maxPollMs);
            } else if (sample.rtt <= bestRtt * 2) {
                pollMs = CONFIG.minPollMs;
            } // high-RTT disagreement: keep the current Poll Interval
        }
        nextPollAt = sample.atPerf + pollMs;

        samples.push(sample);
        if (samples.length > CONFIG.windowSize) samples.shift();
        recomputeFromWindow();
        log('sample rtt=' + Math.round(sample.rtt) + 'ms offset=' + Math.round(sample.offset) +
            'ms poll=' + pollMs / 1000 + 's');
    }

    // --- sampling ------------------------------------------------------------
    function takeSample() {
        if (inFlight || document.hidden || getCookie('isLoggedIn') !== '1') return;
        inFlight = true;

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
            lastWallPerfDelta = Date.now() - t3;
            addSample({ offset: data.time + rtt / 2 - t3, rtt: rtt, atPerf: t3 });
        }).catch(function (e) {
            log('sample failed', e);
        }).finally(function () {
            if (timeout) clearTimeout(timeout);
            inFlight = false;
            if (burstRemaining > 0) {
                burstRemaining--;
                if (burstRemaining > 0) setTimeout(takeSample, CONFIG.burstSpacingMs);
            }
        });
    }

    function startBurst() {
        if (burstRemaining > 0) return;
        burstRemaining = CONFIG.burstCount;
        takeSample();
    }

    function invalidateAndBurst(reason) {
        log('invalidating sample window:', reason);
        samples = [];
        pollMs = CONFIG.minPollMs;
        startBurst();
    }

    // Every native Sync Trigger (focus listener, 120s interval, 20s post-load kick)
    // lands here; the Poll Interval decides whether a Sample is actually taken.
    function patchedSync() {
        if (document.hidden) return;
        var perf = performance.now();
        if (lastWallPerfDelta !== null &&
            Math.abs((Date.now() - perf) - lastWallPerfDelta) > CONFIG.wallDeltaAnomalyMs) {
            // performance.now() paused (sleep) or the wall clock stepped; either way
            // re-measure. A false positive just costs one Burst that confirms the offset.
            invalidateAndBurst('timebase anomaly');
            return;
        }
        if (samples.length === 0) startBurst();
        else if (perf >= nextPollAt) takeSample();
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
            if (document.hidden) {
                hiddenSince = performance.now();
            } else if (hiddenSince !== null &&
                       performance.now() - hiddenSince > CONFIG.hiddenInvalidateMs) {
                invalidateAndBurst('hidden ' + Math.round((performance.now() - hiddenSince) / 1000) + 's');
            }
        });

        window.__timeSync = {
            config: CONFIG,
            get state() {
                return {
                    samples: samples.slice(),
                    offset: offsetValue(performance.now()),
                    skewPpm: skewSlope * 1e6,
                    pollSeconds: pollMs / 1000,
                    slewing: !!slewCorrection,
                    serverTime: new Date(serverNow()).toISOString(),
                };
            },
            enableLog: function (on) { logging = on !== false; },
        };

        startBurst();
        log('patched serverTimeService');
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
