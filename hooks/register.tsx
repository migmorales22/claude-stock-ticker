import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MarketSession, Quote } from '../types'

const quote = atom({ plugin: 'stock-ticker', key: 'quote' } as const, null)

/** The watched symbol lives in the store, so the row comes back in the next session. */
const SYMBOL_KEY = 'symbol'
/** The chart's refresh while the stream is down, or not yet up. */
const POLL_MS = 15_000
/** While the stream carries the price, the chart is read only for the minute line. */
const STREAMING_POLL_MS = 60_000
/** A stream whose last price is older than this is not carrying the price. */
const STREAM_FRESH_MS = 30_000
/** After the stream could not start, the wait before trying again. */
const STREAM_RETRY_MS = 5 * 60_000
/** Outside pre-market to after-hours the price stands still: read it far less often. */
const CLOSED_POLL_MS = 10 * 60_000
/** Yahoo's symbols: AAPL, BRK-B, ^GSPC, BTC-USD, EURUSD=X, 7203.T. */
const SYMBOL = /^\^?[A-Z0-9][A-Z0-9.=-]{0,14}$/
const OFF = new Set(['OFF', 'STOP', 'HIDE', 'CLEAR'])
/** As tall as savvy-progress's row, so the two sit together above the prompt. */
const BAR_H = 22
/** The line shows the last two hours, a point a minute: new minutes scroll it left, the live price moves its end. */
const WINDOW = 120
const UP = '#1f9d55'
const DOWN = '#e5484d'
const FLAT = '#8a8a86'
const SPARK = '▁▂▃▄▅▆▇█'

// The module's own: a reload drops it, and nothing is lost but a fetch in flight.
let isFetching = false
/** The last time the row above the prompt was drawn, for /stock debug. */
const lastDraw = { count: 0, surface: '', hasSvg: false, hadQuote: false, error: '' }
/** The live stream: its symbol, when its last price came, and whether it should keep running. */
type Live = { symbol: string; isOn: boolean; lastAt: number }
let live: Live | undefined
/** When the stream last failed to start or ended by itself; 0 when it has not. */
let liveFailedAt = 0

const chartUrl = (symbol: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`

const clean = (s: unknown, max: number) =>
  typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : ''

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Escapes markup, and writes anything outside printable ASCII as a character reference: the SVG stays plain ASCII. */
const xml = (s: string) => s.replace(/[&<>"']|[^\x20-\x7e]/gu, c => `&#${c.codePointAt(0)};`)

/** Where the exchange is now, from the chart's trading periods (epoch seconds). */
export function sessionAt(period: unknown, nowSec: number): MarketSession {
  const p = period as Record<string, { start?: unknown; end?: unknown } | undefined> | undefined
  const within = (k: string) => {
    const start = num(p?.[k]?.start)
    const end = num(p?.[k]?.end)
    return start !== undefined && end !== undefined && nowSec >= start && nowSec < end
  }
  if (within('regular')) return 'open'
  if (within('pre')) return 'pre'
  if (within('post')) return 'post'
  return 'closed'
}

/** A quote from Yahoo's chart answer, or why there is none. */
export function parseChart(text: string, symbol: string, nowMs: number): Quote | string {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return 'Yahoo Finance sent something that is not a quote'
  }
  const chart = (data as { chart?: { result?: unknown[] | null; error?: { description?: unknown } | null } }).chart
  const r = chart?.result?.[0] as
    | { meta?: Record<string, unknown>; indicators?: { quote?: { close?: unknown[] }[] } }
    | undefined
  if (r?.meta === undefined) {
    return `no quote for ${symbol} on Yahoo Finance`
  }
  const m = r.meta
  const price = num(m.regularMarketPrice)
  const prevClose = num(m.chartPreviousClose) ?? num(m.previousClose)
  if (price === undefined || prevClose === undefined || prevClose === 0) return `no price for ${symbol} right now`

  // A minute with no trade comes back null: skip it.
  const points = (r.indicators?.quote?.[0]?.close ?? []).map(num).filter((c): c is number => c !== undefined)
  return {
    symbol,
    name: clean(m.shortName, 40) || clean(m.longName, 40) || symbol,
    currency: clean(m.currency, 8) || 'USD',
    price,
    prevClose,
    points: points.slice(-400),
    session: sessionAt(m.currentTradingPeriod, Math.floor(nowMs / 1000)),
    fetchedAt: nowMs,
    isStale: false,
  }
}

