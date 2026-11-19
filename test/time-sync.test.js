import { expect, test } from "bun:test";
import { createWorld } from "./harness.js";

const LONG = 30000; // real-time budget for multi-hour virtual scenarios

// Startup bounds below are the worst case over a 20-seed sweep of the spiky
// network model, rounded up.
test("a cold start keeps the native clock until the 20s kick, then syncs", async () => {
  const w = createWorld({ seed: 1 });
  const t1 = w.makeTab("t1");
  await w.advance(19000);
  // native single-sample clock with 1s worker ticks (worst seen 656ms)
  expect(Math.abs(t1.err())).toBeLessThan(1000);
  await w.advance(6000);
  expect(Math.abs(t1.err())).toBeLessThan(250);
  expect(w.requestCount).toBe(2); // constructor call + 20s kick, as native
  await w.advance(275000);
  expect(Math.abs(t1.err())).toBeLessThan(100);
});

test("never sends a request outside a native Sync Trigger", async () => {
  const w = createWorld({ seed: 13 });
  const t1 = w.makeTab("t1");
  await w.advance(60000);
  const t2 = w.makeTab("t2", { intervalOffset: 7000 });
  await w.advance(60000);
  w.failNextPayload();
  t1.setHidden(true);
  await w.advance(1000);
  w.systemSleep(3600000);
  t1.setHidden(false);
  t2.setHidden(true);
  t2.setHidden(false);
  await w.advance(3600000);
  expect(w.requestsOutsideTrigger).toBe(0);
});

test("an unobservable getAction falls back to exact native behavior", async () => {
  const w = createWorld({ seed: 15 });
  const t1 = w.makeTab("t1", { getActionOffWindow: true });
  await w.advance(30 * 60 * 1000);
  expect(t1.win.__timeSync.state.samples.length).toBe(0);
  // constructor + 20s kick + 15 interval ticks: every native request goes out
  expect(w.requestCount).toBe(17);
  expect(Math.abs(t1.err())).toBeLessThan(1500); // native single-sample clock
});

test("getAction is wrapped only during the native call", async () => {
  const w = createWorld({ seed: 14 });
  const t1 = w.makeTab("t1");
  const native = t1.win.getAction;
  await w.advance(25000);
  expect(t1.win.getAction).toBe(native);
  expect(t1.win.__timeSync.state.samples.length).toBe(1);
});

test("worker tick writes to timeNow are ignored", async () => {
  const w = createWorld({ seed: 2 });
  const t1 = w.makeTab("t1");
  await w.advance(25000); // after the first Sample; before it, native semantics hold
  const before = t1.service.timeNow;
  t1.service.timeNow += 1000; // what timers_web_worker.js does every second
  expect(Math.abs(t1.service.timeNow - before)).toBeLessThan(5);
});

test(
  "steady-state clock is smooth and monotonic",
  async () => {
    const w = createWorld({ seed: 3 });
    const t1 = w.makeTab("t1");
    await w.advance(25000);
    let last = t1.service.timeNow,
      maxJump = 0,
      monotonic = true;
    for (let i = 0; i < 900; i++) {
      // 15 min of 1s reads
      await w.advance(1000);
      const now = t1.service.timeNow;
      maxJump = Math.max(maxJump, Math.abs(now - last - 1000));
      if (now < last) monotonic = false;
      last = now;
    }
    expect(maxJump).toBeLessThan(100); // native code steps visibly on every sync
    expect(monotonic).toBe(true);
  },
  LONG,
);

// Rate/accuracy bounds are the worst case observed sweeping 20 seeds through the
// spiky network model (10 req/h, 73ms one tab; 8 req/h, 162ms two tabs), rounded
// up — not typical values, which are ~4 req/h and tens of ms. Native behavior is
// 30 req/h per tab, stepping.
test(
  "polling backs off in steady state without losing accuracy",
  async () => {
    const w = createWorld({ seed: 4 });
    const t1 = w.makeTab("t1");
    await w.advance(25000);
    const f0 = w.requestCount;
    await w.advance(4 * 3600 * 1000);
    expect((w.requestCount - f0) / 4).toBeLessThanOrEqual(10);
    expect(Math.abs(t1.err())).toBeLessThan(250);
  },
  LONG,
);

test(
  "a malformed servertime payload cannot poison the clock",
  async () => {
    const w = createWorld({ seed: 5 });
    const t1 = w.makeTab("t1");
    await w.advance(25000);
    w.failNextPayload(); // native code sets timeNow = NaN on this
    await w.advance(25 * 60 * 1000);
    expect(Number.isFinite(t1.service.timeNow)).toBe(true);
    expect(Math.abs(t1.err())).toBeLessThan(200);
  },
  LONG,
);

