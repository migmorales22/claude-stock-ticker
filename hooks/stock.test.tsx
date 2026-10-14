import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { amount, change, parseChart, recent, sessionAt, sparkText } from './register'

// 2026-10-14 15:00 UTC: 11:00 in New York, the market open.
const NOW = Date.UTC(2026, 9, 14, 15, 0)
const OPEN = Date.UTC(2026, 9, 14, 13, 30) / 1000
const CLOSE = Date.UTC(2026, 9, 14, 20, 0) / 1000

/** Yahoo's chart answer, as much of it as the mod reads. */
function chart(o: { symbol?: string; price: number; prev: number; closes?: number[] }) {
  const closes = o.closes ?? [o.prev, (o.prev + o.price) / 2, o.price]
  return JSON.stringify({
    chart: {
      result: [
        {
          meta: {
            symbol: o.symbol ?? 'AAPL',
            shortName: 'Apple Inc.',
            currency: 'USD',
            regularMarketPrice: o.price,
            chartPreviousClose: o.prev,
            currentTradingPeriod: {
              pre: { start: OPEN - 19_800, end: OPEN },
              regular: { start: OPEN, end: CLOSE },
              post: { start: CLOSE, end: CLOSE + 14_400 },
            },
          },
          timestamp: closes.map((_, i) => OPEN + i * 300),
          indicators: { quote: [{ close: closes }] },
        },
      ],
      error: null,
    },
  })
}

const NOT_FOUND = JSON.stringify({ chart: { result: null, error: { code: 'Not Found', description: 'No data found' } } })

/** Beneath the mod: the network answers from `answer`, which a test may change between calls. */
function net(on: On, answer: { text: string; status?: number; isDown?: boolean }) {
  const asked: string[] = []
  on('http.fetch', ($$, e) => {
    asked.push(e.url)
    if (answer.isDown) throw new Error('offline')
    const status = answer.status ?? 200
    return { value: { status, ok: status < 400, headers: {}, text: answer.text } } as never
  })
  return asked
}

function engineRow(on: On) {
  on('ui.render', ($$, e) => {
    const { Box } = $$.ui.resolve(e)
    return h(Box, { key: 'engine-row' }) as never
  })
}

const BAND = { component: 'AbovePrompt' as const, props: { bodyColumns: 100, hasSurvey: false } as never }

const stock = ($: Engine, args: string) =>
  $.command.run({ command: 'stock', args } as never) as Promise<{ text?: string }>

test('helpers: amounts, change, market session, quote parsing, the terminal line', () => {
  expect(amount(1234.5)).toBe('1,234.50')
  expect(amount(0.12345)).toBe('0.1235')
  expect(sessionAt({ regular: { start: OPEN, end: CLOSE } }, OPEN + 60)).toBe('open')
  expect(sessionAt({ regular: { start: OPEN, end: CLOSE } }, CLOSE + 60)).toBe('closed')

  const q = parseChart(chart({ price: 344.64, prev: 341.27 }), 'AAPL', NOW)
  if (typeof q === 'string') throw new Error(q)
  expect(q.name).toBe('Apple Inc.')
  expect(q.session).toBe('open')
  expect(q.points.length).toBe(3)
  expect(recent(q)).toEqual([341.27, (341.27 + 344.64) / 2, 344.64, 344.64])
  expect(change(q).dir).toBe('up')
  expect(change(q).text).toBe('+3.37 (+0.99%)')

  expect(parseChart(NOT_FOUND, 'ZZZZQQ', NOW)).toBe('no quote for ZZZZQQ on Yahoo Finance')
  expect(typeof parseChart('<html>', 'AAPL', NOW)).toBe('string')
  expect(sparkText([1, 2, 3, 4], 4)).toBe('▁▃▆█')
})