/** 1234.5 → "1,234.50"; under 1 keeps four decimals. */
export function amount(n: number) {
  const digits = Math.abs(n) < 1 ? 4 : 2
  const [whole = '0', part = ''] = Math.abs(n).toFixed(digits).split('.')
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${part}`
}

const PREFIX: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', INR: '₹', KRW: '₩' }

export function price(q: Quote) {
  if (q.currency === 'GBp') return `${amount(q.price)}p`
  const prefix = PREFIX[q.currency]
  return prefix === undefined ? `${amount(q.price)} ${q.currency}` : `${prefix}${amount(q.price)}`
}

export function change(q: Quote) {
  const diff = q.price - q.prevClose
  const pct = (diff / q.prevClose) * 100
  const dir: 'up' | 'down' | 'flat' = Math.abs(pct) < 0.005 ? 'flat' : diff > 0 ? 'up' : 'down'
  const sign = dir === 'up' ? '+' : dir === 'down' ? '-' : ''
  return {
    dir,
    color: dir === 'up' ? UP : dir === 'down' ? DOWN : FLAT,
    arrow: dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■',
    text: `${sign}${amount(Math.abs(diff))} (${sign}${Math.abs(pct).toFixed(2)}%)`,
  }
}

const SESSION_LABEL: Record<MarketSession, string> = { open: 'open', pre: 'pre-market', post: 'after hours', closed: 'closed' }

/** One line saying it all: the row's alt text and the command's answer. */
export function describe(q: Quote) {
  const c = change(q)
  return `${q.symbol} ${price(q)} ${c.arrow} ${c.text} today, market ${SESSION_LABEL[q.session]}${q.isStale ? ', not updating' : ''}`
}

/** The line in block characters, for the terminal. */
export function sparkText(points: number[], width: number) {
  if (points.length < 2 || width < 2) return ''
  const step = points.length / width
  const picked = points.length <= width ? points : Array.from({ length: width }, (_, i) => points[Math.floor(i * step)] ?? 0)
  const lo = Math.min(...picked)
  const hi = Math.max(...picked)
  return picked.map(p => SPARK[hi === lo ? 3 : Math.round(((p - lo) / (hi - lo)) * (SPARK.length - 1))]).join('')
}

/** About how wide `s` draws at `size` px in the system font. */
const textWidth = (s: string, size: number) => s.length * size * 0.62

/** The last two hours and the live price: what the line draws. */
export const recent = (q: Quote) => [...q.points.slice(-WINDOW), q.price]

/** One slim row: a live dot, symbol, price, the day's change, the last two hours' line, and the market state. */
export function barSvg(q: Quote, W: number) {
  const c = change(q)
  const isLive = !q.isStale && q.session !== 'closed'
  const font = `font-family="-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"`
  const mid = BAR_H / 2
  const baseline = 15.5
  const priceText = price(q)
  const symbolX = 14
  const priceX = symbolX + textWidth(q.symbol, 13) + 8
  const arrowX = priceX + textWidth(priceText, 13) + 10
  const changeX = arrowX + 10
  const badge = q.isStale ? 'offline' : SESSION_LABEL[q.session]
  const sparkLeft = changeX + textWidth(c.text, 12) + 14
  const sparkRight = W - textWidth(badge, 11) - 14
  // The day's direction as a small triangle beside the change.
  const arrow =
    c.dir === 'up'
      ? `M${arrowX} ${mid + 3.5}L${arrowX + 7} ${mid + 3.5}L${arrowX + 3.5} ${mid - 3}Z`
      : c.dir === 'down'
        ? `M${arrowX} ${mid - 3}L${arrowX + 7} ${mid - 3}L${arrowX + 3.5} ${mid + 3.5}Z`
        : `M${arrowX} ${mid - 1.25}L${arrowX + 7} ${mid - 1.25}L${arrowX + 7} ${mid + 1.25}L${arrowX} ${mid + 1.25}Z`

  let spark = ''
  const pts = recent(q)
  if (pts.length > 1 && sparkRight - sparkLeft >= 40) {
    const lo = Math.min(...pts)
    const hi = Math.max(...pts)
    const top = 3
    const bottom = BAR_H - 3
    const y = (v: number) => (hi === lo ? mid : bottom - ((v - lo) / (hi - lo)) * (bottom - top))
    const x = (i: number) => sparkLeft + (i / (pts.length - 1)) * (sparkRight - sparkLeft)
    const line = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
    // Yesterday's close, dashed, when the window reaches it.
    const base =
      q.prevClose >= lo && q.prevClose <= hi
        ? `<line class="base" x1="${sparkLeft}" x2="${sparkRight.toFixed(1)}" y1="${y(q.prevClose).toFixed(1)}" y2="${y(q.prevClose).toFixed(1)}" stroke-width="1" stroke-dasharray="2 2"/>`
        : ''
    spark =
      base +
      `<path d="${line}" fill="none" stroke="${c.color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${sparkRight.toFixed(1)}" cy="${y(q.price).toFixed(1)}" r="2.2" fill="${c.color}"/>`
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${BAR_H}" viewBox="0 0 ${W} ${BAR_H}">`,
    '<style>.t{fill:#1f1f1f}.s{fill:#6b6b68}.base{stroke:#b9b9b4}.n{font-variant-numeric:tabular-nums}',
    '@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.base{stroke:#5a5a57}}',
    '.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}',
    '@media (prefers-reduced-motion: reduce){.live{animation:none}}</style>',
    `<circle${isLive ? ' class="live"' : ''} cx="5" cy="${mid}" r="3.5" fill="${isLive ? c.color : FLAT}"/>`,
    `<text class="t" x="${symbolX}" y="${baseline}" ${font} font-size="13" font-weight="700">${xml(q.symbol)}</text>`,
    `<text class="t n" x="${priceX.toFixed(1)}" y="${baseline}" ${font} font-size="13" font-weight="600">${xml(priceText)}</text>`,
    `<path d="${arrow}" fill="${c.color}"/>`,
    `<text class="n" x="${changeX.toFixed(1)}" y="${baseline}" fill="${c.color}" ${font} font-size="12" font-weight="600">${xml(c.text)}</text>`,
    spark,
    `<text class="s" x="${W - 2}" y="${baseline}" text-anchor="end" ${font} font-size="11">${badge}</text>`,
    '</svg>',
  ].join('')
}

