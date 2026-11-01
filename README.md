# backend

JavaScript-Backend auf Basis von [Bun](https://bun.com).

## Voraussetzungen

Bun installieren (falls noch nicht vorhanden):

```bash
curl -fsSL https://bun.sh/install | bash
```

## Einrichtung

```bash
bun install
cp .env.example .env
```

## Scripts

| Befehl         | Beschreibung                                    |
| -------------- | ----------------------------------------------- |
| `bun run dev`  | Server mit Hot-Reload starten (`--hot`)         |
| `bun run start`| Server ohne Hot-Reload starten                  |
| `bun test`     | Tests ausführen (`*.test.js`)                   |

Der Server läuft standardmäßig auf http://localhost:3000 (`PORT` in `.env` anpassbar).

## Endpunkte

| Methode | Pfad         | Antwort                                                   |
| ------- | ------------ | --------------------------------------------------------- |
| `GET`   | `/`          | `{ "message": "Hello via Bun!" }`                         |
| `GET`   | `/health`    | `{ "status": "ok" }`                                      |
| `GET`   | `/time`      | Aktuelle UTC-Zeit, per NTP von einem Zeitserver ermittelt |
| `GET`   | `/resources` | Ressourcenverbrauch von Bun-Prozess und System            |

### `GET /time`

Die Zeit kommt nicht aus der ungeprüften Systemuhr, sondern per SNTP
(RFC 5905/4330) von einem Zeitserver:

```json
{
  "iso": "2026-10-14T17:29:37.831Z",
  "unixMs": 1791998977831,
  "source": "ntp",
  "server": "pool.ntp.org",
  "stratum": 2,
  "offsetMs": 3.701,
  "roundtripMs": 14.926,
  "syncedAt": "2026-10-14T17:29:37.827Z"
}
```

`offsetMs` ist die gemessene Abweichung der lokalen Uhr zum Zeitserver,
`syncedAt` der Zeitpunkt des letzten Syncs. Ein Sync versorgt alle Requests
innerhalb von `NTP_CACHE_MS`; dazwischen wird die Zeit aus der lokalen Uhr plus
Offset abgeleitet. Ist kein Zeitserver erreichbar, antwortet der Endpunkt mit
`503` und `{ "error": "ntp_unavailable", "detail": "..." }` statt mit einer
möglicherweise falschen Zeit.

### `GET /resources`

Momentaufnahme des Ressourcenverbrauchs, ermittelt mit Bordmitteln
(`process`, `node:os`, `Bun`):

```json
{
  "timestamp": "2026-11-01T16:54:33.369Z",
  "process": {
    "pid": 2604,
    "uptimeSec": 2.234,
    "runtime": { "bun": "1.4.4" },
    "memory": {
      "rssBytes": 19017728,
      "heapUsedBytes": 238315,
      "heapTotalBytes": 665600,
      "externalBytes": 40315,
      "arrayBuffersBytes": 0
    },
    "cpu": {
      "userMs": 12.499,
      "systemMs": 18.749,
      "percentSinceStart": 0.3,
      "percentRecent": 0.1,
      "recentWindowMs": 1225
    }
  },
  "system": {
    "platform": "linux",
    "cpuCount": 4,
    "uptimeSec": 2561,
    "loadAverage": { "1m": 0.09, "5m": 0.03, "15m": 0.03 },
    "memory": {
      "totalBytes": 4125417472,
      "freeBytes": 2987589632,
      "usedBytes": 1137827840,
      "usedPercent": 27.6
    }
  }
}
```

- **Einheiten:** Speicher in Bytes, CPU-Zeit in Millisekunden, Laufzeiten in
  Sekunden. Prozentwerte sind der Anteil an der Gesamt-CPU des Systems
  (0–100, normiert auf `cpuCount`).
- **`percentSinceStart`:** durchschnittliche Auslastung seit Prozessstart.
- **`percentRecent`:** Auslastung seit dem vorletzten gezählten Abruf, über ein
  Fenster von mindestens einer Sekunde; die Länge steht in `recentWindowMs`.
  Beim ersten Abruf sind beide Felder `null`. Folgt ein Abruf in kürzerem
  Abstand, wird der letzte Wert wiederholt.
- **Speicherwerte des Prozesses** kommen aus JavaScriptCore und sind nicht mit
  Node.js vergleichbar.
- **Systemwerte** beschreiben Host bzw. VM, nicht die Limits eines Containers.
  Unter Windows ist `loadAverage` immer 0.
- Antwort mit `Cache-Control: no-store`; ist eine Datenquelle nicht lesbar,
  antwortet der Endpunkt mit `500` und
  `{ "error": "resources_unavailable", "detail": "..." }`.
- Der Endpunkt ist nicht geschützt und gibt u. a. PID, Laufzeit und
  Bun-Version preis.

## Umgebungsvariablen

| Variable          | Default         | Beschreibung                                                        |
| ----------------- | --------------- | ------------------------------------------------------------------- |
| `PORT`            | `3000`          | Port des HTTP-Servers                                               |
| `NTP_SERVER`      | `pool.ntp.org`  | Hostname des Zeitservers für `/time`                                |
| `NTP_TIMEOUT_MS`  | `3000`          | Wartezeit auf die NTP-Antwort, danach `503`                         |
| `NTP_CACHE_MS`    | `60000`         | Mindestabstand zweier NTP-Syncs; `0` synchronisiert bei jedem Request |

## Struktur

```
src/
  index.js           Einstiegspunkt (Bun.serve)
  index.test.js      Beispieltest (bun:test)
  ntp.js             SNTP-Client (Paketaufbau, Parsing, UDP-Abfrage)
  ntp.test.js        Tests für den SNTP-Client
  time.js            Handler für GET /time samt Offset-Cache
  time.test.js       Tests für Handler und Cache
  resources.js       Handler für GET /resources (Prozess- und Systemwerte)
  resources.test.js  Tests für den Ressourcen-Handler
jsconfig.json        Editor-Autovervollständigung für Bun-APIs
.env.example         Vorlage für Umgebungsvariablen
```
