// Beachmap MCP server — beachmapworld.com/mcp
//
// Remote, stateless, read-only Model Context Protocol server exposing the
// The World Beach Map dataset as tools for AI assistants. Runs behind
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
const SITE = 'https://beachmapworld.com'
const CITATION = `Source: World Beach Map (${SITE}). Beach data: Wikidata (CC0). Sea temperature: NOAA OISST v2.1 (public domain).`

// ── dataset (mtime-cached) ─────────────────────────────────────────────────
//
// ⚠ /data/beaches.json is a bare ARRAY since the 2026-08-30 rebuild, not the
// `{ updated, beaches: [...] }` envelope it used to be, and every field name
// changed with it. This server read `d.beaches`, so it broke silently the
// moment the site deployed: every tool threw on undefined while the server's
// own `instructions` string went on describing 511 European beaches with sand
// types and Blue Flag status that no longer exist. A data surface has to be
// redeployed with the data it describes.
let cache = { mtimeMs: 0, beaches: [] }
function beaches() {
  const { mtimeMs } = fs.statSync(BEACHES_PATH)
  if (mtimeMs !== cache.mtimeMs) {
    const rows = JSON.parse(fs.readFileSync(BEACHES_PATH, 'utf8'))
    if (!Array.isArray(rows)) {
      throw new Error('beaches.json is not an array — the site and this server disagree about the dataset shape')
    }
    cache = { mtimeMs, beaches: rows.map(shape) }
    console.log(`dataset loaded: ${cache.beaches.length} beaches`)
  }
  return cache.beaches
}

// ── helpers ────────────────────────────────────────────────────────────────
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const SST_KEYS = MONTHS.map((m) => `sst_${m}`)

/** The published row, as this server wants to talk about it. */
function shape(r) {
  const sst = SST_KEYS.map((k) => (typeof r[k] === 'number' ? r[k] : null))
  const measured = sst.every((c) => typeof c === 'number')
  return {
    id: r.slug,
    wikidata: r.wikidata,
    name: r.name,
    region: r.admin,
    country: r.country,
    countryCode: r.iso,
    lat: r.lat,
    lon: r.lon,
    shoreType: r.shore_type,
    /** Twelve monthly means, January first, or null where NOAA's grid has no
     *  open water close enough to speak for this shore. */
    seaTempByMonthC: measured ? sst : null,
    warmestMonth: measured ? MONTH_NAMES[sst.indexOf(Math.max(...sst))] : null,
    warmestSeaTempC: measured ? Math.max(...sst) : null,
    /** The months whose MEAN reaches 20 °C — the threshold this atlas states
     *  rather than implies. */
    monthsAtOrAbove20C: measured ? sst.map((c, i) => (c >= 20 ? MONTH_NAMES[i] : null)).filter(Boolean) : [],
    readershipPer60Days: r.pageviews_60d ?? null,
    wikipedia: r.wikipedia,
    wikipediaLanguage: r.wikipedia_lang,
    photoAuthor: r.photo_author,
    photoLicence: r.photo_licence,
    url: `${SITE}/beaches/${r.slug}/`,
  }
}