async function watched($: EngineInterface): Promise<string | undefined> {
  const got = await $.store.get(SYMBOL_KEY)
  return typeof got === 'string' && SYMBOL.test(got) ? got : undefined
}

async function fetchQuote($: EngineInterface, symbol: string): Promise<Quote | string> {
  try {
    const r = await $.http.fetch(chartUrl(symbol), {
      // Without a browser's User-Agent Yahoo answers 429 to every request.
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    })
    if (r.status === 429) return 'Yahoo Finance is busy; trying again shortly'
    return parseChart(r.text, symbol, await $.clock.now())
  } catch {
    return 'could not reach Yahoo Finance'
  }
}

/** One refresh: the watched symbol, read again unless the market is closed and the last read is recent. */
async function tick($: EngineInterface) {
  if (isFetching) return
  isFetching = true
  try {
    const symbol = await watched($)
    const shown = await read($, quote)
    if (symbol === undefined) {
      stopStream()
      if (shown !== null) await update($, quote, () => null)
      return
    }
    const now = await $.clock.now()
    const isStreaming = live?.symbol === symbol && now - live.lastAt < STREAM_FRESH_MS
    const every = shown?.session === 'closed' ? CLOSED_POLL_MS : isStreaming ? STREAMING_POLL_MS : POLL_MS - 1000
    const isFresh = shown?.symbol === symbol && !shown.isStale && now - shown.fetchedAt < every
    if (!isFresh) {
      const got = await fetchQuote($, symbol)
      // A failed refresh keeps the last good read on the row, marked as not updating; while the
      // stream runs, its price is newer than the chart's.
      if (typeof got === 'string') {
        if (!isStreaming) await update($, quote, q => (q?.symbol === symbol ? { ...q, isStale: true } : q))
      } else {
        await update($, quote, q => (isStreaming && q?.symbol === symbol ? { ...got, price: q.price } : got))
      }
    }
    // The stream runs while the market does: a closed one sends nothing.
    const q = await read($, quote)
    if (q?.symbol === symbol && q.session !== 'closed') ensureStream($, symbol, now)
    else stopStream()
  } finally {
    isFetching = false
  }
}

