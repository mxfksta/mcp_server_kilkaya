# Kilkaya MCP Server

Ein [MCP](https://modelcontextprotocol.io)-Server (Model Context Protocol) für die
[Kilkaya](https://kilkaya.com)-Analytics-API. Er stellt Kilkayas Query-, Schema- und
Metadata-Endpunkte als MCP-Tools bereit, läuft über Streamable HTTP (stateless) und ist
für das Hosting auf **Google Cloud Run** ausgelegt.

## Tools

Standardmäßig aktiv (read-only):

| Tool | Kilkaya-Endpunkt | Beschreibung |
| --- | --- | --- |
| `kilkaya_query` | `POST /api/query` | Analytics-Query (Haupt-API). Antwort im JSON:API-Format. 202-Antworten („Query queued/running") werden automatisch alle 2,5 s neu gesendet, bis das Ergebnis da ist (Timeout konfigurierbar). |
| `kilkaya_list_schemas` | `GET /api/schemas` | Verfügbare Schemas inkl. Felddefinitionen. `allfields` ist die verbindliche Liste gültiger Felder, `timefields` (`_minute`, `_day`, `_month`, …) können als Spalten für Zeitaggregation ergänzt werden. |
| `kilkaya_get_metadata` | `GET /api/metadata` | Metadaten für eine Artikel-URL (ohne Protokoll). |
| `kilkaya_get_metadata_bulk` | `POST /api/metadata` | Metadaten für viele URLs auf einmal. |

Optional per Env-Flag:

| Tool | Flag | Beschreibung |
| --- | --- | --- |
| `kilkaya_set_metadata` | `KILKAYA_ENABLE_WRITE_TOOLS=true` | Schreibt/aktualisiert Artikel-Metadaten (`POST /api/metadata/set`). |
| `kilkaya_list_users`, `kilkaya_get_user`, `kilkaya_list_roles`, `kilkaya_get_role` | `KILKAYA_ENABLE_ADMIN_TOOLS=true` | Read-only User-/Rollen-Verwaltung. Standardmäßig aus, da Userdaten E-Mail-Adressen enthalten. |

Destruktive Endpunkte (User/Rollen anlegen, ändern, löschen) sind bewusst **nicht**
als Tools implementiert.

## Konfiguration (Umgebungsvariablen)

| Variable | Pflicht | Beschreibung |
| --- | --- | --- |
| `KILKAYA_API_TOKEN` | ✅ | Kilkaya API Access Token. Wird als `Authorization: Bearer <token>` an die API gesendet. In Cloud Run über Secret Manager setzen, nicht als Klartext-Env. |
| `MCP_AUTH_TOKEN` | empfohlen | Shared Secret zum Schutz des `/mcp`-Endpunkts. Clients müssen `Authorization: Bearer <token>` mitschicken. Ohne diese Variable ist der Endpunkt ungeschützt — dann Cloud Run **nicht** mit `--allow-unauthenticated` deployen. |
| `PORT` | – | HTTP-Port (Default `8080`; wird von Cloud Run automatisch gesetzt). |
| `KILKAYA_BASE_URL` | – | Default `https://api.kilkaya.com`. |
| `KILKAYA_QUERY_TIMEOUT_MS` | – | Wie lange auf ein 202-„Query delayed" gepollt wird (Default `90000`). Läuft der Timeout ab, liefert das Tool den Queue-Status zurück; derselbe Query kann einfach erneut abgeschickt werden. |
| `KILKAYA_ENABLE_WRITE_TOOLS` | – | `true` aktiviert `kilkaya_set_metadata`. |
| `KILKAYA_ENABLE_ADMIN_TOOLS` | – | `true` aktiviert die read-only User-/Rollen-Tools. |

## Lokal starten

```bash
npm install
npm run build
KILKAYA_API_TOKEN=<token> npm start
# Healthcheck
curl http://localhost:8080/healthz
```

MCP-Endpunkt: `POST http://localhost:8080/mcp` (Streamable HTTP, stateless — keine
Sessions, kein SSE-Stream vom Server; `GET`/`DELETE /mcp` antworten mit 405).

## Deployment auf Google Cloud Run

```bash
PROJECT=<gcp-projekt>
REGION=europe-west3

# 1. Token als Secret hinterlegen
echo -n "<kilkaya-api-token>" | gcloud secrets create kilkaya-api-token \
  --project "$PROJECT" --data-file=-
echo -n "<selbst-generiertes-shared-secret>" | gcloud secrets create kilkaya-mcp-auth-token \
  --project "$PROJECT" --data-file=-

# 2. Bauen & deployen (Cloud Build baut das Dockerfile)
gcloud run deploy kilkaya-mcp \
  --project "$PROJECT" --region "$REGION" \
  --source . \
  --set-secrets "KILKAYA_API_TOKEN=kilkaya-api-token:latest,MCP_AUTH_TOKEN=kilkaya-mcp-auth-token:latest" \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 3 --memory 256Mi
```

`--allow-unauthenticated` ist hier okay, weil `MCP_AUTH_TOKEN` den Endpunkt schützt.
Alternativ das Flag weglassen und Cloud-Run-IAM nutzen (Clients senden dann ein
Google-ID-Token) — dann kann `MCP_AUTH_TOKEN` entfallen.

Der Server ist stateless (ein frischer MCP-Server pro Request), daher sind beliebige
Instanzzahlen inkl. Scale-to-zero unproblematisch.

## Client-Konfiguration

Beispiel für Claude Code (`.mcp.json`) oder andere MCP-Clients mit Streamable HTTP:

```json
{
  "mcpServers": {
    "kilkaya": {
      "type": "http",
      "url": "https://kilkaya-mcp-<hash>-<region>.a.run.app/mcp",
      "headers": {
        "Authorization": "Bearer <selbst-generiertes-shared-secret>"
      }
    }
  }
}
```

## Beispiel-Query

Typischer Ablauf für ein LLM: erst `kilkaya_list_schemas` aufrufen, um Schema und
gültige Felder zu ermitteln, dann `kilkaya_query`:

```json
{
  "schemaname": "pageviews",
  "datefrom": "2026-07-01T00:00:00+00:00",
  "dateto": "2026-07-06T00:00:00+00:00",
  "columns": ["url", "pageviews", "section", "_day"],
  "filters": [
    { "column": "url", "operator": "like", "value": "*example.de*" }
  ],
  "sortby": ["pageviews"],
  "sortorder": ["desc"],
  "limit": 100
}
```

Filter-Operatoren: `like`, `notlike`, `greater`, `less`. Wildcards mit `*` (nicht `%`).

## Projektstruktur

```
src/
  index.ts    – Express-App, Streamable-HTTP-Transport, Auth, /healthz
  server.ts   – MCP-Server- und Tool-Definitionen
  kilkaya.ts  – HTTP-Client für die Kilkaya-API inkl. 202-Polling
Dockerfile    – Multi-Stage-Build (Node 22 Alpine)
```
