# Beachmap MCP server

Remote [Model Context Protocol](https://modelcontextprotocol.io) server for **[World Beach Map](https://beachmapworld.com)** — beaches worldwide from Wikidata, each with **twelve monthly sea-surface temperatures** from NOAA OISST v2.1, its shore type, its Wikipedia article and its photograph credit.

Free, read-only, no key or account. Listed in the [official MCP registry](https://registry.modelcontextprotocol.io) as `com.europebeachmap/beachmap` — the namespace keeps the site's former domain, because a registry namespace is bound to the name it was verified under and cannot be renamed. The old endpoint, `https://europebeachmap.com/mcp`, therefore keeps answering rather than redirecting: a JSON-RPC client reads a 301 as a protocol error, not as a new address.

## Endpoint

```
https://beachmapworld.com/mcp
```

Streamable HTTP transport, stateless, no authentication.

**Claude Code:**

```bash
claude mcp add --transport http beachmap https://beachmapworld.com/mcp
```

**Claude / ChatGPT / other clients with remote MCP support** — add `https://beachmapworld.com/mcp` as a custom connector, or use the generic config:

```json
{ "mcpServers": { "beachmap": { "type": "http", "url": "https://beachmapworld.com/mcp" } } }
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
curl -o beaches.json https://beachmapworld.com/data/beaches.json
BEACHES_PATH=./beaches.json PORT=8765 node server.mjs
# MCP endpoint on http://127.0.0.1:8765/mcp
```

## Data & licence

- **Code:** MIT (this repository).
- **Data:** beach records from [Wikidata](https://www.wikidata.org) (CC0), sea temperature from [NOAA OISST v2.1](https://www.ncei.noaa.gov/products/optimum-interpolation-sst) (public domain). A credit and a link to [beachmapworld.com](https://beachmapworld.com) are appreciated, not required. Each beach carries **twelve monthly means** (the 1991–2020 long-term monthly mean), sampled at the nearest grid cell that is open water in all twelve months.
- Dataset downloads: [JSON](https://beachmapworld.com/data/beaches.json) · [CSV](https://beachmapworld.com/data/beaches.csv) · [GeoJSON](https://beachmapworld.com/data/beaches.geojson)

Citation:

```
Beach data: Beachmap (https://beachmapworld.com), Wikidata CC0 · NOAA public domain
```