/** The node binary: on PATH, or where Homebrew and the installers put it. */
async function findNode($: EngineInterface) {
  const path = (await $.env.get('PATH')) ?? ''
  for (const dir of [...path.split(':'), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (dir.startsWith('/') && (await $.fs.exists(`${dir}/node`))) return `${dir}/node`
  }
  return undefined
}

/** One line from the stream: a price for the watched symbol moves the row; anything else is ignored. */
async function onPrice($: EngineInterface, mine: Live, line: string) {
  let got: unknown
  try {
    got = JSON.parse(line)
  } catch {
    return
  }
  const { id, price } = (got ?? {}) as { id?: unknown; price?: unknown }
  const value = num(price)
  if (id !== mine.symbol || value === undefined || value <= 0) return
  mine.lastAt = await $.clock.now()
  await update($, quote, q => (q?.symbol === mine.symbol ? { ...q, price: value, isStale: false } : q))
}

/**
 * Runs stream/yahoo-stream.mjs until `mine` is switched off or the child ends. Its pings
 * (every 5 s) wake the loop, so switching off ends the child within seconds even when nothing trades.
 */
async function runStream($: EngineInterface, mine: Live) {
  try {
    const node = await findNode($)
    if (node !== undefined) {
      let pending = ''
      const child = $.process.spawn({ argv: [node, `${$.plugin.root}/stream/yahoo-stream.mjs`, mine.symbol] })
      for await (const piece of child) {
        if (!mine.isOn) break
        if (piece.stream !== 'stdout') continue
        const lines = (pending + piece.text).split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) await onPrice($, mine, line)
      }
    }
  } catch {
    // It could not start: the 15 s refresh carries the price.
  }
  // Ended without being switched off: no node, or the child stopped. Wait before trying again.
  if (mine.isOn) liveFailedAt = await $.clock.now()
  if (live === mine) live = undefined
}

function stopStream() {
  if (live !== undefined) live.isOn = false
  live = undefined
}

/** Starts the stream for `symbol` unless it runs already, or failed a moment ago. */
function ensureStream($: EngineInterface, symbol: string, now: number) {
  if (live?.symbol === symbol) return
  stopStream()
  if (now - liveFailedAt < STREAM_RETRY_MS) return
  const mine: Live = { symbol, isOn: true, lastAt: 0 }
  live = mine
  void runStream($, mine).catch(() => undefined)
}

