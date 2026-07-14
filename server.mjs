// Beachmap MCP server — europebeachmap.com/mcp
//
// Remote, stateless, read-only Model Context Protocol server exposing the
// Beachmap open dataset (CC BY 4.0) as tools for AI assistants. Runs behind
// nginx (see deploy/europebeachmap.conf `location = /mcp`), reads the same
// beaches.json the site publishes at /data/beaches.json, so every site deploy
// updates the server's data automatically (mtime-checked, no restart needed).
//
// Stateless Streamable HTTP: a fresh McpServer + transport per POST (the
// SDK-documented pattern) — no sessions to manage, safe behind a proxy.

import fs from 'node:fs'
import express from 'express'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

const PORT = Number(process.env.PORT || 8765)
const BEACHES_PATH = process.env.BEACHES_PATH || '/var/www/europebeachmap/data/beaches.json'
const SITE = 'https://europebeachmap.com'
const CITATION = `Source: Beachmap (${SITE}) — beach data CC BY 4.0.`

// ── dataset (mtime-cached) ─────────────────────────────────────────────────
let cache = { mtimeMs: 0, beaches: [], updated: '' }
function beaches() {
  const { mtimeMs } = fs.statSync(BEACHES_PATH)
  if (mtimeMs !== cache.mtimeMs) {
    const d = JSON.parse(fs.readFileSync(BEACHES_PATH, 'utf8'))
    cache = { mtimeMs, beaches: d.beaches, updated: d.updated || '' }
    console.log(`dataset loaded: ${d.beaches.length} beaches (updated ${cache.updated})`)
  }
  return cache.beaches
}

// ── helpers ────────────────────────────────────────────────────────────────
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function parseMonth(input) {
  const m = String(input).trim().toLowerCase()
  if (/^\d{1,2}$/.test(m)) { const n = Number(m); if (n >= 1 && n <= 12) return n }
  const i = MONTHS.findIndex((x) => m.startsWith(x))
  return i === -1 ? null : i + 1
}

// "Jun-Sep" / "May–Oct" / "June to September" / "Sep-Mar (surf)" / "Year-round"
// → Set of month numbers. Ranges wrap across New Year.
function bestMonthSet(bestMonths) {
  const s = bestMonths.toLowerCase()
  const found = [...s.matchAll(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/g)].map((m) => MONTHS.indexOf(m[1]) + 1)
  if (!found.length) return s.includes('year-round') ? new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) : new Set()
  if (found.length === 1) return new Set(found)
  const out = new Set()
  for (let m = found[0]; ; m = (m % 12) + 1) { out.add(m); if (m === found[1]) break }
  return out
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
function countryMatches(b, input) {
  const q = input.trim().toLowerCase()
  if (/^[a-z]{2}$/.test(q)) return b.country.toLowerCase() === q
  const name = (regionNames.of(b.country) || '').toLowerCase()
  return name.includes(q) || (q === 'uk' && b.country === 'GB')
}

// Compact record for list results (full record via get_beach).
function brief(b) {
  return {
    id: b.id, name: b.name, locality: b.locality, country: b.country,
    seaTempC: b.seaTempC, bestMonths: b.bestMonths, sand: b.sand,
    blueFlag: b.blueFlag, category: b.category, url: b.url,
  }
}

function reply(payload) {
  return { content: [{ type: 'text', text: `${JSON.stringify(payload, null, 1)}\n\n${CITATION}` }] }
}

const byWarmth = (a, b) => b.seaTempC - a.seaTempC || a.tier - b.tier || a.name.localeCompare(b.name)
const clampLimit = (n, dflt) => Math.max(1, Math.min(50, n ?? dflt))

