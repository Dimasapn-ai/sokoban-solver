// Sokoban solver for make.fun sokoban-solver-01-run-20261121 (see NOTES.md).
// Generated levels are a hallway row with 1-4 sealed rooms hanging off it;
// every box belongs to one room and can never leave it, so the level's push
// optimum is the sum of the rooms' push optima. We solve room by room with
// an exact push-optimal A* and walk (free) between rooms; if a level does
// not decompose cleanly, the same A* runs on the whole board. The A* state
// is sorted box cells + canonical player region, with a Hungarian matching
// heuristic over precomputed single-box push distances, dead-square and
// 2x2-freeze pruning, and a transposition table. Budgets are counted in
// expanded nodes, never wall-clock time, so grading runs agree byte for byte.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const DC = ['u', 'd', 'l', 'r'];
const OPP = [1, 0, 3, 2];
const INF = 1000000000;
const BIG = 1000000;

// Deterministic work budgets, counted in A* node expansions.
const ROOM_CAP = 220000;
const WHOLE_CAP = 700000;
let globalBudget = 2400000;

// ---------------------------------------------------------------- levels

interface Level {
  W: number;
  H: number;
  floor: Uint8Array;
  isGoal: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const raw = text.replace(/\r/g, '').split('\n');
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const H = raw.length;
  let W = 0;
  for (const line of raw) W = Math.max(W, line.length);
  const floor = new Uint8Array(W * H);
  const isGoal = new Uint8Array(W * H);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < H; y++) {
    const line = raw[y];
    for (let x = 0; x < W; x++) {
      const ch = x < line.length ? line[x] : '#';
      if (ch === '#') continue;
      const c = y * W + x;
      floor[c] = 1;
      if (ch === '.' || ch === '*' || ch === '+') { isGoal[c] = 1; goals.push(c); }
      if (ch === '$' || ch === '*') boxes.push(c);
      if (ch === '@' || ch === '+') player = c;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { W, H, floor, isGoal, goals, boxes, player };
}

// Neighbour cell index in direction d, or -1 when off the board.
function nbor(W: number, H: number, c: number, d: number): number {
  const x = (c % W) + DX[d];
  const y = ((c / W) | 0) + DY[d];
  if (x < 0 || y < 0 || x >= W || y >= H) return -1;
  return y * W + x;
}

// Player flood fill over `pass` cells avoiding `blocked` (boxes), with a
// parent array for walk reconstruction.
function flood(W: number, H: number, pass: Uint8Array, blocked: Uint8Array, start: number): { seen: Uint8Array; prev: Int32Array } {
  const seen = new Uint8Array(W * H);
  const prev = new Int32Array(W * H).fill(-1);
  const queue = [start];
  seen[start] = 1;
  prev[start] = start;
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi];
    for (let d = 0; d < 4; d++) {
      const n = nbor(W, H, c, d);
      if (n < 0 || seen[n] === 1 || pass[n] === 0 || blocked[n] === 1) continue;
      seen[n] = 1;
      prev[n] = c;
      queue.push(n);
    }
  }
  return { seen, prev };
}

function walkString(W: number, prev: Int32Array, from: number, to: number): string {
  if (from === to) return '';
  const letters: string[] = [];
  let c = to;
  while (c !== from) {
    const p = prev[c];
    const diff = c - p;
    letters.push(diff === 1 ? 'r' : diff === -1 ? 'l' : diff === W ? 'd' : 'u');
    c = p;
  }
  letters.reverse();
  return letters.join('');
}

// ------------------------------------------------------------- heuristic

// Minimum-cost bipartite matching (JV-style potentials), rows = boxes,
// cols = goals, rows <= cols. Returns INF when no finite matching exists.
function hungarian(cost: number[][]): number {
  const n = cost.length;
  const m = cost[0].length;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(INF);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = -1;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else { minv[j] -= delta; }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  let total = 0;
  for (let j = 1; j <= m; j++) {
    if (p[j] !== 0) {
      const c = cost[p[j] - 1][j - 1];
      if (c >= BIG) return INF;
      total += c;
    }
  }
  return total;
}

