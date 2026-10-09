import { createHmac } from 'node:crypto';

/**
 * Deterministic draw `br-draw/1`.
 *
 * Given the locked field and a 256-bit draw seed, produces a seed order by a Fisher–Yates
 * shuffle whose randomness is HMAC-SHA256(drawSeed, "br-draw/1:" + counter), with rejection
 * sampling (no modulo bias). The draw seed itself is generated with a CSPRNG by the caller and
 * PERSISTED, so anyone holding (field, seed) can reproduce the order exactly.
 *
 * Honest scope: this makes a draw reproducible and tamper-evident after the fact. It is NOT a
 * provably fair draw — the platform generated the seed and could, in principle, have discarded
 * seeds it disliked. A commit–reveal or external-beacon draw is future work.
 */
export const DRAW_ALGORITHM = 'br-draw/1';
export const DRAW_SEED = /^[0-9a-f]{64}$/;

export function deterministicDraw(participantIds: readonly string[], drawSeed: string): string[] {
  if (!DRAW_SEED.test(drawSeed)) throw new Error('draw seed must be 32 bytes of lower-case hex');
  // Canonical starting order: sorted ids, so the result depends only on (set, seed).
  const order = [...participantIds].sort();
  if (new Set(order).size !== order.length) throw new Error('duplicate participant in draw');
  const key = Buffer.from(drawSeed, 'hex');
  let counter = 0;
  const nextUint32 = (): number => {
    const block = createHmac('sha256', key).update(`${DRAW_ALGORITHM}:${counter++}`).digest();
    return block.readUInt32BE(0);
  };
  const uniformBelow = (bound: number): number => {
    const limit = Math.floor(0x100000000 / bound) * bound;
    for (;;) {
      const x = nextUint32();
      if (x < limit) return x % bound;
    }
  };
  for (let i = order.length - 1; i > 0; i--) {
    const j = uniformBelow(i + 1);
    const tmp = order[i] as string;
    order[i] = order[j] as string;
    order[j] = tmp;
  }
  return order;
}
