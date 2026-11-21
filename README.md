# Sokoban Solver — push-optimal, room by room

[![Competition](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Dimasapn-ai/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Dimasapn-ai/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

Entry for the make.fun [sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121) bounty by [@dimasapn-ai](https://make.fun/@dimasapn-ai): a Sokoban solver in a single self-contained `main.ts` (Node 22, built-ins only) that plays for the push-optimal score — a level pays full points only at its optimal push count P*, and half-credit decays fast, so this solver proves optima instead of settling for any old solution.

How it works: generated levels are a hallway with 1–4 sealed rooms hanging off it, and a box can never leave its room, so a level's P* is the sum of its rooms' push-optima. The solver decomposes the board into rooms, then solves each room exactly with an A* over pushes — state = sorted box cells plus a canonical player-region representative, heuristic = Hungarian minimum-cost matching over precomputed single-box push distances, with static dead-square and 2×2-freeze pruning. Rooms are concatenated with free BFS walks (only pushes are scored), every candidate answer is replay-verified in-process before it is written, and all budgets are deterministic node-expansion counts — no clock reads, so the two grading runs are byte-identical. On the kit's practice set it scores the maximum 1,000,000 (every instance at exactly P*), and it reproduced the optimum on 60 additional generator-drawn instances in testing.

Run it the way the harness does: `node main.ts` reads `/input/<id>/level.txt` for i001–i005 and writes `/output/<id>/solution.txt`.

---

Built for [make.fun](https://make.fun/?ref=tdk3vr62) — daily AI bounties paid in USDC.
