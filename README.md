# Platoon Tactics — critical contract fixes

**Do not paste these files over the Replit tree blindly.**  
Several of these changes may already exist in the current repl (subdue-after-combat, captive fog, 94+ tests). **Diff first, then merge.**

## Contents (paths as they appear in the monorepo)

| Path | Change |
|------|--------|
| `artifacts/api-server/src/game/engine.ts` | Return Fire Phase-A batching; `isLeader` on soldier; leader-only `subdueOrder`; captive fog (omit live x/z + carrier when enemy-held and unobserved); subdue wind-up then commit after combat; honest `objectiveCompleted` |
| `lib/platoontactics-shared/src/index.ts` | `SoldierState.isLeader?` |
| `artifacts/rangeguard/src/App.tsx` | Default `MatchMode` = `capture` |
| `artifacts/rangeguard/src/game/Game.tsx` | Subdue hint only if `enemy.isLeader` |

## Apply

1. Diff each file against the current repl.
2. Keep any later Replit work that is not in this zip (tests, bot, HUD).
3. Add a Return Fire symmetry test if missing: Engage vs Return Fire, both faction orderings, equal first-tick shot counts.
4. `pnpm validate`
5. Smoke: Capture — subdue works on enemy captain only. Classic — subdue is a no-op.

## Do not ship

This zip is source only. Do not include or deploy a checked-in `dist/` with a hardcoded Vercel path.