// The one request is the native constructor call, which runs before any patch.
test("a second tab adopts the shared window without a Sample of its own", async () => {
  const w = createWorld({ seed: 6 });
  w.makeTab("t1");
  await w.advance(60000);
  const before = w.requestCount;
  const t2 = w.makeTab("t2", { intervalOffset: 7000 });
  await w.advance(10000);
  expect(w.requestCount - before).toBeLessThanOrEqual(1);
  expect(Math.abs(t2.err())).toBeLessThan(150);
});

test("tabs agree exactly once slewing settles", async () => {
  const w = createWorld({ seed: 7 });
  const t1 = w.makeTab("t1");
  await w.advance(60000);
  const t2 = w.makeTab("t2", { intervalOffset: 7000 });
  await w.advance(60000);
  expect(Math.abs(t1.service.timeNow - t2.service.timeNow)).toBeLessThanOrEqual(
    3,
  );
});

test(
  "two visible tabs share one poll budget",
  async () => {
    const w = createWorld({ seed: 8 });
    const t1 = w.makeTab("t1");
    const t2 = w.makeTab("t2", { intervalOffset: 7000 });
    await w.advance(60000);
    const f0 = w.requestCount;
    await w.advance(4 * 3600 * 1000);
    expect((w.requestCount - f0) / 4).toBeLessThanOrEqual(10); // combined, vs native 60 req/h
    expect(Math.abs(t1.err())).toBeLessThan(250);
    expect(Math.abs(t2.err())).toBeLessThan(250);
  },
  LONG,
);

test("both tabs recover from system sleep, second tab adopting the rebuild", async () => {
  const w = createWorld({ seed: 9 });
  const t1 = w.makeTab("t1");
  await w.advance(60000);
  const t2 = w.makeTab("t2", { intervalOffset: 7000 });
  await w.advance(60000);

  t1.setHidden(true);
  t2.setHidden(true);
  await w.advance(1000);
  w.systemSleep(3600000); // perf clocks stand still for an hour

  const f0 = w.requestCount;
  t1.setHidden(false);
  await w.advance(15000);
  t2.setHidden(false);
  await w.advance(20000);

  expect(Math.abs(t1.err())).toBeLessThan(200);
  expect(Math.abs(t2.err())).toBeLessThan(200);
  // t1's focus trigger rebuilds the window; t2 adopts it + one verification sample
  expect(w.requestCount - f0).toBeLessThanOrEqual(2);
});

test(
  "a poisoned shared window is detected and rebuilt",
  async () => {
    const w = createWorld({ seed: 10 });
    // realistic-looking samples that are 30s wrong — e.g. written just before a
    // wall-clock step. RTTs are plausible so the self-heal credibility test can fire.
    const wall = w.wallNow();
    w.seedSharedWindow(
      [0, 1, 2].map((i) => ({
        wallOffset: w.trueOffset + 30000,
        rtt: 60 + i,
        atWall: wall - 5000 + i * 1500,
      })),
    );
    const t1 = w.makeTab("t1");
    await w.advance(5000);
    expect(Math.abs(t1.err())).toBeGreaterThan(20000); // adopted the poison
    await w.advance(15 * 60 * 1000);
    expect(Math.abs(t1.err())).toBeLessThan(200); // self-heal rebuilt the window
  },
  LONG,
);

test("broken localStorage degrades to per-tab operation", async () => {
  const w = createWorld({ seed: 11 });
  const t1 = w.makeTab("t1");
  await w.advance(60000);
  const f0 = w.requestCount;
  const t3 = w.makeTab("t3", { broken: true, intervalOffset: 13000 });
  await w.advance(25000);
  expect(Math.abs(t3.err())).toBeLessThan(250);
  // constructor call + 20s kick: with no shared window, its own Sample is due
  expect(w.requestCount - f0).toBe(2);
  expect(Math.abs(t1.err())).toBeLessThan(200); // healthy tab unaffected
});

test("gives up quietly when serverTimeService never appears", async () => {
  const w = createWorld({ seed: 12 });
  const t = w.makeTab("t1", { noService: true });
  await w.advance(40000); // past the 30s wait-for-service deadline
  expect(w.requestCount).toBe(0);
  expect(t.win.__timeSync).toBeUndefined();
});