// ---------------------------------------------------------- sub-problems

interface Sub {
  W: number;
  H: number;
  passP: Uint8Array;   // cells the player may occupy during the solve
  passB: Uint8Array;   // cells a box may occupy
  goals: number[];
  goalSet: Uint8Array;
  dist: Int32Array[];  // dist[g][cell] = single-box push distance to goal g
  dead: Uint8Array;    // box cells (non-goal) that can never reach a goal
  stands: number[];    // outside cells the player must be able to regain (exit)
}

function buildSub(W: number, H: number, passP: Uint8Array, passB: Uint8Array, goals: number[], stands: number[]): Sub {
  const goalSet = new Uint8Array(W * H);
  for (const g of goals) goalSet[g] = 1;
  const dist: Int32Array[] = [];
  const live = new Uint8Array(W * H);
  for (const g of goals) {
    const dg = new Int32Array(W * H).fill(INF);
    dg[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const c = queue[qi];
      for (let d = 0; d < 4; d++) {
        // A box on c was pushed along d from p = c - d, player standing on c - 2d.
        const p = nbor(W, H, c, OPP[d]);
        if (p < 0 || passB[p] === 0 || dg[p] !== INF) continue;
        const s = nbor(W, H, p, OPP[d]);
        if (s < 0 || passP[s] === 0) continue;
        dg[p] = dg[c] + 1;
        queue.push(p);
      }
    }
    dist.push(dg);
    for (let c = 0; c < W * H; c++) if (dg[c] !== INF) live[c] = 1;
  }
  const dead = new Uint8Array(W * H);
  for (let c = 0; c < W * H; c++) {
    if (passB[c] === 1 && goalSet[c] === 0 && live[c] === 0) dead[c] = 1;
  }
  return { W, H, passP, passB, goals, goalSet, dist, dead, stands };
}

// ------------------------------------------------------------------- A*

interface ANode {
  boxes: number[];
  player: number;      // exact player cell (where the last push left them)
  g: number;
  h: number;
  parent: number;
  seg: string;         // walk letters + push letter from the parent node
  key: string;
}

class Heap {
  items: number[] = [];
  nodes: ANode[];
  constructor(nodes: ANode[]) { this.nodes = nodes; }
  get size(): number { return this.items.length; }
  private less(a: number, b: number): boolean {
    const na = this.nodes[a];
    const nb = this.nodes[b];
    const fa = na.g + na.h;
    const fb = nb.g + nb.h;
    if (fa !== fb) return fa < fb;
    if (na.h !== nb.h) return na.h < nb.h;
    return a < b; // insertion order breaks the last tie, deterministically
  }
  push(i: number): void {
    const it = this.items;
    it.push(i);
    let c = it.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!this.less(it[c], it[p])) break;
      [it[c], it[p]] = [it[p], it[c]];
      c = p;
    }
  }
  pop(): number {
    const it = this.items;
    const top = it[0];
    const last = it.pop() as number;
    if (it.length > 0) {
      it[0] = last;
      let c = 0;
      for (;;) {
        const l = 2 * c + 1;
        const r = l + 1;
        let m = c;
        if (l < it.length && this.less(it[l], it[m])) m = l;
        if (r < it.length && this.less(it[r], it[m])) m = r;
        if (m === c) break;
        [it[c], it[m]] = [it[m], it[c]];
        c = m;
      }
    }
    return top;
  }
  peekF(nodes: ANode[]): number {
    if (this.items.length === 0) return INF;
    const n = nodes[this.items[0]];
    return n.g + n.h;
  }
}