test('/stock aapl draws the tile on the desktop, green on an up day, and remembers the symbol', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const asked = net(on, { text: chart({ price: 344.64, prev: 341.27 }) })
  engineRow(on)

  const said = await stock($, 'aapl')
  expect(said.text ?? '').toContain('Watching Apple Inc.')
  expect(asked[0]).toContain('/chart/AAPL?')

  const ui = await $.ui.mount({ plugin: 'stock-ticker', surface: 'desktop', ...BAND })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('AAPL')
  expect(drawn).toContain('$344.64')
  expect(drawn).toContain('#1f9d55')
  expect(drawn).toContain('engine-row')
  expect(await stock($, '')).toEqual({ text: 'AAPL $344.64 ▲ +3.37 (+0.99%) today, market open' })
})

test('the terminal shows a down day in red, with an arrow and today\'s line', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  net(on, { text: chart({ symbol: 'TSLA', price: 240, prev: 250, closes: [250, 247, 244, 241, 240] }) })
  engineRow(on)

  await stock($, 'TSLA')
  const ui = await $.ui.mount({ plugin: 'stock-ticker', surface: 'terminal', ...BAND })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('#e5484d')
  expect(drawn).toContain('▼ -10.00 (-4.00%)')
  expect(drawn).toContain('█')
})

test('an unknown symbol is refused and nothing is watched', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  net(on, { text: NOT_FOUND })
  engineRow(on)

  expect((await stock($, 'ZZZZQQ')).text).toBe('No quote for ZZZZQQ on Yahoo Finance.')
  expect((await stock($, 'BRK.B')).text).toBe('No quote for BRK.B on Yahoo Finance (try BRK-B).')
  expect((await stock($, 'rm -rf /')).text ?? '').toContain('is not a ticker symbol')
  const ui = await $.ui.mount({ plugin: 'stock-ticker', surface: 'desktop', ...BAND })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('engine-row')
  expect(drawn).not.toContain('svg')
})

test('the tile refreshes on its timer, keeps the last price while offline, and /stock off hides it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const answer: { text: string; isDown?: boolean } = { text: chart({ price: 100, prev: 100 }) }
  const asked = net(on, answer)
  engineRow(on)
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  await stock($, 'AAPL')
  answer.text = chart({ price: 103, prev: 100 })
  await clock.advance(15_000)
  expect(asked.length).toBe(2)
  expect((await stock($, '')).text ?? '').toContain('$103.00 ▲ +3.00 (+3.00%)')

  answer.isDown = true
  await clock.advance(15_000)
  expect((await stock($, '')).text ?? '').toContain('$103.00 ▲ +3.00 (+3.00%) today, market open, not updating')

  expect((await stock($, 'off')).text).toBe('Stock row off.')
  const ui = await $.ui.mount({ plugin: 'stock-ticker', surface: 'desktop', ...BAND })
  expect(JSON.stringify(await ui.drawn())).not.toContain('svg')
  answer.isDown = false
  await clock.advance(60_000)
  expect(asked.length).toBe(3)
})

test('the live stream moves the price between refreshes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { PATH: '/usr/bin:/opt/homebrew/bin' })
  net(on, { text: chart({ symbol: 'MU', price: 100, prev: 100 }) })
  engineRow(on)
  on('fs.exists', ($$, e) => ({ value: e.path === '/opt/homebrew/bin/node' }) as never)
  // Beneath the mod, the child: two prices, a ping, and a line cut across two pieces. Pieces are
  // yielded plain; the end is answered as { value }.
  const spawned: string[][] = []
  on('process.spawn', async function* ($$: unknown, e: { argv: readonly string[] }) {
    spawned.push([...e.argv])
    yield { stream: 'stdout', text: '{"id":"MU","price":101.5}\n{"ping":1}\n{"id":"MU","pri' }
    yield { stream: 'stdout', text: 'ce":102.25}\n{"id":"AAPL","price":1}\n' }
    return { value: { code: 0, signal: null } }
  } as never)

  await stock($, 'MU')
  await clock.settle()
  expect(spawned.length).toBe(1)
  expect(spawned[0]?.[0]).toBe('/opt/homebrew/bin/node')
  expect(spawned[0]?.[1] ?? '').toContain('/stream/yahoo-stream.mjs')
  expect(spawned[0]?.[2]).toBe('MU')
  expect((await stock($, '')).text ?? '').toContain('MU $102.25 ▲ +2.25 (+2.25%)')
})
