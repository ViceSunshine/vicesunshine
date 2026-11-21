// Minimal QR Code encoder (ISO/IEC 18004): byte mode, error-correction
// level M, versions 1–6, automatic mask selection by the standard
// penalty rules. Written for ViceSunshine Party Call invites so a QR can
// be rendered inline as SVG with no external service or image host —
// the code encodes the same "#party=CODE" invite link the app already
// uses, so scanning it joins exactly like the link or the code.
// Verified module-for-module against a reference encoder (segno) for
// payloads across versions 1, 3, 5 and 6 and every mask.

const ECC_M_TABLE: Record<number, { eccPerBlock: number; blocks: number; totalCodewords: number }> = {
  1: { eccPerBlock: 10, blocks: 1, totalCodewords: 26 },
  2: { eccPerBlock: 16, blocks: 1, totalCodewords: 44 },
  3: { eccPerBlock: 26, blocks: 1, totalCodewords: 70 },
  4: { eccPerBlock: 18, blocks: 2, totalCodewords: 100 },
  5: { eccPerBlock: 24, blocks: 2, totalCodewords: 134 },
  6: { eccPerBlock: 16, blocks: 4, totalCodewords: 172 },
};
const ALIGNMENT: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
};
const REMAINDER_BITS: Record<number, number> = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7 };

// Galois field GF(256) with primitive polynomial 0x11d.
const GF_EXP = new Array<number>(512);
const GF_LOG = new Array<number>(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255] ?? 0;
}
function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : (GF_EXP[(GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)] ?? 0);
}
function rsGenerator(deg: number): number[] {
  // Built in ascending order (constant term first), then reversed so
  // index 0 is the x^deg coefficient, as the division below expects.
  let poly = [1];
  for (let i = 0; i < deg; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] ?? 0) ^ gfMul(poly[j] ?? 0, GF_EXP[i] ?? 0);
      next[j + 1] = (next[j + 1] ?? 0) ^ (poly[j] ?? 0);
    }
    poly = next;
  }
  return poly.reverse();
}
function rsRemainder(data: number[], deg: number): number[] {
  const gen = rsGenerator(deg);
  const res = new Array<number>(deg).fill(0);
  for (const b of data) {
    const factor = b ^ (res.shift() ?? 0);
    res.push(0);
    for (let i = 0; i < deg; i++) res[i] = (res[i] ?? 0) ^ gfMul(gen[i + 1] ?? 0, factor);
  }
  return res;
}

function dataCodewords(bytes: number[], version: number): number[] {
  const spec = ECC_M_TABLE[version];
  if (!spec) throw new Error("Unsupported QR version");
  const dataCapacity = spec.totalCodewords - spec.eccPerBlock * spec.blocks;
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, 8); // char count (versions 1–9)
  for (const b of bytes) push(b, 8);
  const capacityBits = dataCapacity * 8;
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | (bits[i + j] ?? 0);
    out.push(v);
  }
  const pads = [0xec, 0x11];
  for (let p = 0; out.length < dataCapacity; p++) out.push(pads[p % 2] ?? 0xec);
  return out;
}

function interleaveWithEcc(data: number[], version: number): number[] {
  const spec = ECC_M_TABLE[version];
  if (!spec) throw new Error("Unsupported QR version");
  const perBlock = Math.floor(data.length / spec.blocks);
  const blocks: { data: number[]; ecc: number[] }[] = [];
  for (let i = 0; i < spec.blocks; i++) {
    const chunk = data.slice(i * perBlock, (i + 1) * perBlock);
    blocks.push({ data: chunk, ecc: rsRemainder(chunk, spec.eccPerBlock) });
  }
  const out: number[] = [];
  for (let i = 0; i < perBlock; i++) for (const b of blocks) out.push(b.data[i] ?? 0);
  for (let i = 0; i < spec.eccPerBlock; i++) for (const b of blocks) out.push(b.ecc[i] ?? 0);
  return out;
}

type Grid = (boolean | null)[][];

function baseMatrix(version: number): { grid: Grid; size: number } {
  const size = 17 + version * 4;
  const grid: Grid = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));
  const set = (x: number, y: number, v: boolean) => {
    if (x >= 0 && x < size && y >= 0 && y < size) grid[y]![x] = v;
  };
  const finder = (fx: number, fy: number) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = fx + dx;
        const y = fy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const inside = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
        const edge = inside && (dx === 0 || dx === 6 || dy === 0 || dy === 6);
        const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        grid[y]![x] = edge || core;
      }
    }
  };
  finder(0, 0);
  finder(size - 7, 0);
  finder(0, size - 7);
  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }
  // Alignment patterns.
  const coords = ALIGNMENT[version] ?? [];
  for (const cy of coords) {
    for (const cx of coords) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  // Dark module + reserved format areas.
  set(8, size - 8, true);
  for (let i = 0; i < 9; i++) {
    if (grid[8]![i] === null) grid[8]![i] = false;
    if (grid[i]![8] === null) grid[i]![8] = false;
  }
  for (let i = 0; i < 8; i++) {
    if (grid[8]![size - 1 - i] === null) grid[8]![size - 1 - i] = false;
    if (grid[size - 1 - i]![8] === null) grid[size - 1 - i]![8] = false;
  }
  grid[8]![8] = false;
  return { grid, size };
}

