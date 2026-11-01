import { test, expect, describe } from "bun:test";

import { collectResources, cpuPercent, createResourcesHandler, MIN_WINDOW_MS } from "./resources.js";

const START_MS = 1_793_550_000_000;

/**
 * Fake-Datenquellen mit steuerbarer Uhr und CPU-Zeit.
 *
 * @param {{ cpuCount?: number, failSystem?: boolean }} [options]
 */
function createHarness({ cpuCount = 1, failSystem = false } = {}) {
  let currentMs = START_MS;
  let cpuMicros = 0;
  let fail = failSystem;

  const handler = createResourcesHandler({
    memoryUsage: () => ({ rss: 50_000_000, heapTotal: 8_000_000, heapUsed: 6_000_000, external: 1_000, arrayBuffers: 500 }),
    cpuUsage: () => ({ user: cpuMicros, system: 0 }),
    processUptime: () => 10,
    system: () => {
      if (fail) {
        throw new Error("Systemwerte nicht lesbar");
      }
      return { loadavg: [0.5, 0.25, 0.125], totalmem: 4_000, freemem: 1_000, cpuCount, uptime: 3600, platform: "linux" };
    },
    now: () => currentMs,
    pid: 4242,
    bunVersion: "9.9.9",
  });

  return {
    handler,
    /** @param {number} ms */
    advance(ms) {
      currentMs += ms;
    },
    /** @param {number} micros */
    burn(micros) {
      cpuMicros += micros;
    },
    /** @param {boolean} value */
    setFail(value) {
      fail = value;
    },
  };
}

/** @param {Response} response */
async function body(response) {
  return /** @type {any} */ (await response.json());
}

describe("collectResources", () => {
  const raw = {
    nowMs: START_MS,
    pid: 1,
    bunVersion: "1.4.4",
    memory: { rss: 1234.4, heapTotal: 200, heapUsed: 100, external: 10, arrayBuffers: 5 },
    cpu: { user: 1_500_000, system: 500_000 },
    uptimeSec: 10,
    system: { loadavg: [0.091, 0.034, 0.046], totalmem: 4_000, freemem: 1_000, cpuCount: 4, uptime: 2286, platform: "linux" },
  };

  test("liefert alle Felder mit den richtigen Einheiten", () => {
    const result = collectResources(raw, { percent: null, windowMs: null });

    expect(result.timestamp).toBe(new Date(START_MS).toISOString());
    expect(result.process).toEqual({
      pid: 1,
      uptimeSec: 10,
      runtime: { bun: "1.4.4" },
      memory: { rssBytes: 1234, heapUsedBytes: 100, heapTotalBytes: 200, externalBytes: 10, arrayBuffersBytes: 5 },
      cpu: { userMs: 1500, systemMs: 500, percentSinceStart: 5, percentRecent: null, recentWindowMs: null },
    });
    expect(result.system).toEqual({
      platform: "linux",
      cpuCount: 4,
      uptimeSec: 2286,
      loadAverage: { "1m": 0.09, "5m": 0.03, "15m": 0.05 },
      memory: { totalBytes: 4_000, freeBytes: 1_000, usedBytes: 3_000, usedPercent: 75 },
    });
  });

  test("percentSinceStart ist 0 bei Laufzeit 0", () => {
    const result = collectResources({ ...raw, uptimeSec: 0 }, { percent: null, windowMs: null });
    expect(result.process.cpu.percentSinceStart).toBe(0);
  });

  test("usedPercent ist 0 ohne Gesamtspeicher", () => {
    const result = collectResources(
      { ...raw, system: { ...raw.system, totalmem: 0, freemem: 0 } },
      { percent: null, windowMs: null },
    );
    expect(result.system.memory.usedPercent).toBe(0);
  });
});

describe("cpuPercent", () => {
  test("rechnet als Anteil an der Gesamt-CPU", () => {
    expect(cpuPercent(2000, 10_000, 4)).toBe(5);
    expect(cpuPercent(1000, 2000, 1)).toBe(50);
  });

  test("liefert 0 bei leerem Fenster oder ohne CPUs", () => {
    expect(cpuPercent(100, 0, 4)).toBe(0);
    expect(cpuPercent(100, 1000, 0)).toBe(0);
  });
});

describe("createResourcesHandler", () => {
  test("antwortet mit 200, JSON und no-store", async () => {
    const { handler } = createHarness();
    const response = handler();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const data = await body(response);
    expect(data.timestamp).toBe(new Date(START_MS).toISOString());
    expect(data.process.pid).toBe(4242);
    expect(data.process.runtime.bun).toBe("9.9.9");
  });

  test("percentRecent: null beim ersten Aufruf, dann Fenster ab MIN_WINDOW_MS", async () => {
    const h = createHarness();

    const first = await body(h.handler());
    expect(first.process.cpu.percentRecent).toBeNull();
    expect(first.process.cpu.recentWindowMs).toBeNull();

    h.advance(2000);
    h.burn(1_000_000);
    const second = await body(h.handler());
    expect(second.process.cpu.percentRecent).toBe(50);
    expect(second.process.cpu.recentWindowMs).toBe(2000);

    // Zu kurzes Fenster: letzter Wert wird wiederverwendet, Sample bleibt.
    h.advance(200);
    h.burn(200_000);
    const third = await body(h.handler());
    expect(third.process.cpu.percentRecent).toBe(50);
    expect(third.process.cpu.recentWindowMs).toBe(2000);

    // Mehr als MIN_WINDOW_MS nach dem zweiten Aufruf: neu berechnet, inklusive
    // der CPU-Zeit aus dem dritten Aufruf.
    h.advance(MIN_WINDOW_MS);
    const fourth = await body(h.handler());
    expect(fourth.process.cpu.recentWindowMs).toBe(200 + MIN_WINDOW_MS);
    expect(fourth.process.cpu.percentRecent).toBe(16.7);
  });

  test("percentRecent wird auf die CPU-Anzahl normiert", async () => {
    const h = createHarness({ cpuCount: 4 });
    h.handler();
    h.advance(1000);
    h.burn(1_000_000);
    const data = await body(h.handler());
    expect(data.process.cpu.percentRecent).toBe(25);
  });

  test("antwortet mit 500, wenn eine Datenquelle wirft, und erholt sich danach", async () => {
    const h = createHarness({ failSystem: true });

    const failed = h.handler();
    expect(failed.status).toBe(500);
    expect(failed.headers.get("cache-control")).toBe("no-store");
    expect(await body(failed)).toEqual({ error: "resources_unavailable", detail: "Systemwerte nicht lesbar" });

    h.setFail(false);
    expect(h.handler().status).toBe(200);
  });

  test("Smoke-Test mit den echten Datenquellen", async () => {
    const response = createResourcesHandler()();
    expect(response.status).toBe(200);

    const data = await body(response);
    expect(data.process.memory.rssBytes).toBeGreaterThan(0);
    expect(data.system.cpuCount).toBeGreaterThanOrEqual(1);
    expect(data.process.pid).toBe(process.pid);

    const numbers = [
      ...Object.values(data.process.memory),
      data.process.cpu.userMs,
      data.process.cpu.systemMs,
      data.process.cpu.percentSinceStart,
      data.process.uptimeSec,
      ...Object.values(data.system.loadAverage),
      ...Object.values(data.system.memory),
      data.system.uptimeSec,
    ];
    for (const value of numbers) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});