function solveSub(
  sub: Sub,
  startBoxes: number[],
  startPlayer: number,
  cap: number,
  needExit: boolean,
  hardExit: boolean,
): { moves: string; pushes: number; endPlayer: number } | null {
  const { W, H } = sub;
  const hCache = new Map<string, number>();
  const heuristic = (boxes: number[]): number => {
    const key = boxes.join(',');
    const hit = hCache.get(key);
    if (hit !== undefined) return hit;
    let val: number;
    if (boxes.length > sub.goals.length) {
      val = INF;
    } else if (boxes.length === 0) {
      val = 0;
    } else {
      const cost: number[][] = [];
      let bad = false;
      for (const b of boxes) {
        const row: number[] = [];
        for (let gi = 0; gi < sub.goals.length; gi++) {
          const d = sub.dist[gi][b];
          row.push(d >= INF ? BIG : d);
        }
        cost.push(row);
      }
      val = hungarian(cost);
      if (val >= INF) bad = true;
      if (bad) val = INF;
    }
    hCache.set(key, val);
    return val;
  };

  const boxBlocked = (boxes: number[]): Uint8Array => {
    const arr = new Uint8Array(W * H);
    for (const b of boxes) arr[b] = 1;
    return arr;
  };

  // Canonical player representative: smallest cell of the reachable region.
  const regionRep = (boxes: number[], player: number): number => {
    const { seen } = flood(W, H, sub.passP, boxBlocked(boxes), player);
    let rep = player;
    for (let c = 0; c < W * H; c++) if (seen[c] === 1 && c < rep) rep = c;
    return rep;
  };

  const isGoal = (boxes: number[]): boolean => {
    for (const b of boxes) if (sub.goalSet[b] === 0) return false;
    return true;
  };

  const canExit = (node: ANode): boolean => {
    if (sub.stands.length === 0) return true;
    const { seen } = flood(W, H, sub.passP, boxBlocked(node.boxes), node.player);
    for (const s of sub.stands) if (seen[s] === 1) return true;
    return false;
  };

  const h0 = heuristic(startBoxes);
  if (h0 >= INF) return null;
  const nodes: ANode[] = [];
  const start: ANode = {
    boxes: startBoxes,
    player: startPlayer,
    g: 0,
    h: h0,
    parent: -1,
    seg: '',
    key: startBoxes.join(',') + '#' + regionRep(startBoxes, startPlayer),
  };
  nodes.push(start);
  const heap = new Heap(nodes);
  heap.push(0);
  const bestG = new Map<string, number>();
  bestG.set(start.key, 0);

  const reconstruct = (idx: number): { moves: string; pushes: number; endPlayer: number } => {
    const parts: string[] = [];
    let cur = idx;
    let pushes = 0;
    while (nodes[cur].parent >= 0) {
      parts.push(nodes[cur].seg);
      pushes++;
      cur = nodes[cur].parent;
    }
    parts.reverse();
    return { moves: parts.join(''), pushes, endPlayer: nodes[idx].player };
  };

  let expansions = 0;
  let firstGoalIdx = -1;
  let optimalG = -1;

  while (heap.size > 0) {
    if (optimalG >= 0 && heap.peekF(nodes) > optimalG) break;
    const idx = heap.pop();
    const node = nodes[idx];
    if (node.g > (bestG.get(node.key) ?? INF)) continue; // stale heap entry

    if (isGoal(node.boxes)) {
      if (hardExit) {
        if (canExit(node)) return reconstruct(idx);
        continue;
      }
      if (optimalG < 0) { optimalG = node.g; firstGoalIdx = idx; }
      if (!needExit) return reconstruct(idx);
      if (canExit(node)) return reconstruct(idx);
      continue; // solved but the player is trapped: keep looking at this cost
    }
    // Once the cheapest goal is known, only nodes that can still reach a
    // goal at that cost are worth expanding.
    if (optimalG >= 0 && node.g >= optimalG) continue;
    if (expansions >= cap || globalBudget <= 0) break;
    expansions++;
    globalBudget--;

    const blocked = boxBlocked(node.boxes);
    const { seen, prev } = flood(W, H, sub.passP, blocked, node.player);
    const boxSet = new Set(node.boxes);

    for (let bi = 0; bi < node.boxes.length; bi++) {
      const b = node.boxes[bi];
      for (let d = 0; d < 4; d++) {
        const stand = nbor(W, H, b, OPP[d]);
        if (stand < 0 || seen[stand] === 0) continue;
        const dest = nbor(W, H, b, d);
        if (dest < 0 || sub.passB[dest] === 0) continue;
        if (boxSet.has(dest)) continue;
        if (sub.dead[dest] === 1) continue;
        // 2x2 freeze: a solid 2x2 of walls/boxes holding a non-goal box is stuck.
        let frozen = false;
        const dxs = [0, -1, 0, -1];
        const dys = [0, 0, -1, -1];
        const destX = dest % W;
        const destY = (dest / W) | 0;
        for (let s = 0; s < 4 && !frozen; s++) {
          const cx = destX + dxs[s];
          const cy = destY + dys[s];
          if (cx < 0 || cy < 0 || cx + 1 >= W || cy + 1 >= H) continue;
          const cells = [cy * W + cx, cy * W + cx + 1, (cy + 1) * W + cx, (cy + 1) * W + cx + 1];
          let solid = true;
          let hasLooseBox = false;
          for (const cc of cells) {
            const isBox = cc === dest || (boxSet.has(cc) && cc !== b);
            if (isBox) {
              if (sub.goalSet[cc] === 0) hasLooseBox = true;
            } else if (sub.passB[cc] === 1) {
              solid = false;
              break;
            }
          }
          if (solid && hasLooseBox) frozen = true;
        }
        if (frozen) continue;

        const newBoxes = node.boxes.slice();
        newBoxes[bi] = dest;
        newBoxes.sort((x, y) => x - y);
        const h = heuristic(newBoxes);
        if (h >= INF) continue;
        const g2 = node.g + 1;
        // The player ends the push standing on the box's old cell.
        const rep = regionRep(newBoxes, b);
        const key = newBoxes.join(',') + '#' + rep;
        if (g2 >= (bestG.get(key) ?? INF)) continue;
        bestG.set(key, g2);
        const seg = walkString(W, prev, node.player, stand) + DC[d];
        nodes.push({ boxes: newBoxes, player: b, g: g2, h, parent: idx, seg, key });
        heap.push(nodes.length - 1);
      }
    }
  }

  if (firstGoalIdx >= 0 && !needExit) return reconstruct(firstGoalIdx);
  if (firstGoalIdx >= 0 && needExit && !hardExit) {
    // No equally cheap solution lets the player back out; rerun with the
    // exit requirement inside the goal test and pay the difference.
    const again = solveSub(sub, startBoxes, startPlayer, cap, true, true);
    if (again) return again;
    return reconstruct(firstGoalIdx);
  }
  return null;
}

