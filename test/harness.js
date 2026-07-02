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

  // --- network model: asymmetric latency with occasional spikes
  let fetchCount = 0;
  let badPayloadNext = false;
  function vFetch() {
    fetchCount++;
    const up = 20 + rand() * 80 + (rand() < 0.15 ? rand() * 400 : 0);
    const down = 20 + rand() * 80 + (rand() < 0.15 ? rand() * 400 : 0);
    const bad = badPayloadNext;
    badPayloadNext = false;
    return new Promise((resolve) => {
      const tServer = trueServerNow() + up; // server stamps after the uplink
      vSetTimeout(
        () =>
          resolve({
            text: () =>
              Promise.resolve(
                bad
                  ? '{"ok":true}'
                  : JSON.stringify({ time: Math.round(tServer) }),
              ),
          }),
        up + down,
      );
    });
  }

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
    tab.service = { timeNow: wallNow(), syncTimeWithServer() {} };
    tab.win = {
      addEventListener: (ev, fn) => {
        if (ev === "storage") tab.storageListeners.push(fn);
      },
    };
    if (!noService) tab.win.serverTimeService = tab.service;

    new Function(
      "window",
      "document",
      "performance",
      "Date",
      "fetch",
      "setTimeout",
      "clearTimeout",
      "console",
      "AbortController",
      "localStorage",
      code,
    )(
      tab.win,
      tab.doc,
      tab.perf,
      DateStub,
      vFetch,
      vSetTimeout,
      vClearTimeout,
      console,
      class {
        constructor() {
          this.signal = null;
        }
        abort() {}
      },
      broken ? brokenStorage : makeStorage(tab),
    );

    if (!noService) {
      // native base.js 120s interval
      const tick = () => {
        if (!tab.hidden) tab.service.syncTimeWithServer();
        vSetTimeout(tick, 120000);
      };
      vSetTimeout(tick, 120000 + intervalOffset);
    }

    tab.setHidden = (h) => {
      tab.hidden = h;
      tab.visListeners.forEach((f) => {
        f();
      });
      if (!h) tab.service.syncTimeWithServer(); // native focus listener
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
    get fetchCount() {
      return fetchCount;
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