async function stop($: EngineInterface) {
  stopStream()
  await $.store.delete(SYMBOL_KEY)
  await update($, quote, () => null)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'stock',
      description: 'Watch a stock in a slim row above the prompt: /stock AAPL. /stock off hides it',
    })
    $.clock.after(0, () => void tick($).catch(() => undefined))
    $.clock.every(POLL_MS, () => void tick($).catch(() => undefined))
    return started
  })

  on('command.run', { command: 'stock' }, async ($, e) => {
    const typed = e.args.trim()
    const arg = typed.toUpperCase()
    if (arg === '') {
      const q = await read($, quote)
      return { text: q === null ? 'Not watching a stock. Try /stock AAPL; /stock off hides the row.' : describe(q) }
    }
    if (arg === 'DEBUG') {
      const q = await read($, quote)
      const d = lastDraw
      const now = await $.clock.now()
      return {
        text: [
          `quote: ${q === null ? 'none' : describe(q)}`,
          `drawn ${d.count} times; last on ${d.surface || '-'}, Svg ${d.hasSvg ? 'available' : 'not available'}, ${d.hadQuote ? 'with' : 'without'} a quote`,
          `last error: ${d.error || 'none'}`,
          `stream: ${live === undefined ? 'off' : `on for ${live.symbol}, last price ${live.lastAt === 0 ? 'not yet' : `${Math.round((now - live.lastAt) / 1000)} s ago`}`}${liveFailedAt === 0 ? '' : `; last failed ${Math.round((now - liveFailedAt) / 1000)} s ago`}`,
        ].join('\n'),
      }
    }
    if (OFF.has(arg)) {
      await stop($)
      return { text: 'Stock row off.' }
    }
    if (!SYMBOL.test(arg)) return { text: `"${clean(typed, 20)}" is not a ticker symbol. Try /stock AAPL` }
    const got = await fetchQuote($, arg)
    if (typeof got === 'string') {
      // Yahoo writes share classes with a dash.
      const hint = /^[A-Z]+\.[A-Z]$/.test(arg) ? ` (try ${arg.replace('.', '-')})` : ''
      return { text: `${got.charAt(0).toUpperCase()}${got.slice(1)}${hint}.` }
    }
    await $.store.set(SYMBOL_KEY, arg)
    await update($, quote, () => got)
    if (got.session !== 'closed') ensureStream($, arg, await $.clock.now())
    else stopStream()
    return {
      text: `Watching ${got.name}: ${describe(got)}. Prices stream live from Yahoo Finance while the market trades (every 15 s if the stream is down) and can be delayed. /stock off hides the row.`,
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const q = await read($, quote)
    const ui = $.ui.resolve(e)
    lastDraw.count += 1
    lastDraw.surface = e.surface
    lastDraw.hasSvg = 'Svg' in ui
    lastDraw.hadQuote = q !== null
    if (q === null) return next(e)
    const { Box, Button, Text } = ui
    const below = await next(e)
    try {
      const close = <Button key="stock-off" label="✕" plain role="dismiss" onPress={() => stop($)} />

      if (e.surface === 'desktop' && 'Svg' in ui) {
        const { Svg } = ui
        // About 8 CSS px per reported column, less the dismiss and its gap; as savvy-progress sizes its row.
        const width = Math.max(260, Math.min(720, (e.props.bodyColumns || 100) * 8 - 64))
        return (
          <Box flexDirection="column">
            <Box flexDirection="row" alignItems="center" gap={1}>
              <Svg source={barSvg(q, width)} alt={describe(q)} width={width} height={BAR_H} />
              {close}
            </Box>
            {below}
          </Box>
        )
      }

      const c = change(q)
      const spark = sparkText(recent(q), Math.max(0, Math.min(24, e.props.bodyColumns - 48)))
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>{q.symbol}</Text>
            <Text>{price(q)}</Text>
            <Text color={c.color}>{`${c.arrow} ${c.text}`}</Text>
            {spark !== '' && <Text color={c.color}>{spark}</Text>}
            <Text dimColor>{q.isStale ? 'offline' : SESSION_LABEL[q.session]}</Text>
            {close}
          </Box>
          {below}
        </Box>
      )
    } catch (err) {
      // A drawing that failed leaves the row to the plugins beneath; /stock debug says why.
      lastDraw.error = String(err).slice(0, 300)
      return below
    }
  })
}
