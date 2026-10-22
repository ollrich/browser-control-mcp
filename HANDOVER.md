# Handover: browser-control-mcp Fork (ollrich)

Stand: 22.10.2026. Arbeitsbranch `ollie/workflow-tools`, Version `1.6.1-ollie.1`.

## Worum es geht

Firefox MCP für die tägliche Arbeit mit Claude: offene Tabs und live gerenderte Seiten lesen, wenn ein normaler Web Fetch veraltete oder leere Inhalte liefert.

Kette der Repos:

- `eyalzh/browser-control-mcp`: Original. Der Maintainer merged seit Monaten keine PRs.
- `kkugot/browser-control-mcp` (Remote `upstream`): behebt den Portkonflikt auf 8089 mit einem Singleton Broker. Siehe eyalzh Issue #53. Damit funktioniert das Plugin in mehreren Sessions gleichzeitig (Chat, Cowork, Code).
- `ollrich/browser-control-mcp` (Remote `origin`): unser Fork mit eigenen Workflow Tools.

## Was der Fork ergänzt

Alles liegt im MCP Server. Die Firefox Extension ist unverändert, es reicht die Version von addons.mozilla.org. Eine eigene signierte XPI ist nicht nötig.

1. **`read-tab`**: liest einen Tab in einem Aufruf, per URL oder Titelfragment (`match`), per `tabId` oder ohne Argumente den zuletzt genutzten Tab. Gibt es mehrere Treffer, gewinnt eine exakte URL, sonst der zuletzt genutzte Tab. Die übrigen Treffer werden mit aufgelistet.
2. **`open-and-read-tab`**: öffnet eine https URL und fragt `get-tab-list` ab, bis der Tab `status: complete` meldet. Danach wartet es `settleMs` und liest. Kommen weniger als 300 Zeichen zurück (leere SPA Hülle, zum Beispiel X oder Bluesky), liest es nach einer weiteren Pause noch einmal. Optional `closeAfter`.
3. **Schlanke Ausgabe** für beide Tools: Leerraum wird zusammengefasst, Links sind standardmäßig aus. Mit `includeLinks: true` kommen sie dedupliziert (Hash und Slash am Ende ignoriert, Selbstlinks entfernt) und gedeckelt (`maxLinks`). Dazu optional `maxChars`.
4. `get-tab-web-content` hat zusätzlich `includeLinks` (Standard true, Verhalten unverändert).

Die neuen Tools nutzen nur `open-tab`, `get-tab-list`, `get-tab-content` und `close-tabs`. Dadurch laufen sie mit der AMO Extension und auch über Broker Forwarding.

### Geänderte Dateien

- `mcp-server/content-utils.ts` (neu): `compactText`, `slimLinks`, `slimContent`, `matchTabs`, `formatTabLine`
- `mcp-server/server.ts`: beide Tools unten vor `new BrowserAPI()`, `includeLinks` bei `get-tab-web-content`, Version
- `common/extension-messages.ts`: `status?` in `BrowserTab` (Firefox schickt das komplette `tabs.Tab` Objekt mit)
- `mcp-server/manifest.json`, `mcp-server/package.json`: Version und Tool Liste
- `mcp-server/__tests__/content-utils.test.mjs`, `mcp-server/__tests__/workflow-tools.test.mjs` (neu)
- `CHANGELOG.md`, `README.md` (Abschnitt "Fork additions")

## Bauen und testen

```bash
cd mcp-server
npm install
npx tsc
node --test --test-timeout=60000 __tests__/*.test.mjs
```

Nicht `npm test` verwenden: Der bestehende Upstream Test "BrowserAPI close disconnects the accepted extension WebSocket" hat eine Race Condition (verbindet, bevor der Server lauscht). Er schlägt fehl und hält ohne Timeout den ganzen Lauf an. Mit unseren Änderungen hat das nichts zu tun. Der Stand ist 21 von 22 grün, der rote ist dieser Test.

`workflow-tools.test.mjs` ist der wichtigste Test. Er startet echte Serverprozesse über stdio, simuliert eine Extension, die nur die Original Befehle kennt (inklusive Ladezustand und SPA Hülle), und prüft eine zweite Session als Forwarder.

