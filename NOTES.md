# Sokoban solver — design notes

Entry for make.fun `sokoban-solver-01-run-20261121`. One self-contained
`main.ts` (Node 22, built-ins only). It reads each instance's
`/input/<id>/level.txt` (XSB) and writes `/output/<id>/solution.txt` with
the player's moves in `u/d/l/r`.

## Scoring strategy

An instance pays 1,000 points only at the push optimum P\*; one push over
halves it (500·P\*/pushes), and only pushes count — walking is free. So the
whole design is about *provably push-optimal* solutions, fast enough to
never risk the 60-second set budget, and deterministic enough that the
two grading executions agree byte for byte.

## Decomposition first

The generator builds a one-wide hallway across the board (the player's
row) with 1–4 rooms hanging off it, each room holding 3–4 boxes and as
many goals. A box pushed through a door into the hallway can never come
back, and the reference construction makes P\* the sum of the rooms'
optima — so boxes effectively never leave their rooms. The solver:

1. Removes the player's row and takes the connected floor components as
   rooms; a component's *doors* are its cells adjacent to the hallway,
   each with the hallway cell (*stand*) in front of it. A door may start
   blocked by a box — the player then enters by pushing it in, which the
   room solve handles by starting the player on the stand.
2. Solves the rooms in a fixed order. Between rooms the player simply
   walks (breadth-first, boxes as obstacles); walking costs nothing.
3. For every room but the last, the accepted solution must also let the
   player walk back out to a stand — checked at the optimal push cost
   first, so this never spends a push on generated levels.
4. If anything about a level breaks the split (a box or goal in the
   hallway row, a component whose boxes ≠ goals, a room with no door),
   the same optimal search runs on the whole board instead. Every
   candidate answer is replay-verified in-process before being written;
   anything that fails verification degrades to an empty (valid) file.

## The push-optimal search (per room)

A\* over pushes, not steps:

- **State**: sorted box cells + the canonical representative (smallest
  cell) of the player's reachable region, in a transposition table keyed
  with the best known push count.
- **Expansion**: one flood fill per state gives every legal push — a box
  moves when the player can reach the cell behind it and the cell ahead
  is free — together with the walk strings between pushes.
- **Heuristic**: minimum-cost bipartite matching (Hungarian algorithm)
  between boxes and goals over *single-box push distances*: for each
  goal, a reverse BFS over box positions (player and other boxes
  ignored) gives the exact pushes a lone box needs from any cell.
  Admissible, and cached per box-set since it ignores the player.
- **Pruning**: static dead squares (non-goal cells a box can never
  reach any goal from, from the same reverse BFS), matchings that come
  back infinite, and 2×2 freeze blocks (a solid 2×2 of walls/boxes
  holding a box that is not on a goal can never move again).

Rooms hold at most 4 boxes on small floors, so this search closes them
at the true optimum almost immediately; the whole-board fallback keeps
the same machinery for off-pattern levels.

## Determinism and budgets

No clock reads, no randomness, fixed iteration orders and tie-breaks
everywhere (heap ties break by f, then h, then insertion order). Search
budgets are counted in expanded nodes — 220k per room attempt, 700k for
a whole-board fallback, 2.4M across the set — far above anything the
generated levels have needed, and far inside the time and memory limits
at the observed cost per expansion.

## Measured results

- Kit practice set (P\* = 13/16/29/47/60): every instance solved at
  exactly P\* — `grade-local` score **1,000,000** (the maximum), all 5
  answered, passed; the grader's second execution reproduced the first
  byte for byte. Local runtime ≈ 0.3 s for the set.
- Stress: 12 additional sets drawn with the kit's own generator from
  random seeds (60 instances): every instance solved at exactly the
  manifest's P\*, worst set runtime ≈ 0.6 s.
