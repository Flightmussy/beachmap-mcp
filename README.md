# Beachmap MCP server

Remote [Model Context Protocol](https://modelcontextprotocol.io) server for **[Beachmap](https://europebeachmap.com)** — 511 of Europe's best beaches across 31 countries, each with its sea-surface temperature (°C, from NOAA OISST), sand type, best months, swimming conditions, surf quality, setting and Blue Flag status.

Free, read-only, no key or account. Listed in the [official MCP registry](https://registry.modelcontextprotocol.io) as `com.europebeachmap/beachmap`.

## Endpoint

```
https://europebeachmap.com/mcp
```

Streamable HTTP transport, stateless, no authentication.

**Claude Code:**

```bash
claude mcp add --transport http beachmap https://europebeachmap.com/mcp
```

**Claude / ChatGPT / other clients with remote MCP support** — add `https://europebeachmap.com/mcp` as a custom connector, or use the generic config:

```json
{ "mcpServers": { "beachmap": { "type": "http", "url": "https://europebeachmap.com/mcp" } } }
```

## Tools

| Tool | Does | Example question it answers |
|---|---|---|
| `search_beaches` | Search + filter all beaches: free text, country, category, sand, Blue Flag, min sea temperature, month in season | "Blue Flag white-sand beaches with sea over 25°C" |
| `get_beach` | Full profile of one beach by id or name | "Tell me about Ksamil Beaches" |
| `warmest_beaches` | Beaches ranked by typical warm-season sea temperature | "Where is the sea warmest in Portugal in October?" |
| `beaches_best_in_month` | Beaches whose best-time window includes a month | "Where should I go to the beach in October?" |

## Run it yourself

The server reads the open Beachmap dataset from disk:

```bash
npm install
curl -o beaches.json https://europebeachmap.com/data/beaches.json
BEACHES_PATH=./beaches.json PORT=8765 node server.mjs
# MCP endpoint on http://127.0.0.1:8765/mcp
```

## Data & licence

- **Code:** MIT (this repository).
- **Data:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — credit "Beachmap" and link to [europebeachmap.com](https://europebeachmap.com). Sea temperatures are the 30-year (1995–2024) mean mid-August SST from NOAA OISST v2.1 (public domain), sampled at each beach's nearest ocean cell.
- Dataset downloads: [JSON](https://europebeachmap.com/data/beaches.json) · [CSV](https://europebeachmap.com/data/beaches.csv) · [GeoJSON](https://europebeachmap.com/data/beaches.geojson)
- Docs page: [europebeachmap.com/mcp-server](https://europebeachmap.com/mcp-server/)

Citation:

```
Beach data: Beachmap (https://europebeachmap.com), CC BY 4.0
```
