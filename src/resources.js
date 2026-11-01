/**
 * Route-Handler fuer GET /resources: Momentaufnahme des Ressourcenverbrauchs
 * von Bun-Prozess und System.
 *
 * Die CPU-Auslastung der letzten Zeit wird aus der Differenz zum zuletzt
 * gespeicherten Sample berechnet - ohne Hintergrund-Timer und ohne Wartezeit
 * im Request. Ein Sample wird erst ersetzt, wenn es mindestens
 * MIN_WINDOW_MS alt ist, damit kein Wert aus einem Rauschfenster von wenigen
 * Millisekunden entsteht.
 */

import os from "node:os";

export const MIN_WINDOW_MS = 1000;

/**
 * @typedef {object} SystemInfo
 * @property {number[]} loadavg Load Average ueber 1, 5 und 15 Minuten.
 * @property {number} totalmem Gesamter Arbeitsspeicher in Bytes.
 * @property {number} freemem Freier Arbeitsspeicher in Bytes.
 * @property {number} cpuCount Anzahl nutzbarer CPUs.
 * @property {number} uptime Laufzeit des Systems in Sekunden.
 * @property {string} platform Betriebssystem, z. B. "linux".
 */

/**
 * @typedef {object} RawResources
 * @property {number} nowMs Aktuelle Zeit in Unix-Millisekunden.
 * @property {number} pid Prozess-ID.
 * @property {string} bunVersion Version der Bun-Runtime.
 * @property {{ rss: number, heapTotal: number, heapUsed: number, external: number, arrayBuffers: number }} memory
 * @property {{ user: number, system: number }} cpu CPU-Zeit in Mikrosekunden.
 * @property {number} uptimeSec Laufzeit des Prozesses in Sekunden.
 * @property {SystemInfo} system
 */

/**
 * @typedef {object} RecentCpu
 * @property {number | null} percent Anteil an der Gesamt-CPU im Fenster.
 * @property {number | null} windowMs Laenge des Fensters.
 */

/**
 * @param {number} value
 * @param {number} digits
 * @returns {number}
 */
function round(value, digits) {
  return Number(value.toFixed(digits));
}

/**
 * Anteil an der Gesamt-CPU des Systems in Prozent (0-100).
 *
 * @param {number} cpuMs verbrauchte CPU-Zeit
 * @param {number} wallMs vergangene Zeit
 * @param {number} cpuCount Anzahl CPUs
 * @returns {number}
 */
export function cpuPercent(cpuMs, wallMs, cpuCount) {
  if (wallMs <= 0 || cpuCount <= 0) {
    return 0;
  }
  return round((cpuMs / (wallMs * cpuCount)) * 100, 1);
}

/**
 * Baut die Antwort fuer GET /resources aus Rohwerten. Reine Funktion.
 *
 * @param {RawResources} raw
 * @param {RecentCpu} recent
 */
export function collectResources(raw, recent) {
  const userMs = round(raw.cpu.user / 1000, 3);
  const systemMs = round(raw.cpu.system / 1000, 3);
  const { system } = raw;
  const usedBytes = system.totalmem - system.freemem;

  return {
    timestamp: new Date(raw.nowMs).toISOString(),
    process: {
      pid: raw.pid,
      uptimeSec: round(raw.uptimeSec, 3),
      runtime: { bun: raw.bunVersion },
      memory: {
        rssBytes: Math.round(raw.memory.rss),
        heapUsedBytes: Math.round(raw.memory.heapUsed),
        heapTotalBytes: Math.round(raw.memory.heapTotal),
        externalBytes: Math.round(raw.memory.external),
        arrayBuffersBytes: Math.round(raw.memory.arrayBuffers),
      },
      cpu: {
        userMs,
        systemMs,
        percentSinceStart: cpuPercent(userMs + systemMs, raw.uptimeSec * 1000, system.cpuCount),
        percentRecent: recent.percent,
        recentWindowMs: recent.windowMs,
      },
    },
    system: {
      platform: system.platform,
      cpuCount: system.cpuCount,
      uptimeSec: round(system.uptime, 3),
      loadAverage: {
        "1m": round(system.loadavg[0] ?? 0, 2),
        "5m": round(system.loadavg[1] ?? 0, 2),
        "15m": round(system.loadavg[2] ?? 0, 2),
      },
      memory: {
        totalBytes: system.totalmem,
        freeBytes: system.freemem,
        usedBytes,
        usedPercent: system.totalmem > 0 ? round((usedBytes / system.totalmem) * 100, 1) : 0,
      },
    },
  };
}

/**
 * @returns {SystemInfo}
 */
function readSystem() {
  return {
    loadavg: os.loadavg(),
    totalmem: os.totalmem(),
    freemem: os.freemem(),
    cpuCount: os.availableParallelism(),
    uptime: os.uptime(),
    platform: process.platform,
  };
}

/**
 * Baut den Handler fuer GET /resources. Die Datenquellen sind Parameter, damit
 * Tests ohne echte Prozesswerte und ohne echte Uhr laufen koennen.
 *
 * @param {{
 *   memoryUsage?: () => RawResources["memory"],
 *   cpuUsage?: () => RawResources["cpu"],
 *   processUptime?: () => number,
 *   system?: () => SystemInfo,
 *   now?: () => number,
 *   pid?: number,
 *   bunVersion?: string,
 * }} [options]
 * @returns {() => Response}
 */
export function createResourcesHandler({
  memoryUsage = () => process.memoryUsage(),
  cpuUsage = () => process.cpuUsage(),
  processUptime = () => process.uptime(),
  system = readSystem,
  now = () => Date.now(),
  pid = process.pid,
  bunVersion = Bun.version,
} = {}) {
  /** @type {{ atMs: number, cpuMicros: number } | null} */
  let sample = null;
  /** @type {RecentCpu} */
  let lastRecent = { percent: null, windowMs: null };

  /**
   * Aktualisiert das Sample und liefert die CPU-Auslastung der letzten Zeit.
   *
   * @param {number} atMs
   * @param {number} cpuMicros
   * @param {number} cpuCount
   * @returns {RecentCpu}
   */
  function recentCpu(atMs, cpuMicros, cpuCount) {
    if (sample === null) {
      sample = { atMs, cpuMicros };
      return lastRecent;
    }

    const windowMs = atMs - sample.atMs;
    if (windowMs < MIN_WINDOW_MS) {
      return lastRecent;
    }

    lastRecent = {
      percent: cpuPercent((cpuMicros - sample.cpuMicros) / 1000, windowMs, cpuCount),
      windowMs,
    };
    sample = { atMs, cpuMicros };
    return lastRecent;
  }

  return function handleResources() {
    try {
      const nowMs = now();
      const cpu = cpuUsage();
      const systemInfo = system();
      /** @type {RawResources} */
      const raw = {
        nowMs,
        pid,
        bunVersion,
        memory: memoryUsage(),
        cpu,
        uptimeSec: processUptime(),
        system: systemInfo,
      };
      const recent = recentCpu(nowMs, cpu.user + cpu.system, systemInfo.cpuCount);

      return Response.json(collectResources(raw, recent), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      return Response.json(
        { error: "resources_unavailable", detail: error instanceof Error ? error.message : String(error) },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
  };
}
