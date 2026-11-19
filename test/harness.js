// Virtual-time test harness for torn-ntp-time-sync.user.js.
//
// createWorld() builds an isolated world: a virtual monotonic clock, a wall
// clock and server clock derived from it, a timer wheel, a seeded-latency
// network model, and a localStorage shared between the world's tabs (with
// cross-tab storage events). makeTab() runs the real userscript file inside
// that world with per-tab performance origins, exactly as separate browser
// tabs would see it.
//
// Time is virtual: `await world.advance(ms)` runs every due timer and drains
// microtasks, so multi-hour scenarios execute in milliseconds.

import { readFileSync } from "node:fs";

const code = readFileSync(
  new URL("../torn-ntp-time-sync.user.js", import.meta.url),
  "utf8",
);

export const STORAGE_KEY = "__tornNtpTimeSync.v1";

function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createWorld({ seed = 1 } = {}) {
  const rand = mulberry32(seed);

  // --- clocks: wall and server are both derived from the virtual perf clock,
  // so shifting wallBase/serverOffsetTrue models steps and sleep.
  let vPerf = 0;
  let wallBase = 1751400000000;
  let serverOffsetTrue = 5000;
  const wallNow = () => wallBase + vPerf;
  const trueServerNow = () => wallBase + serverOffsetTrue + vPerf;

  class DateStub extends Date {
    static now() {
      return wallNow();
    }
  }

  // --- timer wheel
  let timers = [];
  let timerSeq = 1;
  const vSetTimeout = (fn, ms) => {
    timers.push({ id: timerSeq, at: vPerf + (ms || 0), fn });
    return timerSeq++;
  };
  const vClearTimeout = (id) => {
    timers = timers.filter((t) => t.id !== id);
  };
  const drain = () => new Promise((r) => setImmediate(r));

  async function advance(ms) {
    const end = vPerf + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0].at > end) break;
      const t = timers.shift();
      vPerf = Math.max(vPerf, t.at);
      t.fn();
      await drain();
      await drain();
    }
    vPerf = end;
    await drain();
    await drain();
  }

  // --- network model: asymmetric latency with occasional spikes. Requests
  // only exist as Torn's getAction calls; the userscript has no transport.
  let requestCount = 0;
  let requestsOutsideTrigger = 0; // requests not caused by a native Sync Trigger
  let nativeDepth = 0; // >0 while a native Sync Trigger is running
  let badPayloadNext = false;
  function vGetAction(opts) {
    requestCount++;
    if (nativeDepth === 0) requestsOutsideTrigger++;
    const up = 20 + rand() * 80 + (rand() < 0.15 ? rand() * 400 : 0);
    const down = 20 + rand() * 80 + (rand() < 0.15 ? rand() * 400 : 0);
    const bad = badPayloadNext;
    badPayloadNext = false;
    const tServer = trueServerNow() + up; // server stamps after the uplink
    vSetTimeout(() => {
      opts.success(
        bad ? '{"ok":true}' : JSON.stringify({ time: Math.round(tServer) }),
      );
    }, up + down);
  }
  const noFetch = () => {
    throw new Error("the userscript must not send its own requests");
  };

  // --- shared storage with cross-tab storage events
  const store = new Map();
  const tabs = [];
  function makeStorage(owner) {
    return {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => {
        store.set(k, String(v));
        tabs.forEach((t) => {
          if (t !== owner)
            t.storageListeners.forEach((fn) => {
              vSetTimeout(() => fn({ key: k }), 0);
            });
        });
      },
    };
  }
  const brokenStorage = {
    getItem() {
      throw new Error("storage denied");
    },
    setItem() {
      throw new Error("storage denied");
    },
  };

  function makeTab(
    name,
    {
      perfOrigin = vPerf,
      intervalOffset = 0,
      broken = false,
      noService = false,
      getActionOffWindow = false, // base.js sees getAction, window does not
    } = {},
  ) {
    const tab = { name, storageListeners: [], visListeners: [], hidden: false };
    tab.perf = { now: () => vPerf - perfOrigin };
    tab.doc = {
      get hidden() {
        return tab.hidden;
      },
      cookie: "isLoggedIn=1",
      addEventListener: (ev, fn) => {
        if (ev === "visibilitychange") tab.visListeners.push(fn);
      },
    };
    tab.win = {
      getAction: getActionOffWindow ? undefined : vGetAction,
      addEventListener: (ev, fn) => {
        if (ev === "storage") tab.storageListeners.push(fn);
      },
    };

    // ServerTimeService from base.js, minus the jQuery/cookie plumbing. It
    // resolves getAction from the global object at call time, as base.js does.
    const service = { timeNow: wallNow() };
    const getAction = () =>
      getActionOffWindow ? vGetAction : tab.win.getAction;
    service.syncTimeWithServer = () => {
      if (typeof getAction() !== "function") return;
      if (!/\bisLoggedIn=1\b/.test(tab.doc.cookie)) return;
      const start = wallNow();
      getAction()({
        type: "get",
        action: `/sidebarAjaxAction.php?action=servertime&t=${start}`,
        success: (resp) => {
          try {
            const data = JSON.parse(resp);
            const latency = (wallNow() - start) / 2;
            service.timeNow = data && data.time + latency;
          } catch (_e) {}
        },
      });
    };
    tab.service = service;
    // a native Sync Trigger: base.js calls the method late-bound on the instance
    const trigger = () => {
      nativeDepth++;
      try {
        tab.service.syncTimeWithServer();
      } finally {
        nativeDepth--;
      }
    };

    if (!noService) {
      tab.win.serverTimeService = tab.service;
      trigger(); // constructor call, before the userscript can patch anything
    }

    new Function(
      "window",
      "document",
      "performance",
      "Date",
      "fetch",
      "XMLHttpRequest",
      "setTimeout",
      "clearTimeout",
      "console",
      "localStorage",
      code,
    )(
      tab.win,
      tab.doc,
      tab.perf,
      DateStub,
      noFetch,
      noFetch,
      vSetTimeout,
      vClearTimeout,
      console,
      broken ? brokenStorage : makeStorage(tab),
    );

    if (!noService) {
      // worker tick: timers_web_worker.js posts 'tick' every second
      const workerTick = () => {
        tab.service.timeNow += 1000;
        vSetTimeout(workerTick, 1000);
      };
      vSetTimeout(workerTick, 1000);
      // 20s post-load kick from jQuery(document).ready
      vSetTimeout(trigger, 20000);
      // 120s interval, skipped while hidden
      const tick = () => {
        if (!tab.hidden) trigger();
        vSetTimeout(tick, 120000);
      };
      vSetTimeout(tick, 120000 + intervalOffset);
    }

    tab.setHidden = (h) => {
      tab.hidden = h;
      tab.visListeners.forEach((f) => {
        f();
      });
      if (!h) trigger(); // native focus listener
    };
    tab.err = () => tab.service.timeNow - trueServerNow();
    tabs.push(tab);
    return tab;
  }

  return {
    advance,
    makeTab,
    wallNow,
    trueServerNow,
    get requestCount() {
      return requestCount;
    },
    get requestsOutsideTrigger() {
      return requestsOutsideTrigger;
    },
    failNextPayload() {
      badPayloadNext = true;
    },
    // system sleep: the perf clocks stand still while wall and server move on
    systemSleep(ms) {
      wallBase += ms;
      serverOffsetTrue += ms;
    },
    // pre-populate the shared window, e.g. with poisoned samples
    seedSharedWindow(samples, pollMs = 120000) {
      store.set(STORAGE_KEY, JSON.stringify({ v: 1, samples, pollMs }));
    },
    get trueOffset() {
      return serverOffsetTrue;
    },
  };
}
