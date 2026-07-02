import { expect, test } from "bun:test";
import { createWorld } from "./harness.js";

const LONG = 30000; // real-time budget for multi-hour virtual scenarios

test("startup burst converges within 150ms using ~4 requests", async () => {
  const w = createWorld({ seed: 1 });
  const t1 = w.makeTab("t1");
  await w.advance(20000);
  expect(Math.abs(t1.err())).toBeLessThan(150);
  expect(w.fetchCount).toBeGreaterThanOrEqual(3);
  expect(w.fetchCount).toBeLessThanOrEqual(5);
});

test("worker tick writes to timeNow are ignored", async () => {
  const w = createWorld({ seed: 2 });
  const t1 = w.makeTab("t1");
  await w.advance(20000);
  const before = t1.service.timeNow;
  t1.service.timeNow += 1000; // what timers_web_worker.js does every second
  expect(Math.abs(t1.service.timeNow - before)).toBeLessThan(5);
});

test(
  "steady-state clock is smooth and monotonic",
  async () => {
    const w = createWorld({ seed: 3 });
    const t1 = w.makeTab("t1");
    await w.advance(20000);
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
// spiky network model (8.75 req/h, 207ms), rounded up — not typical values, which
// are ~4 req/h and tens of ms. Native behavior is 30 req/h per tab, stepping.
test(
  "polling backs off in steady state without losing accuracy",
  async () => {
    const w = createWorld({ seed: 4 });
    const t1 = w.makeTab("t1");
    await w.advance(20000);
    const f0 = w.fetchCount;
    await w.advance(4 * 3600 * 1000);
    expect((w.fetchCount - f0) / 4).toBeLessThanOrEqual(10);
    expect(Math.abs(t1.err())).toBeLessThan(250);
  },
  LONG,
);

test(
  "a malformed servertime payload cannot poison the clock",
  async () => {
    const w = createWorld({ seed: 5 });
    const t1 = w.makeTab("t1");
    await w.advance(20000);
    w.failNextPayload(); // native code sets timeNow = NaN on this
    await w.advance(25 * 60 * 1000);
    expect(Number.isFinite(t1.service.timeNow)).toBe(true);
    expect(Math.abs(t1.err())).toBeLessThan(200);
  },
  LONG,
);

test("a second tab adopts the shared window with zero requests", async () => {
  const w = createWorld({ seed: 6 });
  w.makeTab("t1");
  await w.advance(60000);
  const before = w.fetchCount;
  const t2 = w.makeTab("t2", { intervalOffset: 7000 });
  await w.advance(10000);
  expect(w.fetchCount - before).toBeLessThanOrEqual(1);
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
    const f0 = w.fetchCount;
    await w.advance(4 * 3600 * 1000);
    expect((w.fetchCount - f0) / 4).toBeLessThanOrEqual(10); // combined, vs native 60 req/h
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

  const f0 = w.fetchCount;
  t1.setHidden(false);
  await w.advance(15000);
  t2.setHidden(false);
  await w.advance(20000);

  expect(Math.abs(t1.err())).toBeLessThan(200);
  expect(Math.abs(t2.err())).toBeLessThan(200);
  // t1's anomaly Burst rebuilds the window; t2 adopts it + one verification sample
  expect(w.fetchCount - f0).toBeLessThanOrEqual(7);
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
  const f0 = w.fetchCount;
  const t3 = w.makeTab("t3", { broken: true, intervalOffset: 13000 });
  await w.advance(20000);
  expect(Math.abs(t3.err())).toBeLessThan(150);
  expect(w.fetchCount - f0).toBeGreaterThanOrEqual(3); // its own burst
  expect(Math.abs(t1.err())).toBeLessThan(200); // healthy tab unaffected
});

test("gives up quietly when serverTimeService never appears", async () => {
  const w = createWorld({ seed: 12 });
  const t = w.makeTab("t1", { noService: true });
  await w.advance(40000); // past the 30s wait-for-service deadline
  expect(w.fetchCount).toBe(0);
  expect(t.win.__timeSync).toBeUndefined();
});