## DXT für Claude Desktop packen

`common` wird nur für Typen importiert (`import type`). Zur Laufzeit wird es nicht gebraucht und muss aus den Abhängigkeiten im Bundle raus.

```bash
STAGE=$(mktemp -d)
cp -r mcp-server/manifest.json mcp-server/dist LICENSE "$STAGE"/
# package.json ohne "@browser-control-mcp/common", ohne devDependencies und scripts nach $STAGE schreiben
cd "$STAGE" && npm install --omit=dev
npx @anthropic-ai/dxt validate manifest.json
npx @anthropic-ai/dxt pack . ~/firefox-control-<version>.dxt
```

Das Paket `@anthropic-ai/dxt` heißt inzwischen `@anthropic-ai/mcpb`, die alte Version funktioniert noch. Die gebaute `firefox-control-1.6.1-ollie.1.dxt` liegt im Claude Chat vom 20.10.2026.

## In Claude Code einbinden

```bash
claude mcp add browser-control \
  -e EXTENSION_SECRET=<Secret aus den Add-on Einstellungen> \
  -e EXTENSION_PORT=8089 \
  -- node /pfad/zum/repo/mcp-server/dist/server.js
```

Läuft Claude Desktop mit der DXT parallel, wird die erste Instanz Broker und alle weiteren leiten weiter. Voraussetzung sind gleicher Port und gleiches Secret. Broker Metadaten liegen unter `~/.cache/browser-control-mcp/`. Debug Logs gibt es mit `BROWSER_MCP_DEBUG=1`.

## Bekannte Punkte

- **Gegen echtes Firefox noch nicht getestet.** Alle Tests laufen gegen eine simulierte Extension. Das ist der erste offene Schritt.
- `get-current-tab` und `get-tab-metadata` (von kkugot) brauchen dessen Extension Build. Mit der AMO Extension laufen sie nach 5 s ins Timeout (`EXTENSION_RESPONSE_TIMEOUT_MS` in `browser-api.ts`). Ersatz für den aktiven Tab: `read-tab` ohne Argumente.
- `read-tab` ohne Argumente nimmt den zuletzt genutzten Tab über `lastAccessed`. Das ist normalerweise der aktive, aber nicht garantiert, wenn mehrere Fenster offen sind.
- `open-and-read-tab` öffnet nur `https://` URLs, das prüft die Extension.
- Die Extension verlangt pro Domain eine Zustimmung. Beim ersten Lesen einer neuen Domain kommt ein Fehler und Firefox öffnet einen Dialog. Nach dem Erlauben einfach wiederholen.
- Wird eine DXT mit anderer Manifest ID installiert, legt Claude Desktop eine Parallelinstallation an statt zu aktualisieren. Dann die alte deaktivieren, sonst sind alle Tools doppelt da.

## Nächste Schritte

1. DXT installieren und einige Tage im Alltag nutzen, besonders `open-and-read-tab` auf X, Bluesky und Paywall Seiten. Werte für `settleMs` und die 300 Zeichen Schwelle danach justieren.
2. Bewährt es sich: `ollie/workflow-tools` nach `main` mergen und ein GitHub Release mit der DXT als Anhang anlegen.
3. Regelmäßig `git fetch upstream` und kkugots Fixes übernehmen.
4. Mögliche Erweiterungen, falls im Alltag Reibung auftritt: Suche im Seitentext ohne kompletten Inhalt (Ausschnitte rund um einen Suchbegriff) und das Lesen mehrerer Tabs in einem Aufruf.

## Leitplanken

- **Keine Interaktionsfunktionen** (Klicken, Formulare, Skripte). Der Wert des Plugins liegt darin, dass es nur liest und pro Domain eine Zustimmung braucht. Nur deshalb ist es gegen das normale Firefox Profil vertretbar.
- Änderungen möglichst nur im Server, damit die AMO Extension reicht.
- Commits mit der GitHub Noreply Adresse `26229613+ollrich@users.noreply.github.com`. Die private Adresse lehnt GitHub beim Push ab.
- Remotes: `origin` ist ollrich, `upstream` ist kkugot. Nie nach `upstream` pushen.
- Ollies Präferenz: keine Gedankenstriche in Texten und Ausgaben.