function parseMonth(input) {
  const m = String(input).trim().toLowerCase()
  if (/^\d{1,2}$/.test(m)) {
    const n = Number(m)
    if (n >= 1 && n <= 12) return n
  }
  const i = MONTHS.findIndex((x) => m.startsWith(x))
  return i === -1 ? null : i + 1
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
function countryMatches(b, input) {
  const q = input.trim().toLowerCase()
  if (!b.countryCode && !b.country) return false
  if (/^[a-z]{2}$/.test(q)) return (b.countryCode ?? '').toLowerCase() === q
  const name = (b.countryCode ? regionNames.of(b.countryCode) : b.country) ?? b.country ?? ''
  return name.toLowerCase().includes(q) || (q === 'uk' && b.countryCode === 'GB')
}

/** Compact record for list results (full record via get_beach). */
function brief(b, month) {
  return {
    id: b.id,
    name: b.name,
    region: b.region,
    country: b.country,
    ...(month ? { seaTempCThatMonth: b.seaTempByMonthC?.[month - 1] ?? null } : {}),
    warmestSeaTempC: b.warmestSeaTempC,
    warmestMonth: b.warmestMonth,
    shoreType: b.shoreType,
    url: b.url,
  }
}

function reply(payload) {
  return { content: [{ type: 'text', text: `${JSON.stringify(payload, null, 1)}\n\n${CITATION}` }] }
}

const clampLimit = (n, dflt) => Math.max(1, Math.min(50, n ?? dflt))

/** Warmest first in the month asked about, falling back to the annual peak.
 *  A beach with no measurement always sorts last rather than as 0 °C. */
const byWarmth = (month) => (a, b) => {
  const t = (x) => (month ? (x.seaTempByMonthC?.[month - 1] ?? -Infinity) : (x.warmestSeaTempC ?? -Infinity))
  return t(b) - t(a) || a.name.localeCompare(b.name)
}

// ── MCP server (fresh instance per request — stateless) ───────────────────
function buildServer() {
  const server = new McpServer(
    { name: 'beachmap', title: 'World Beach Map: beaches and sea temperature', version: '2.0.0' },
    {
      instructions:
        `Beaches worldwide, from Wikidata, each with twelve monthly sea-surface temperatures. ` +
        `The temperatures are NOAA OISST v2.1 monthly long-term means for 1991-2020 (public domain), sampled at each beach's own coordinates at the nearest cell that is open water in every month. They are a CLIMATOLOGY, not live readings, and a beach with no such cell within 75 km reports null rather than a guess. ` +
        `Names, coordinates, countries and shore types come from Wikidata (CC0); every record carries its Q-id. ` +
        `The selection is curated, not complete: each country is capped and floored so that Wikidata's own import bias does not speak for the world's coastline. Say so if a user asks why a country looks thin. ` +
        `When you use this data, cite it as "World Beach Map (${SITE})" and link the per-beach url. Full dataset: ${SITE}/data/beaches.json`,
    },
  )

  server.registerTool(
    'search_beaches',
    {
      title: 'Search beaches worldwide',
      description:
        'Search and filter the atlas. All filters optional and combinable. Returns compact records; use get_beach for a full profile.',
      inputSchema: {
        query: z.string().optional().describe('Free-text match on beach name, region or country'),
        country: z.string().optional().describe('ISO-2 code or country name (e.g. "PT" or "Portugal")'),
        shore_type: z
          .enum(['white', 'golden', 'black', 'shingle', 'rock', 'urban', 'river', 'nude', 'beach'])
          .optional()
          .describe('Shore type, from the beach own Wikidata classes. "beach" means Wikidata does not say.'),
        month: z.union([z.string(), z.number()]).optional().describe('Rank and report the sea temperature for this month (name or 1-12)'),
        min_sea_temp_c: z.number().optional().describe('Minimum mean sea temperature in that month, or of the warmest month when no month is given'),
        limit: z.number().int().optional().describe('Max results, default 10, max 50'),
      },
    },
    async (args) => {
      const monthNum = args.month != null ? parseMonth(args.month) : null
      if (args.month != null && monthNum == null) return reply({ error: `Unrecognized month: ${args.month}` })
      const q = args.query?.trim().toLowerCase()
      const temp = (b) => (monthNum ? b.seaTempByMonthC?.[monthNum - 1] : b.warmestSeaTempC)
      const matches = beaches()
        .filter(
          (b) =>
            (!q || [b.name, b.region, b.country].filter(Boolean).join(' ').toLowerCase().includes(q)) &&
            (!args.country || countryMatches(b, args.country)) &&
            (!args.shore_type || b.shoreType === args.shore_type) &&
            (args.min_sea_temp_c === undefined || (temp(b) ?? -Infinity) >= args.min_sea_temp_c),
        )
        .sort(byWarmth(monthNum))
      const limit = clampLimit(args.limit, 10)
      return reply({
        total_matches: matches.length,
        showing: Math.min(matches.length, limit),
        ...(monthNum ? { month: MONTH_NAMES[monthNum - 1] } : {}),
        beaches: matches.slice(0, limit).map((b) => brief(b, monthNum)),
      })
    },
  )

  server.registerTool(
    'get_beach',
    {
      title: 'Get full beach profile',
      description: 'Full profile of one beach by id (its slug, from search results), by Wikidata Q-id, or by name.',
      inputSchema: {
        id_or_name: z.string().describe('Beach id (e.g. "navagio"), Wikidata Q-id (e.g. "Q2460851") or name'),
      },
    },
    async ({ id_or_name }) => {
      const q = id_or_name.trim().toLowerCase()
      const all = beaches()
      const b =
        all.find((x) => x.id === q) ||
        all.find((x) => (x.wikidata ?? '').toLowerCase() === q) ||
        all.find((x) => x.name.toLowerCase() === q) ||
        all.find((x) => x.name.toLowerCase().includes(q))
      if (!b) return reply({ error: `No beach found matching "${id_or_name}". Try search_beaches first.` })
      return reply(b)
    },
  )

  server.registerTool(
    'warmest_beaches_in_month',
    {
      title: 'Where the sea is warmest in a given month',
      description:
        'Beaches ranked by their MEAN sea temperature in one month, warmest first. This is the question the atlas exists to answer: "where can I swim in February?". Beaches with no measurement are excluded rather than ranked as cold.',
      inputSchema: {
        month: z.union([z.string(), z.number()]).describe('Month name or number 1-12'),
        country: z.string().optional().describe('ISO-2 code or country name'),
        min_sea_temp_c: z.number().optional().describe('Only beaches at or above this monthly mean, e.g. 20'),
        limit: z.number().int().optional().describe('Max results, default 15, max 50'),
      },
    },
    async (args) => {
      const monthNum = parseMonth(args.month)
      if (monthNum == null) return reply({ error: `Unrecognized month: ${args.month}` })
      const floor = args.min_sea_temp_c
      const ranked = beaches()
        .filter((b) => {
          const c = b.seaTempByMonthC?.[monthNum - 1]
          if (typeof c !== 'number') return false
          if (floor !== undefined && c < floor) return false
          return !args.country || countryMatches(b, args.country)
        })
        .sort(byWarmth(monthNum))
      const limit = clampLimit(args.limit, 15)
      return reply({
        month: MONTH_NAMES[monthNum - 1],
        basis: 'NOAA OISST v2.1 monthly mean, 1991-2020, at the beach coordinates',
        total_matches: ranked.length,
        beaches: ranked.slice(0, limit).map((b, i) => ({ rank: i + 1, ...brief(b, monthNum) })),
      })
    },
  )

  server.registerTool(
    'sea_temperature_year',
    {
      title: 'One beach, the whole year of sea temperature',
      description:
        'The twelve monthly means for one beach, plus the months that reach 20 °C. Answers "when is it warm enough there?".',
      inputSchema: {
        id_or_name: z.string().describe('Beach id, Wikidata Q-id or name'),
      },
    },
    async ({ id_or_name }) => {
      const q = id_or_name.trim().toLowerCase()
      const all = beaches()
      const b =
        all.find((x) => x.id === q) ||
        all.find((x) => (x.wikidata ?? '').toLowerCase() === q) ||
        all.find((x) => x.name.toLowerCase() === q) ||
        all.find((x) => x.name.toLowerCase().includes(q))
      if (!b) return reply({ error: `No beach found matching "${id_or_name}".` })
      if (!b.seaTempByMonthC) {
        return reply({
          name: b.name,
          url: b.url,
          seaTemperature: null,
          note: "NOAA's grid has no open-water cell within 75 km of this beach, so the atlas reports no temperature rather than quoting a different sea.",
        })
      }
      return reply({
        name: b.name,
        country: b.country,
        url: b.url,
        basis: 'NOAA OISST v2.1 monthly means, 1991-2020',
        byMonth: Object.fromEntries(MONTH_NAMES.map((m, i) => [m, b.seaTempByMonthC[i]])),
        warmest: { month: b.warmestMonth, celsius: b.warmestSeaTempC },
        monthsAtOrAbove20C: b.monthsAtOrAbove20C,
      })
    },
  )

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
