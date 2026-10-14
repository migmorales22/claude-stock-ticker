/** Where the exchange is in its day when the quote was read. */
export type MarketSession = 'pre' | 'open' | 'post' | 'closed'

/** One read of a stock, as the tile draws it. */
export type Quote = {
  /** The symbol as watched, upper case (`AAPL`, `BRK-B`, `^GSPC`). */
  symbol: string
  /** The exchange's short name for it (`Apple Inc.`). */
  name: string
  currency: string
  price: number
  /** Yesterday's close: what the day's change is measured from. */
  prevClose: number
  /** Today's closes, a minute apart, oldest first. */
  points: number[]
  session: MarketSession
  /** When the quote was read (epoch ms). */
  fetchedAt: number
  /** True once a refresh failed: the tile still shows the last good read. */
  isStale: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'stock-ticker': {
      /** What the tile shows; null when nothing is watched. */
      quote: Quote | null
    }
  }
}