function placeData(grid: Grid, size: number, codewords: number[], version: number) {
  const bits: number[] = [];
  for (const b of codewords) for (let i = 7; i >= 0; i--) bits.push((b >>> i) & 1);
  for (let i = 0; i < (REMAINDER_BITS[version] ?? 0); i++) bits.push(0);
  let idx = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (grid[y]![x] === null) {
          grid[y]![x] = bits[idx++] === 1;
        }
      }
    }
    upward = !upward;
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function formatBits(mask: number): number {
  // ECC level M indicator = 00, then 3 mask bits; BCH(15,5), generator 0x537, XOR mask 0x5412.
  const data = (0b00 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormat(grid: Grid, size: number, mask: number) {
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) grid[i]![8] = bit(i);
  grid[7]![8] = bit(6);
  grid[8]![8] = bit(7);
  grid[8]![7] = bit(8);
  for (let i = 9; i < 15; i++) grid[8]![14 - i] = bit(i);
  for (let i = 0; i < 8; i++) grid[8]![size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) grid[size - 15 + i]![8] = bit(i);
  grid[size - 8]![8] = true;
}

function penalty(grid: Grid, size: number): number {
  let score = 0;
  const lines: boolean[][] = [];
  for (let y = 0; y < size; y++) lines.push(grid[y]!.map((c) => c === true));
  for (let x = 0; x < size; x++) lines.push(grid.map((row) => row[x] === true));
  // Rule 1: runs of >= 5 same-colour modules.
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
  }
  // Rule 2: 2x2 blocks.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = grid[y]![x];
      if (v === grid[y]![x + 1] && v === grid[y + 1]![x] && v === grid[y + 1]![x + 1]) score += 3;
    }
  }
  // Rule 3: finder-like patterns 1011101 with a 4-module light run on either side.
  for (const line of lines) {
    for (let i = 0; i + 7 <= line.length; i++) {
      const pat = [true, false, true, true, true, false, true];
      let match = true;
      for (let j = 0; j < 7; j++) if (line[i + j] !== pat[j]) { match = false; break; }
      if (!match) continue;
      const before = i >= 4 && !line[i - 1] && !line[i - 2] && !line[i - 3] && !line[i - 4];
      const after = i + 11 <= line.length && !line[i + 7] && !line[i + 8] && !line[i + 9] && !line[i + 10];
      if (before || after) score += 40;
    }
  }
  // Rule 4: dark-module proportion.
  let dark = 0;
  for (const row of grid) for (const c of row) if (c === true) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * 10;
  return score;
}

/** Encodes text into a QR module matrix (true = dark). No quiet zone. */
export function qrMatrix(text: string, forcedMask?: number): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text));
  let version = 0;
  for (let v = 1; v <= 6; v++) {
    const spec = ECC_M_TABLE[v];
    if (!spec) continue;
    const dataCapacity = spec.totalCodewords - spec.eccPerBlock * spec.blocks;
    if (bytes.length <= dataCapacity - 2) { version = v; break; }
  }
  if (version === 0) throw new Error("Text too long for QR versions 1–6 at ECC M");
  const codewords = interleaveWithEcc(dataCodewords(bytes, version), version);
  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  const masksToTry = forcedMask !== undefined ? [forcedMask] : [0, 1, 2, 3, 4, 5, 6, 7];
  for (const mask of masksToTry) {
    const { grid, size } = baseMatrix(version);
    placeData(grid, size, codewords, version);
    const maskFn = MASKS[mask];
    if (!maskFn) continue;
    // Mask applies to data areas only — null cells are all filled by now,
    // so re-derive data cells: they are the ones placeData wrote. We track
    // them by re-running placement on a marker grid is overkill; instead
    // apply the mask before format drawing using the reserved-cell map
    // from a fresh base matrix.
    const reserved = baseMatrix(version).grid;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (reserved[y]![x] === null && maskFn(x, y)) grid[y]![x] = grid[y]![x] !== true;
      }
    }
    drawFormat(grid, size, mask);
    const filled = grid.map((row) => row.map((c) => c === true));
    if (forcedMask !== undefined) return filled;
    const s = penalty(grid, size);
    if (s < bestScore) { bestScore = s; best = filled; }
  }
  if (!best) throw new Error("QR encoding failed");
  return best;
}