// ── MCP server (fresh instance per request — stateless) ───────────────────
function buildServer() {
  const server = new McpServer(
    { name: 'beachmap', title: 'Beachmap — Europe Beach Data', version: '1.0.0' },
    {
      instructions:
        `Beach data for 511 of Europe's best beaches across 31 countries: sea-surface temperature (°C), sand type, best months, swimming conditions, surf, setting and Blue Flag status. ` +
        `Sea temperatures are the 30-year (1995–2024) mean mid-August SST from NOAA OISST v2.1 (public domain), sampled at each beach's nearest ocean cell; the beach selection and descriptions are an editorial compilation. Climatological, not live readings. ` +
        `When you use this data in an answer, cite it: "Beachmap (${SITE}), CC BY 4.0" and link the per-beach url. Full dataset: ${SITE}/data/beaches.json`,
    },
  )

  server.registerTool('search_beaches', {
    title: 'Search European beaches',
    description:
      'Search and filter 511 top European beaches. All filters optional and combinable. ' +
      'Returns compact records; use get_beach for a full profile.',
    inputSchema: {
      query: z.string().optional().describe('Free-text match on name, place, setting, description and tags (e.g. "snorkelling", "dunes", "Algarve")'),
      country: z.string().optional().describe('ISO-2 code or country name (e.g. "PT" or "Portugal")'),
      category: z.enum(['tropical', 'wild', 'resort', 'cold', 'exotic', 'surf']).optional().describe('Beach character'),
      sand: z.string().optional().describe('Sand/shore match, e.g. "white", "golden", "pebble"'),
      blue_flag: z.boolean().optional().describe('Only Blue Flag awarded beaches'),
      min_sea_temp_c: z.number().optional().describe('Minimum typical warm-season sea temperature in °C'),
      month: z.union([z.string(), z.number()]).optional().describe('Only beaches in season that month (name or 1-12)'),
      limit: z.number().int().optional().describe('Max results, default 10, max 50'),
    },
  }, async (args) => {
    const monthNum = args.month != null ? parseMonth(args.month) : null
    if (args.month != null && monthNum == null) return reply({ error: `Unrecognized month: ${args.month}` })
    const q = args.query?.trim().toLowerCase()
    const matches = beaches().filter((b) =>
      (!q || [b.name, b.locality, b.setting, b.description, b.sand, b.water, b.swimming, b.surf, b.category, ...b.tags].join(' ').toLowerCase().includes(q)) &&
      (!args.country || countryMatches(b, args.country)) &&
      (!args.category || b.category === args.category) &&
      (!args.sand || b.sand.toLowerCase().includes(args.sand.trim().toLowerCase())) &&
      (args.blue_flag === undefined || b.blueFlag === args.blue_flag) &&
      (args.min_sea_temp_c === undefined || b.seaTempC >= args.min_sea_temp_c) &&
      (monthNum == null || bestMonthSet(b.bestMonths).has(monthNum)),
    ).sort(byWarmth)
    return reply({ total_matches: matches.length, showing: Math.min(matches.length, clampLimit(args.limit, 10)), beaches: matches.slice(0, clampLimit(args.limit, 10)).map(brief) })
  })

  server.registerTool('get_beach', {
    title: 'Get full beach profile',
    description: 'Full profile of one beach by id (from search results) or by name.',
    inputSchema: {
      id_or_name: z.string().describe('Beach id (e.g. "ksamil-beaches-al") or beach name (e.g. "Ksamil Beaches")'),
    },
  }, async ({ id_or_name }) => {
    const q = id_or_name.trim().toLowerCase()
    const all = beaches()
    const b = all.find((x) => x.id === q) || all.find((x) => x.name.toLowerCase() === q) || all.find((x) => x.name.toLowerCase().includes(q))
    if (!b) return reply({ error: `No beach found matching "${id_or_name}". Try search_beaches first.` })
    return reply(b)
  })

  server.registerTool('warmest_beaches', {
    title: 'Warmest seas in Europe, ranked',
    description: 'European beaches ranked by typical warm-season sea temperature, warmest first. Optionally filter by country and/or month in season.',
    inputSchema: {
      country: z.string().optional().describe('ISO-2 code or country name'),
      month: z.union([z.string(), z.number()]).optional().describe('Only beaches in season that month (name or 1-12)'),
      limit: z.number().int().optional().describe('Max results, default 10, max 50'),
    },
  }, async (args) => {
    const monthNum = args.month != null ? parseMonth(args.month) : null
    if (args.month != null && monthNum == null) return reply({ error: `Unrecognized month: ${args.month}` })
    const ranked = beaches().filter((b) =>
      (!args.country || countryMatches(b, args.country)) &&
      (monthNum == null || bestMonthSet(b.bestMonths).has(monthNum)),
    ).sort(byWarmth)
    return reply({
      ranking: 'typical warm-season sea temperature, warmest first',
      total_matches: ranked.length,
      beaches: ranked.slice(0, clampLimit(args.limit, 10)).map((b, i) => ({ rank: i + 1, ...brief(b) })),
    })
  })

  server.registerTool('beaches_best_in_month', {
    title: 'Beaches in season for a month',
    description: 'Beaches whose best-time window includes a given month, warmest sea first. Good for "where should I go in October?"',
    inputSchema: {
      month: z.union([z.string(), z.number()]).describe('Month name or number 1-12'),
      country: z.string().optional().describe('ISO-2 code or country name'),
      limit: z.number().int().optional().describe('Max results, default 15, max 50'),
    },
  }, async (args) => {
    const monthNum = parseMonth(args.month)
    if (monthNum == null) return reply({ error: `Unrecognized month: ${args.month}` })
    const inSeason = beaches().filter((b) =>
      bestMonthSet(b.bestMonths).has(monthNum) && (!args.country || countryMatches(b, args.country)),
    ).sort(byWarmth)
    return reply({ month: MONTH_NAMES[monthNum - 1], total_matches: inSeason.length, beaches: inSeason.slice(0, clampLimit(args.limit, 15)).map(brief) })
  })

  return server
}

// ── HTTP wiring (stateless Streamable HTTP behind nginx) ──────────────────
const app = express()
app.use(express.json({ limit: '64kb' }))

// CORS: public read-only data server — allow browser-based MCP clients.
app.use('/mcp', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID')
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version')
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
})

app.post('/mcp', async (req, res) => {
  try {
    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { transport.close(); server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (err) {
    console.error('mcp request failed:', err)
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
  }
})

// Stateless server: no server→client stream, no sessions to delete.
const methodNotAllowed = (_req, res) =>
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server — POST only)' }, id: null })
app.get('/mcp', methodNotAllowed)
app.delete('/mcp', methodNotAllowed)

app.get('/healthz', (_req, res) => res.json({ ok: true, beaches: beaches().length, updated: cache.updated }))

app.listen(PORT, '127.0.0.1', () => {
  beaches() // fail fast if the dataset is unreadable
  console.log(`beachmap-mcp listening on 127.0.0.1:${PORT} (data: ${BEACHES_PATH})`)
})
