export interface Level {
  px: number;
  sz: number;
}

export interface Book {
  bids: Level[];
  asks: Level[];
}

/** Convert an l2Book response ({levels:[bids,asks]} with string px/sz) to numbers. */
export function parseL2Book(resp: {
  levels: { px: string; sz: string }[][];
}): Book {
  const conv = (ls: { px: string; sz: string }[]) =>
    ls.map((l) => ({ px: Number(l.px), sz: Number(l.sz) }));
  return { bids: conv(resp.levels[0] ?? []), asks: conv(resp.levels[1] ?? []) };
}

export interface Fill {
  /** shares actually fillable */
  filled: number;
  /** total cost in collateral (USDH) */
  cost: number;
  /** volume-weighted average price, NaN if nothing fills */
  avgPx: number;
}

/** Cost of buying `shares` by walking the asks (ascending). Partial if depth is short. */
export function walkAsks(asks: Level[], shares: number): Fill {
  let left = shares;
  let cost = 0;
  let filled = 0;
  for (const l of [...asks].sort((a, b) => a.px - b.px)) {
    if (left <= 0) break;
    const take = Math.min(left, l.sz);
    cost += take * l.px;
    filled += take;
    left -= take;
  }
  return { filled, cost, avgPx: filled > 0 ? cost / filled : NaN };
}

/** Total shares available at or below a max price. */
export function depthUpTo(asks: Level[], maxPx: number): number {
  return asks.filter((l) => l.px <= maxPx).reduce((s, l) => s + l.sz, 0);
}