// ------------------------------------------------------------ verification

// Replay a move string on the parsed level; every candidate solution is
// verified through this before it is written out.
function replay(L: Level, moves: string): boolean {
  const boxes = new Set(L.boxes);
  let player = L.player;
  for (const ch of moves) {
    const d = DC.indexOf(ch);
    if (d < 0) return false;
    const next = nbor(L.W, L.H, player, d);
    if (next < 0 || L.floor[next] === 0) return false;
    if (boxes.has(next)) {
      const beyond = nbor(L.W, L.H, next, d);
      if (beyond < 0 || L.floor[beyond] === 0 || boxes.has(beyond)) return false;
      boxes.delete(next);
      boxes.add(beyond);
    }
    player = next;
  }
  for (const b of boxes) if (L.isGoal[b] === 0) return false;
  return true;
}

// ----------------------------------------------------------- decomposition

interface Room {
  cells: number[];
  doors: { door: number; stand: number }[];
  stands: number[];
  boxes: number[];
  goals: number[];
}

function tryDecomposed(L: Level): string | null {
  const { W, H } = L;
  const prow = (L.player / W) | 0;
  // Boxes or goals sitting in the hallway row itself break the split.
  for (const b of L.boxes) if (((b / W) | 0) === prow) return null;
  for (const g of L.goals) if (((g / W) | 0) === prow) return null;

  // Connected components of the floor once the hallway row is removed.
  const regionOf = new Int32Array(W * H).fill(-1);
  const regions: number[][] = [];
  for (let c = 0; c < W * H; c++) {
    if (L.floor[c] === 0 || ((c / W) | 0) === prow || regionOf[c] >= 0) continue;
    const id = regions.length;
    const cells: number[] = [];
    const queue = [c];
    regionOf[c] = id;
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi];
      cells.push(cur);
      for (let d = 0; d < 4; d++) {
        const n = nbor(W, H, cur, d);
        if (n < 0 || L.floor[n] === 0 || ((n / W) | 0) === prow || regionOf[n] >= 0) continue;
        regionOf[n] = id;
        queue.push(n);
      }
    }
    regions.push(cells);
  }

  const boxSet0 = new Set(L.boxes);
  const goalSet0 = new Set(L.goals);
  const rooms: Room[] = [];
  for (const cells of regions) {
    const boxes = cells.filter((c) => boxSet0.has(c)).sort((a, b) => a - b);
    const goals = cells.filter((c) => goalSet0.has(c)).sort((a, b) => a - b);
    if (boxes.length === 0 && goals.length === 0) continue; // empty alcove
    if (boxes.length === 0 || boxes.length !== goals.length) return null;
    if (boxes.length > 8) return null;
    const doorMap = new Map<number, number>();
    for (const c of cells) {
      for (let d = 0; d < 4; d++) {
        const n = nbor(W, H, c, d);
        if (n < 0 || L.floor[n] === 0) continue;
        if (regionOf[n] === -1 && ((n / W) | 0) === prow) doorMap.set(c, n);
      }
    }
    if (doorMap.size === 0) return null;
    const doors = [...doorMap.entries()]
      .map(([door, stand]) => ({ door, stand }))
      .sort((a, b) => a.door - b.door);
    rooms.push({ cells, doors, stands: doors.map((x) => x.stand), boxes, goals });
  }
  if (rooms.length === 0) return null;
  rooms.sort((a, b) => Math.min(...a.cells) - Math.min(...b.cells));

  // Mutable level state as rooms are solved one after another.
  const curBoxes = new Set(L.boxes);
  let curPlayer = L.player;
  let moves = '';

  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri];
    const needExit = ri < rooms.length - 1;
    const passB = new Uint8Array(W * H);
    for (const c of room.cells) passB[c] = 1;
    const passP = passB.slice();
    for (const s of room.stands) passP[s] = 1;
    const sub = buildSub(W, H, passP, passB, room.goals, room.stands);
    const startBoxes = room.boxes.filter((b) => curBoxes.has(b)).sort((a, b) => a - b);
    if (startBoxes.length !== room.boxes.length) return null;

    let best: { total: string; pushes: number; endPlayer: number } | null = null;
    for (const { door, stand } of room.doors) {
      const doorBlocked = curBoxes.has(door);
      const walkTarget = doorBlocked ? stand : door;
      const blockedArr = new Uint8Array(W * H);
      for (const b of curBoxes) blockedArr[b] = 1;
      const { seen, prev } = flood(W, H, L.floor, blockedArr, curPlayer);
      if (seen[walkTarget] === 0) continue;
      const walk = walkString(W, prev, curPlayer, walkTarget);
      const res = solveSub(sub, startBoxes, walkTarget, ROOM_CAP, needExit, false);
      if (!res) continue;
      if (!best || res.pushes < best.pushes) {
        best = { total: walk + res.moves, pushes: res.pushes, endPlayer: res.endPlayer };
      }
    }
    if (!best) return null;
    moves += best.total;
    for (const b of room.boxes) curBoxes.delete(b);
    for (const g of room.goals) curBoxes.add(g);
    curPlayer = best.endPlayer;
  }
  return moves;
}

function tryWhole(L: Level): string | null {
  const sub = buildSub(L.W, L.H, L.floor, L.floor, L.goals, []);
  const res = solveSub(sub, L.boxes, L.player, WHOLE_CAP, false, false);
  return res ? res.moves : null;
}

function solveLevel(text: string): string {
  const L = parseLevel(text);
  if (L.player < 0 || L.boxes.length === 0) return '';
  const decomposed = tryDecomposed(L);
  if (decomposed !== null && replay(L, decomposed)) return decomposed;
  const whole = tryWhole(L);
  if (whole !== null && replay(L, whole)) return whole;
  return '';
}

// ------------------------------------------------------------------ main

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
