// Streams live prices from Yahoo Finance's price stream for the symbols in argv, one JSON line each:
//   {"id":"MU","price":923.85}
// and {"ping":1} every 5 s, so the mod's loop wakes even when nothing trades. Reconnects with a
// growing pause; exits once the process that started it is gone. Run by hooks/register.tsx.

const SYMBOL = /^\^?[A-Z0-9][A-Z0-9.=-]{0,14}$/
const symbols = process.argv.slice(2).filter(s => SYMBOL.test(s))
if (symbols.length === 0) process.exit(2)

const parent = process.ppid
let pause = 1000

/** A protobuf varint at `i`: its value and where the next field starts. */
function varint(bytes, i) {
  let value = 0
  let scale = 1
  let byte
  do {
    byte = bytes[i++]
    value += (byte & 0x7f) * scale
    scale *= 128
  } while (byte & 0x80 && i < bytes.length)
  return [value, i]
}

/** The symbol (field 1) and price (field 2, a float) of one PricingData message. */
function decode(bytes) {
  const out = {}
  let i = 0
  while (i < bytes.length) {
    let key
    ;[key, i] = varint(bytes, i)
    const field = Math.floor(key / 8)
    const wire = key % 8
    if (wire === 0) {
      ;[, i] = varint(bytes, i)
    } else if (wire === 1) {
      i += 8
    } else if (wire === 2) {
      let length
      ;[length, i] = varint(bytes, i)
      if (field === 1) out.id = bytes.subarray(i, i + length).toString('utf8')
      i += length
    } else if (wire === 5) {
      if (field === 2 && i + 4 <= bytes.length) out.price = bytes.readFloatLE(i)
      i += 4
    } else {
      break
    }
  }
  return out
}

function connect() {
  const ws = new WebSocket('wss://streamer.finance.yahoo.com/?version=2')
  ws.onopen = () => ws.send(JSON.stringify({ subscribe: symbols }))
  ws.onmessage = event => {
    if (typeof event.data !== 'string') return
    let base64 = event.data
    try {
      base64 = JSON.parse(event.data).message ?? event.data
    } catch {
      // Version 1 sends the bare base64.
    }
    const { id, price } = decode(Buffer.from(String(base64), 'base64'))
    if (typeof id !== 'string' || !Number.isFinite(price) || price <= 0) return
    pause = 1000
    // A float on the wire: 923.85 arrives as 923.849975...; four decimals is what any quote shows.
    process.stdout.write(`${JSON.stringify({ id, price: Math.round(price * 10000) / 10000 })}\n`)
  }
  ws.onclose = () => {
    setTimeout(connect, pause)
    pause = Math.min(pause * 2, 60_000)
  }
  ws.onerror = () => ws.close()
}

setInterval(() => {
  if (process.ppid !== parent) process.exit(0)
  process.stdout.write('{"ping":1}\n')
}, 5000)

connect()
