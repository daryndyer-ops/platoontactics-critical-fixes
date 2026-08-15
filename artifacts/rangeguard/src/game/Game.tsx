// PlatoonTactics — in-match orchestrator + input controller.
// Owns selection state, drone control mode, keybinds, and order dispatch.
import { useEffect, useRef, useState } from 'react';
import { MATCH, SOLDIER_DEFS, SUBDUE_RANGE, isActive, knownThreats, type ClientMessage, type Faction, type FireControl, type MatchMode, type ShotEvent, type SoldierState, type TickState, type Zone } from '@workspace/platoontactics-shared';
import { Scene, type CorpseGhost, type TracerEntry } from './Scene';
import { CommandPanel, ConnectionLost, HudHeader, KeyHints, KillFeed, type FeedEntry } from './hud';

type DroneMode = 'idle' | 'deploying' | 'steering';

/** How long a tracer stays on screen (fading) after its tick arrived. */
export const TRACER_LIFE_MS = 250;
const FEED_LIFE_MS = 7000;

export function Game({ state, faction, zones, mode, send, connected, onLeave }: {
  state: TickState | null;
  faction: Faction;
  zones: Zone[];
  mode: MatchMode;
  send: (m: ClientMessage) => void;
  connected: boolean;
  onLeave: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [droneMode, setDroneMode] = useState<DroneMode>('idle');
  const [suppressionMode, setSuppressionMode] = useState(false);
  // Combat events are transient properties of a tick (66 ms on the wire).
  // They're copied into local buffers with wall-clock timestamps so tracers
  // and the kill feed outlive the snapshot that carried them.
  const [tracers, setTracers] = useState<TracerEntry[]>([]);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [ghosts, setGhosts] = useState<CorpseGhost[]>([]);
  const [showVision, setShowVision] = useState(true);
  const lastTick = useRef(-1);
  const condSeen = useRef(new Map<string, SoldierState['condition']>());
  const enemyActive = useRef<number | null>(null);
  const prevEnemies = useRef(new Map<string, (typeof soldiers)[number]>());
  const nextId = useRef(0);

  const soldiers = state?.soldiers ?? [];
  const mine = soldiers.filter((s) => s.faction === faction);
  const myDrone = (state?.drones ?? []).find((d) => d.faction === faction);
  const droneStatus = myDrone?.status ?? 'ready';

  // Drop drone control mode once the drone is gone.
  useEffect(() => {
    if ((droneStatus === 'destroyed' || droneStatus === 'depleted') && droneMode !== 'idle') setDroneMode('idle');
  }, [droneStatus, droneMode]);

  // Non-additive by default so HUD cards and 3D clicks behave identically;
  // Shift adds/removes from the selection.
  const toggleUnit = (id: string, additive = false) => {
    setDroneMode('idle');
    setSelected((v) => additive ? (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]) : (v.length === 1 && v[0] === id ? [] : [id]));
  };

  // Prune dead soldiers from the selection as casualties come in.
  useEffect(() => {
    const dead = new Set(mine.filter((s) => !isActive(s)).map((s) => s.id));
    if (dead.size) setSelected((v) => (v.some((id) => dead.has(id)) ? v.filter((id) => !dead.has(id)) : v));
  }, [state]);

  // Per-tick event ingestion: buffer this tick's shots and detect eliminations.
  // Same-tick deaths share ONE feed entry — the engine resolved a tie, and the
  // feed must read like one, not like a sequence.
  useEffect(() => {
    if (!state || state.tick === lastTick.current) return;
    // Tick went backwards → a new match started on this connection. Every
    // buffer holds events from a battlefield that no longer exists.
    if (state.tick < lastTick.current) {
      setTracers([]); setFeed([]); setGhosts([]);
      condSeen.current.clear(); enemyActive.current = null; prevEnemies.current.clear();
    }
    lastTick.current = state.tick;
    const now = performance.now();

    if (state.shots.length || tracers.length) {
      // Carried shots (backpressure merge) arrive stamped with their origin
      // tick: back-date them into the fade curve and drop any already past
      // the tracer window — a seconds-old shot must never render as live
      // fire. Capped so a burst after a stall cannot grow the buffer.
      const TICK_MS = 1000 / MATCH.tickRate;
      setTracers((v) => [
        ...v.filter((t) => now - t.at < TRACER_LIFE_MS + 200),
        ...state.shots
          .map((shot: ShotEvent) => ({
            shot,
            at: shot.tick !== undefined ? now - (state.tick - shot.tick) * TICK_MS : now,
            id: nextId.current++,
          }))
          .filter((t) => now - t.at < TRACER_LIFE_MS),
      ].slice(-256));
    }

    // CAPTURED and DOWN are the Capture mode's central moments — they must
    // not be reported as kills. Transitions are keyed on condition, not a
    // boolean, so each non-active state gets its own feed line.
    const labels: string[] = [];
    for (const s of state.soldiers) {
      const prev = condSeen.current.get(s.id);
      if (prev === 'active' && s.condition !== 'active') {
        const verb = s.condition === 'subdued' ? 'captured' : s.condition === 'downed' ? 'down' : 'eliminated';
        labels.push(`${s.faction === faction ? 'Your' : 'Enemy'} ${SOLDIER_DEFS[s.rank].label} ${verb}`);
      }
      // A rescue (downed/subdued → active) is worth a line too — the enemy
      // leader you were about to win with is back on his feet.
      if ((prev === 'downed' || prev === 'subdued') && s.condition === 'active') {
        labels.push(`${s.faction === faction ? 'Your' : 'Enemy'} ${SOLDIER_DEFS[s.rank].label} rescued`);
      }
      condSeen.current.set(s.id, s.condition);
    }
    // Enemy losses outside your vision never appear as soldier records, but
    // active counts are public — surface them without leaking positions.
    // "Lost", not "down": an unseen count drop cannot distinguish killed
    // from downed from captured.
    const enemy: Faction = faction === 'ukraine' ? 'russia' : 'ukraine';
    const count = state.activeCounts[enemy];
    const seenEnemyLosses = labels.filter((l) => l.startsWith('Enemy') && !l.endsWith('rescued')).length;
    const enemyLossesThisTick = enemyActive.current !== null ? enemyActive.current - count : 0;
    if (enemyActive.current !== null) {
      const unseen = enemyLossesThisTick - seenEnemyLosses;
      for (let i = 0; i < unseen; i++) labels.push('Enemy soldier lost');
    }
    enemyActive.current = count;

    // Fog-safe corpse ghosts: the server drops a dead enemy from the snapshot
    // the tick it dies, which would unmount the model before the fall plays.
    // Only SERVER-WITNESSED deaths become corpses — a unit that merely slips
    // out of view the tick someone else dies must stay an uncertain contact,
    // never be shown dead. (witnessedDeaths is the sole legitimate source.)
    const currentEnemyIds = new Set(state.soldiers.filter((s) => s.faction === enemy).map((s) => s.id));
    const witnessed = (state.witnessedDeaths ?? []).filter((id) => !currentEnemyIds.has(id));
    if (witnessed.length) {
      const fallen = witnessed
        .map((id) => prevEnemies.current.get(id))
        .filter((s): s is NonNullable<typeof s> => !!s)
        .map((s) => ({ s: { ...s, condition: "dead" as const, health: 0, moving: false }, at: now }));
      if (fallen.length) setGhosts((v) => [...v.filter((g) => now - g.at < 1500), ...fallen]);
    } else if (ghosts.length) {
      setGhosts((v) => v.filter((g) => now - g.at < 1500 && !currentEnemyIds.has(g.s.id)));
    }
    prevEnemies.current = new Map(state.soldiers.filter((s) => s.faction === enemy).map((s) => [s.id, s]));

    if (labels.length) setFeed((v) => [...v.filter((e) => now - e.at < FEED_LIFE_MS), { tick: state.tick, at: now, labels }]);
    else if (feed.length && now - feed[0]!.at > FEED_LIFE_MS) setFeed((v) => v.filter((e) => now - e.at < FEED_LIFE_MS));
  }, [state]);

  const stopSelected = () => {
    if (selected.length) send({ type: 'stop_order', soldierIds: selected });
  };

  const setFireControl = (fireControl: FireControl) => {
    if (!selected.length) return;
    if (fireControl === 'suppress') {
      setSuppressionMode(true);
      setDroneMode('idle');
      return;
    }
    setSuppressionMode(false);
    send({ type: 'fire_control_order', soldierIds: selected, fireControl });
  };

  /** Drone button / D key: arm deployment when ready, toggle steering when flying. */
  const droneAction = () => {
    if (droneStatus === 'ready') setDroneMode((m) => (m === 'deploying' ? 'idle' : 'deploying'));
    else if (droneStatus === 'deployed') setDroneMode((m) => (m === 'steering' ? 'idle' : 'steering'));
  };

  /**
   * Contextual right-click on an enemy soldier: with exactly one soldier
   * selected, an active enemy inside SUBDUE_RANGE gets a subdue order;
   * anything else falls through to a move toward the click. Standing on an
   * enemy is not a meaningful order (radius 0.6 vs range 2.0), so the
   * fall-through costs nothing.
   */
  const subdueEligible = (enemy: SoldierState): boolean => {
    if (droneMode !== 'idle' || selected.length !== 1) return false;
    if (enemy.faction === faction || !isActive(enemy) || !enemy.isLeader) return false;
    const mySoldier = mine.find((s) => s.id === selected[0] && isActive(s));
    return !!mySoldier && Math.hypot(enemy.x - mySoldier.x, enemy.z - mySoldier.z) <= SUBDUE_RANGE;
  };

  const onEnemyContext = (enemy: SoldierState) => {
    if (subdueEligible(enemy)) send({ type: 'subdue_order', soldierId: selected[0]!, targetId: enemy.id });
    else onGround(enemy.x, enemy.z);
  };

  const onGround = (x: number, z: number) => {
    if (suppressionMode && selected.length) {
      send({ type: 'suppress_order', soldierIds: selected, target: { x, z } });
      setSuppressionMode(false);
    } else if (droneMode === 'deploying') {
      send({ type: 'deploy_drone', target: { x, z } });
      setDroneMode('steering');
    } else if (droneMode === 'steering') {
      send({ type: 'drone_move', target: { x, z } });
    } else if (selected.length) {
      send({ type: 'move_order', soldierIds: selected, target: { x, z } });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.key === 'Escape') { setSelected([]); setDroneMode('idle'); setSuppressionMode(false); }
      else if (k === '1') setFireControl('hold');
      else if (k === '2') setFireControl('return_fire');
      else if (k === '3') setFireControl('suppress');
      else if (k === '4') setFireControl('engage');
      else if (k === 'd') droneAction();
      else if (k === 's') stopSelected();
      else if (k === 'a') { setDroneMode('idle'); setSelected(mine.filter((s) => isActive(s)).map((s) => s.id)); }
      else if (k === 'v') setShowVision((x) => !x);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <section className="relative h-[100dvh] min-h-[620px] overflow-hidden bg-[#151a19]">
      {/* Right-click is the order button everywhere in the battlespace — the
          browser context menu must never open over the canvas. */}
      <div className="absolute inset-0" onContextMenu={(e) => e.preventDefault()}>
        <Scene state={state} faction={faction} zones={zones} mode={mode} selected={selected} droneSelected={droneMode === 'steering'} onSelect={toggleUnit} onGround={onGround} onEnemyContext={onEnemyContext} subdueEligible={subdueEligible} tracers={tracers} ghosts={ghosts} showVision={showVision} />
      </div>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_35%,rgba(8,10,9,.66))]" />
      <HudHeader state={state} faction={faction} mode={mode} />
      <KillFeed feed={feed} />
      <CommandPanel
        mine={mine}
        threats={state ? knownThreats(state, faction) : []}
        selected={selected}
        onToggleUnit={(id, additive) => toggleUnit(id, additive)}
        myDrone={myDrone}
        droneMode={droneMode}
        onDroneButton={droneAction}
        onStop={stopSelected}
        onFireControl={setFireControl}
        suppressionMode={suppressionMode}
        onLeave={onLeave}
      />
      {!connected && <ConnectionLost />}
      <KeyHints />
    </section>
  );
}
