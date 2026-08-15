// PlatoonTactics — authoritative match simulation.
import {
  CONTACT_EXPIRY_RADIUS,
  COVER_REDUCTION,
  DRONE,
  MAP,
  MATCH,
  PLATOON_RANKS,
  SOLDIER_DEFS,
  SUBDUE_RANGE,
  SUBDUE_TICKS,
  TACTICS,
  cohesionBand,
  coverFor,
  segmentHitsBox,
  type DroneState,
  type Faction,
  type FireControl,
  type MatchResult,
  type Obstacle,
  type ShotEvent,
  type CarriableKind,
  type CarriablePlacement,
  type CarriableState,
  type DronePlacement,
  type Placement,
  type ContactState,
  type Condition,
  type Zone,
  type Rank,
  type SoldierState,
  type TickState,
  type TimelineEvent,
  type TimelineMoment,
  type Vec2,
} from "@workspace/platoontactics-shared";

const SOLDIER_RADIUS = 0.6;
const HIT_CHANCE = 0.8;
const ARRIVE_EPS = 0.35;

import { ClassicRules, type RuleContext, type RuleSet } from "./rules";

// Placement, DronePlacement, and CarriablePlacement moved to the shared
// package in step 5 (Scenario definitions embed them); re-exported here so
// engine consumers keep one import site.
export type { CarriablePlacement, DronePlacement, Placement };

/**
 * Engine-internal carriable. The wire view (`CarriableState`) deliberately
 * omits pickupFactions/pickupRadius/carrySpeed.
 */
export interface Carriable {
  id: string;
  kind: CarriableKind;
  /** Set when kind === "body" — the downed soldier this carriable IS. */
  soldierId?: string;
  carrierId: string | null;
  x: number;
  z: number;
  pickupFactions: Faction[];
  pickupRadius: number;
  carrySpeed: number;
}

const PICKUP_RADIUS_DEFAULT = 1.5;
const CARRY_SPEED_DEFAULT = 1.0;
/** Carrying a body is slow — the cost that makes recovery a decision. */
const BODY_CARRY_SPEED = 0.55;
/**
 * A subdued captive is ESCORTED rather than carried — faster than a body.
 * That difference is the entire payoff for the risk of the subdue wind-up:
 * shooting a leader down is easier; subduing him gets you home faster.
 */
export const SUBDUE_CARRY_SPEED = 0.8;
// SUBDUE_RANGE and SUBDUE_TICKS moved to the shared package (the client
// renders the wind-up arc and checks order eligibility); re-exported so
// engine consumers keep one import site.
export { SUBDUE_RANGE, SUBDUE_TICKS };
/** Health fraction restored when a body revives in its revivesInZone. */
export const REVIVE_HEALTH_FRACTION = 0.5;

/**
 * Observation dwell is CONTINUOUS, not cumulative: this is what dwell
 * returns to the moment LOS breaks. Deliberate design — cumulative dwell
 * would let a player peek repeatedly from safety, while continuous dwell
 * requires holding an exposed position, which is the decision the mechanic
 * exists to create. Retune here, not in the loop.
 */
const DWELL_VALUE_ON_LOS_BREAK = 0;

export interface MatchOptions {
  /** Injectable so combat outcomes are testable deterministically. */
  rng?: () => number;
  /** Win conditions and objective accrual. Defaults to ClassicRules. */
  rules?: RuleSet;
  /**
   * Exact starting roster. When omitted, both sides are built from
   * MAP.spawns with one soldier per PLATOON_RANKS entry (current default).
   * When present, this is the COMPLETE roster — no defaults are merged in.
   * A scenario that wants five per side lists ten placements.
   */
  placements?: Placement[];
  /**
   * Drones staged airborne at construction. Tests use this instead of
   * flying a drone into position, which would couple them to flight-speed
   * tuning. Factions not listed keep the default grounded drone.
   */
  drones?: DronePlacement[];
  /**
   * Objects that can be carried, dropped, and delivered. Follows the drones
   * pattern: absent in default matches, which must behave identically.
   */
  carriables?: CarriablePlacement[];
  /** Static zones, sent once in match_start. Rules test containment. */
  zones?: Zone[];
}

/**
 * Soldier ids for a faction-filtered placement list, in placement order:
 * `${faction}-${rank}` for the first of a rank, `-${n}` (n from 2) for
 * duplicates. The single source of the id scheme — buildSide consumes it,
 * and scenario validation resolves outcome-rule unit ids through it.
 */
export function rosterIds(placements: Placement[]): string[] {
  const rankCounts = new Map<string, number>();
  return placements.map((p) => {
    const key = `${p.faction}-${p.rank}`;
    const n = (rankCounts.get(key) ?? 0) + 1;
    rankCounts.set(key, n);
    return n === 1 ? key : `${key}-${n}`;
  });
}

/**
 * The default roster: exactly what every match fielded before placements
 * existed — one soldier per PLATOON_RANKS entry per faction, at MAP.spawns,
 * facing the enemy side.
 */
export function defaultPlacements(): Placement[] {
  const out: Placement[] = [];
  for (const faction of ["ukraine", "russia"] as Faction[]) {
    PLATOON_RANKS.forEach((rank, i) => {
      const spawn = MAP.spawns[faction][i]!;
      out.push({ faction, rank, x: spawn.x, z: spawn.z });
    });
  }
  return out;
}

/**
 * Reject bad rosters at construction rather than clamping silently —
 * clamping would hide scenario authoring errors until someone noticed a
 * unit that could not move (a soldier spawned inside a blocksMovement
 * obstacle is one findPath can never route out of).
 */
function validatePlacements(placements: Placement[]): void {
  for (const f of ["ukraine", "russia"] as Faction[]) {
    if (!placements.some((p) => p.faction === f)) {
      throw new Error(`placements: faction "${f}" has an empty roster`);
    }
  }
  for (const p of placements) {
    if (Math.abs(p.x) > MAP.size || Math.abs(p.z) > MAP.size) {
      throw new Error(
        `placements: ${p.faction} ${p.rank} at (${p.x}, ${p.z}) is outside map bounds (±${MAP.size})`,
      );
    }
    for (const o of MOVE_BLOCKERS) {
      // Padded by the path grid's inflation (SOLDIER_RADIUS + 0.3), not the
      // geometric edge: a soldier accepted here must be one findPath can
      // route out of, and the grid treats anything inside this footprint as
      // blocked. A bare-edge spawn would validate yet be unroutable.
      if (pointInBox(p.x, p.z, o, SOLDIER_RADIUS + 0.3)) {
        throw new Error(
          `placements: ${p.faction} ${p.rank} at (${p.x}, ${p.z}) is inside obstacle "${o.id}" (movement-inflated footprint)`,
        );
      }
    }
  }
}

export interface Soldier extends SoldierState {
  target: Vec2 | null;
  /** Remaining waypoints toward `target` (A*-planned, string-pulled). */
  path: Vec2[];
  cooldown: number;
  /** Carriable id, or null. A soldier carries at most one thing. */
  carrying: string | null;
  /** Lethal damage leaves this soldier `downed` instead of `dead`. */
  downOnLethal: boolean;
  /** Who may carry this soldier's body once downed. */
  bodyPickupFactions: Faction[];
  /** Zone in which this soldier's body carriable revives them, or null. */
  revivesInZone: string | null;
  /** Ground point used by suppress fire; never trusted from the client unchecked. */
  suppressionTarget: Vec2 | null;
  /** Last tick this soldier was directly fired upon. */
  recentAttackerTick: number;
  /** Capture-mode leader. Only leaders may be subdued. */
  isLeader: boolean;
}

export interface Drone extends DroneState {
  target: Vec2 | null;
}

export interface Side {
  faction: Faction;
  soldiers: Soldier[];
  drone: Drone;
}

/**
 * A shot as the simulation recorded it — unfiltered, with the shooter's
 * identity. Never leaves the engine: `snapshot()` derives a per-viewer
 * `ShotEvent` from it, withholding the origin when the viewer cannot see
 * the shooter.
 */
/**
 * One viewer faction's memory of an enemy unit. While the unit is observed
 * the position refreshes every tick; the moment observation lapses it is
 * FROZEN — the server never sends a fresher position for an unobserved unit
 * than the last one legitimately observed.
 */
interface ContactMemory {
  kind: "soldier" | "drone";
  faction: Faction;
  rank?: Rank;
  x: number;
  z: number;
  /** Match clock when last observed. */
  seenAt: number;
  /** Public movement speed — drives radius-based expiry. */
  speed: number;
}

interface ShotRecord {
  shooter: Faction;
  /** Faction of the soldier hit (undefined for drone shots). Impact feedback
   * for your own soldier must survive that soldier dying this very tick. */
  targetFaction?: Faction;
  fx: number;
  fz: number;
  tx: number;
  tz: number;
  hit: boolean;
  targetKind: "soldier" | "drone";
}

export interface EndCallbackPayload {
  result: MatchResult;
}

const FACTIONS: Faction[] = ["ukraine", "russia"];

/** Clamp an order target to the playable area (the wire only checks finiteness). */
function clampToMap(v: Vec2): Vec2 {
  return {
    x: Math.max(-MAP.size, Math.min(MAP.size, v.x)),
    z: Math.max(-MAP.size, Math.min(MAP.size, v.z)),
  };
}

function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

/** Shoots, moves under own power, contributes to team vision. */
const canAct = (s: Soldier): boolean => s.condition === "active";

/**
 * May be fired upon. Hors de combat is not a target.
 * Identical to `canAct` today; separated deliberately — mercy rules and any
 * "finish the wounded" behaviour change one and not the other.
 */
const isTargetable = (s: Soldier): boolean => s.condition === "active";
const otherFaction = (f: Faction): Faction =>
  f === "ukraine" ? "russia" : "ukraine";

/**
 * Occupies a position on the map; can be carried or recovered.
 * Active since Objective Substrate step 6a: a downed soldier is present —
 * visible in snapshots, cover-tracked, contact-refreshed — while the dead
 * remain absent (corpse ghosts stay client-side via witnessedDeaths).
 */
const isPresent = (s: Soldier): boolean => s.condition !== "dead";

// segmentHitsBox, coverFor, and nearCover moved to the shared package (HUD
// Cover Readout work order): the client's readout must call the exact cover
// function the damage model calls, so both import one implementation.

function pointInBox(x: number, z: number, o: Obstacle, pad = 0): boolean {
  return (
    x >= o.x - o.w / 2 - pad &&
    x <= o.x + o.w / 2 + pad &&
    z >= o.z - o.d / 2 - pad &&
    z <= o.z + o.d / 2 + pad
  );
}

const SIGHT_BLOCKERS = MAP.obstacles.filter((o) => o.blocksSight);
const MOVE_BLOCKERS = MAP.obstacles.filter((o) => o.blocksMovement);

/**
 * Ground-level line of sight between two points, with ZERO obstacle padding.
 * The 0-pad here versus the 0.4 pad in `coverFor()` is deliberate — see the
 * comment there. Any change to either pad changes the peek mechanic.
 */
function hasLineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
  for (const o of SIGHT_BLOCKERS) {
    if (segmentHitsBox(ax, az, bx, bz, o)) return false;
  }
  return true;
}

/**
 * Can soldier `s` personally see ground point (x, z)?
 * Rule: can act, within the soldier's own vision range, with ground LOS.
 * Team-level sight (any soldier or the drone) is `visibleTo`, not this.
 */
function soldierSees(s: Soldier, x: number, z: number): boolean {
  return (
    canAct(s) &&
    dist(s.x, s.z, x, z) <= SOLDIER_DEFS[s.rank].visionRange &&
    hasLineOfSight(s.x, s.z, x, z)
  );
}

function blockedAt(x: number, z: number): boolean {
  if (Math.abs(x) > MAP.size || Math.abs(z) > MAP.size) return true;
  for (const o of MOVE_BLOCKERS) {
    if (pointInBox(x, z, o, SOLDIER_RADIUS)) return true;
  }
  return false;
}

// ----- Pathfinding (A* on a coarse grid, with string-pulling) ---------------

const CELL = 2;
const GRID_N = Math.floor((MAP.size * 2) / CELL) + 1;

function toCell(v: number): number {
  return Math.max(0, Math.min(GRID_N - 1, Math.round((v + MAP.size) / CELL)));
}
function toWorld(c: number): number {
  return c * CELL - MAP.size;
}
function cellIdx(c: number, r: number): number {
  return r * GRID_N + c;
}

const BLOCKED_CELLS: boolean[] = (() => {
  const blocked = new Array<boolean>(GRID_N * GRID_N).fill(false);
  for (let r = 0; r < GRID_N; r++) {
    for (let c = 0; c < GRID_N; c++) {
      const x = toWorld(c);
      const z = toWorld(r);
      for (const o of MOVE_BLOCKERS) {
        if (pointInBox(x, z, o, SOLDIER_RADIUS + 0.3)) {
          blocked[cellIdx(c, r)] = true;
          break;
        }
      }
    }
  }
  return blocked;
})();

/** Straight segment walkable check (padded against movement blockers). */
function walkable(ax: number, az: number, bx: number, bz: number): boolean {
  if (Math.abs(bx) > MAP.size || Math.abs(bz) > MAP.size) return false;
  for (const o of MOVE_BLOCKERS) {
    if (segmentHitsBox(ax, az, bx, bz, o, SOLDIER_RADIUS)) return false;
  }
  return true;
}

/** Nearest unblocked cell to (c, r), searched in growing rings. */
function nearestFreeCell(c: number, r: number): [number, number] | null {
  if (!BLOCKED_CELLS[cellIdx(c, r)]) return [c, r];
  for (let ring = 1; ring < 8; ring++) {
    for (let dc = -ring; dc <= ring; dc++) {
      for (let dr = -ring; dr <= ring; dr++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
        const nc = c + dc;
        const nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= GRID_N || nr >= GRID_N) continue;
        if (!BLOCKED_CELLS[cellIdx(nc, nr)]) return [nc, nr];
      }
    }
  }
  return null;
}

/**
 * Nearest free cell that is also directly walkable from the exact world
 * position (sx, sz). Guarantees the path's first segment never clips an
 * obstacle. Searched in growing rings.
 */
function reachableStartCell(sx: number, sz: number): [number, number] | null {
  const c0 = toCell(sx);
  const r0 = toCell(sz);
  for (let ring = 0; ring < 8; ring++) {
    for (let dc = -ring; dc <= ring; dc++) {
      for (let dr = -ring; dr <= ring; dr++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
        const nc = c0 + dc;
        const nr = r0 + dr;
        if (nc < 0 || nr < 0 || nc >= GRID_N || nr >= GRID_N) continue;
        if (BLOCKED_CELLS[cellIdx(nc, nr)]) continue;
        if (walkable(sx, sz, toWorld(nc), toWorld(nr))) return [nc, nr];
      }
    }
  }
  return null;
}

/**
 * A* from (sx, sz) to (tx, tz). Returns world-space waypoints (excluding the
 * start, ending at the target or the nearest reachable point), or null when
 * no route exists. Straight shots skip A* entirely. Every returned segment —
 * including exact start → first waypoint — passes walkable().
 */
function findPath(sx: number, sz: number, tx: number, tz: number): Vec2[] | null {
  if (walkable(sx, sz, tx, tz)) return [{ x: tx, z: tz }];

  const startCell = reachableStartCell(sx, sz);
  const goalCell = nearestFreeCell(toCell(tx), toCell(tz));
  if (!startCell || !goalCell) return null;
  const [gc, gr] = goalCell;
  const start = cellIdx(startCell[0], startCell[1]);
  const goal = cellIdx(gc, gr);

  const g = new Map<number, number>([[start, 0]]);
  const cameFrom = new Map<number, number>();
  const open: [number, number][] = [[0, start]]; // [f, idx] — small grid, linear extract is fine
  const closed = new Set<number>();

  while (open.length) {
    let best = 0;
    for (let i = 1; i < open.length; i++) if (open[i]![0] < open[best]![0]) best = i;
    const [, cur] = open.splice(best, 1)[0]!;
    if (cur === goal) break;
    if (closed.has(cur)) continue;
    closed.add(cur);
    const cc = cur % GRID_N;
    const cr = Math.floor(cur / GRID_N);
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (dc === 0 && dr === 0) continue;
        const nc = cc + dc;
        const nr = cr + dr;
        if (nc < 0 || nr < 0 || nc >= GRID_N || nr >= GRID_N) continue;
        const ni = cellIdx(nc, nr);
        if (BLOCKED_CELLS[ni] || closed.has(ni)) continue;
        // No diagonal corner-cutting.
        if (
          dc !== 0 &&
          dr !== 0 &&
          (BLOCKED_CELLS[cellIdx(cc + dc, cr)] || BLOCKED_CELLS[cellIdx(cc, cr + dr)])
        ) {
          continue;
        }
        const cost = (g.get(cur) ?? Infinity) + (dc !== 0 && dr !== 0 ? 1.414 : 1);
        if (cost < (g.get(ni) ?? Infinity)) {
          g.set(ni, cost);
          cameFrom.set(ni, cur);
          const h = Math.hypot(nc - gc, nr - gr);
          open.push([cost + h, ni]);
        }
      }
    }
  }

  if (!cameFrom.has(goal) && start !== goal) return null;

  // Reconstruct cell path → world points.
  const cells: number[] = [goal];
  while (cells[cells.length - 1] !== start) {
    const prev = cameFrom.get(cells[cells.length - 1]!);
    if (prev === undefined) break;
    cells.push(prev);
  }
  cells.reverse();
  const points: Vec2[] = cells.map((i) => ({
    x: toWorld(i % GRID_N),
    z: toWorld(Math.floor(i / GRID_N)),
  }));
  // Aim for the exact click point when it's reachable from the last cell.
  if (walkable(points[points.length - 1]!.x, points[points.length - 1]!.z, tx, tz)) {
    points.push({ x: tx, z: tz });
  }

  // String-pulling: drop intermediate waypoints with a clear straight line.
  // Every kept segment must pass walkable() — including the exact start
  // position → first waypoint. If even the next raw point is unreachable,
  // fail cleanly instead of returning a path that clips an obstacle.
  const smoothed: Vec2[] = [];
  let anchor: Vec2 = { x: sx, z: sz };
  let i = 0;
  while (i < points.length) {
    let furthest = -1;
    for (let j = points.length - 1; j >= i; j--) {
      if (walkable(anchor.x, anchor.z, points[j]!.x, points[j]!.z)) {
        furthest = j;
        break;
      }
    }
    if (furthest === -1) return null;
    anchor = points[furthest]!;
    smoothed.push(anchor);
    i = furthest + 1;
  }
  return smoothed.length ? smoothed : null;
}

/** Test-only surface (not part of the public Match API). */
export const _pathfinding = { findPath, walkable, nearestFreeCell, reachableStartCell };

/** Test-only: named observation predicates (see P1, Information Warfare). */
export const _visibility = { hasLineOfSight, soldierSees, coverFor };

export class Match {
  private sides: Record<Faction, Side>;
  private tick = 0;
  private time = 0;
  private shots: ShotRecord[] = [];
  private contactMemory: Record<Faction, Map<string, ContactMemory>> = {
    ukraine: new Map(),
    russia: new Map(),
  };
  private timelineMoments: TimelineMoment[] = [];
  /** Per-viewer enemy deaths confirmed by observation this tick. */
  private witnessedDeaths: Record<Faction, string[]> = {
    ukraine: [],
    russia: [],
  };
  /** All deaths each viewer has ever confirmed — gates the event to once. */
  private confirmedDead: Record<Faction, Set<string>> = {
    ukraine: new Set(),
    russia: new Set(),
  };
  private finished = false;
  result: MatchResult | null = null;
  private carriables: Carriable[] = [];
  /** Carriables awaiting an observation-dwell unlock, keyed by zone id. */
  private pendingUnlocks: Map<string, Carriable[]> = new Map();
  private readonly zoneList: Zone[];
  /**
   * Continuous observation dwell per (zone, faction), counted in TICKS.
   * Integer ticks, not accumulated float seconds: 90 × (1/15) lands ~2e-15
   * below 6.0, which used to miss the threshold by one tick (step 6a fix).
   */
  private zoneDwell: Map<string, Record<Faction, number>> = new Map();
  /** Required dwell per observation zone, converted to ticks at construction. */
  private dwellTicksNeeded: Map<string, number> = new Map();

  /** Soldier ids that took damage in the most recent combat phase. */
  private damagedLastCombat = new Set<string>();
  /** Staged subdue completions awaiting post-combat commit. */
  private pendingSubdueCompletions: { targetId: string; winnerId: string }[] = [];
  private readonly rng: () => number;
  private readonly rules: RuleSet;
  private captures: Record<Faction, number> = { ukraine: 0, russia: 0 };
  private rescues: Record<Faction, number> = { ukraine: 0, russia: 0 };
  /** Stable RuleContext closing over this — built once, not per tick. */
  private readonly ctx: RuleContext;

  constructor(opts: MatchOptions = {}) {
    this.rng = opts.rng ?? Math.random;
    this.rules = opts.rules ?? new ClassicRules();
    const placements = opts.placements ?? defaultPlacements();
    validatePlacements(placements);
    this.sides = {
      ukraine: this.buildSide("ukraine", placements),
      russia: this.buildSide("russia", placements),
    };
    for (const d of opts.drones ?? []) {
      const drone = this.sides[d.faction].drone;
      drone.x = d.x;
      drone.z = d.z;
      drone.status = "deployed";
    }
    this.zoneList = this.buildZones(opts.zones ?? []);
    // revivesInZone is a declarative engine behaviour (like unlockedBy):
    // a dangling zone reference is a misconfigured mode — fail at startup.
    for (const f of FACTIONS) {
      for (const s of this.sides[f].soldiers) {
        if (
          s.revivesInZone !== null &&
          !this.zoneList.some((z) => z.id === s.revivesInZone)
        ) {
          throw new Error(
            `placements: "${s.id}" revivesInZone names unknown zone "${s.revivesInZone}"`,
          );
        }
      }
    }
    this.buildCarriables(opts.carriables ?? []);
    const match = this;
    this.ctx = {
      get time() { return match.time; },
      get tick() { return match.tick; },
      soldiers: (f: Faction) => this.sides[f].soldiers,
      activeCount: (f: Faction) => this.aliveCount(f),
      carriables: () => this.carriables,
      carriable: (id: string) => this.carriables.find((c) => c.id === id),
      zone: (id: string) => this.zoneList.find((z) => z.id === id),
      inZone: (zoneId: string, x: number, z: number) => {
        const zone = this.zoneList.find((zn) => zn.id === zoneId);
        return zone ? dist(x, z, zone.x, zone.z) <= zone.radius : false;
      },
      // Exposed in seconds (exact division of an integer tick count — no
      // accumulation error at whole-second thresholds).
      dwell: (zoneId: string, faction: Faction) =>
        (this.zoneDwell.get(zoneId)?.[faction] ?? 0) / MATCH.tickRate,
    };
  }

  /** Zones are static declarations; validation throws, never clamps. */
  private buildZones(zones: Zone[]): Zone[] {
    for (const z of zones) {
      if (z.kind === "observation" && z.dwellSeconds === undefined) {
        throw new Error(`zones: observation zone "${z.id}" has no dwellSeconds`);
      }
      if (z.kind === "extraction" && z.faction === undefined) {
        throw new Error(`zones: extraction zone "${z.id}" has no faction`);
      }
      if (z.kind === "observation") {
        this.zoneDwell.set(z.id, { ukraine: 0, russia: 0 });
        this.dwellTicksNeeded.set(
          z.id,
          Math.round(z.dwellSeconds! * MATCH.tickRate),
        );
      }
    }
    return zones;
  }

  /**
   * Resolve carriable placements against the built roster. Throws, never
   * clamps, and rejects loose positions inside the movement-inflated
   * footprint (SOLDIER_RADIUS + 0.3), not the geometric edge — a film
   * inside an inflated blocker is unreachable, which would make a scenario
   * silently unwinnable.
   */
  private buildCarriables(placements: CarriablePlacement[]): void {
    const ids = new Set<string>();
    for (const p of placements) {
      if (ids.has(p.id)) {
        throw new Error(`carriables: duplicate id "${p.id}"`);
      }
      if (p.id.startsWith("body-")) {
        // Reserved namespace: the engine generates `body-<soldierId>` when a
        // soldier goes down; a colliding authored id would silently suppress
        // that body.
        throw new Error(
          `carriables: "${p.id}" uses the reserved "body-" id namespace`,
        );
      }
      ids.add(p.id);
      if ((p.x !== undefined) !== (p.z !== undefined)) {
        throw new Error(
          `carriables: "${p.id}" has a partial position — x and z come together`,
        );
      }
      const hasPos = p.x !== undefined;
      if (p.unlockedBy !== undefined) {
        if (p.carrierId !== undefined || hasPos) {
          throw new Error(
            `carriables: "${p.id}" unlockedBy is mutually exclusive with carrierId and x/z`,
          );
        }
        const zone = this.zoneList.find((z) => z.id === p.unlockedBy);
        if (!zone) {
          throw new Error(
            `carriables: "${p.id}" unlockedBy names unknown zone "${p.unlockedBy}"`,
          );
        }
        if (zone.kind !== "observation") {
          throw new Error(
            `carriables: "${p.id}" unlockedBy zone "${zone.id}" is ${zone.kind}, not observation`,
          );
        }
        // Does not exist until the dwell completes — engine-owned lifecycle,
        // so rules stay pure. Spawns at the zone centre (or on the soldier
        // who completed the dwell) in stepZones.
        const pending = this.pendingUnlocks.get(zone.id) ?? [];
        pending.push({
          id: p.id,
          kind: p.kind,
          carrierId: null,
          x: zone.x,
          z: zone.z,
          pickupFactions: [...p.pickupFactions],
          pickupRadius: p.pickupRadius ?? PICKUP_RADIUS_DEFAULT,
          carrySpeed: p.carrySpeed ?? CARRY_SPEED_DEFAULT,
        });
        this.pendingUnlocks.set(zone.id, pending);
        continue;
      }
      if ((p.carrierId !== undefined) === hasPos) {
        throw new Error(
          `carriables: "${p.id}" must have exactly one of carrierId or a position`,
        );
      }
      let x: number;
      let z: number;
      if (p.carrierId !== undefined) {
        const carrier = this.sides.ukraine.soldiers
          .concat(this.sides.russia.soldiers)
          .find((s) => s.id === p.carrierId);
        if (!carrier) {
          throw new Error(
            `carriables: "${p.id}" carrierId "${p.carrierId}" is not in the roster`,
          );
        }
        if (carrier.carrying !== null) {
          throw new Error(
            `carriables: carrier "${p.carrierId}" already carries "${carrier.carrying}"`,
          );
        }
        carrier.carrying = p.id;
        x = carrier.x;
        z = carrier.z;
      } else {
        x = p.x!;
        z = p.z!;
        if (Math.abs(x) > MAP.size || Math.abs(z) > MAP.size) {
          throw new Error(
            `carriables: "${p.id}" at (${x}, ${z}) is outside map bounds (±${MAP.size})`,
          );
        }
        for (const o of MOVE_BLOCKERS) {
          if (pointInBox(x, z, o, SOLDIER_RADIUS + 0.3)) {
            throw new Error(
              `carriables: "${p.id}" at (${x}, ${z}) is inside obstacle "${o.id}" (movement-inflated footprint)`,
            );
          }
        }
      }
      this.carriables.push({
        id: p.id,
        kind: p.kind,
        carrierId: p.carrierId ?? null,
        x,
        z,
        pickupFactions: [...p.pickupFactions],
        pickupRadius: p.pickupRadius ?? PICKUP_RADIUS_DEFAULT,
        carrySpeed: p.carrySpeed ?? CARRY_SPEED_DEFAULT,
      });
    }
  }

  /** Static zones for match_start — never repeated per tick. */
  get zones(): Zone[] {
    return this.zoneList;
  }

  private rand(min: number, max: number): number {
    return min + this.rng() * (max - min);
  }

  // ----- Test-only hooks ------------------------------------------------------
  //
  // Placements cover construction; these cover the two things placements
  // cannot: reading state for assertions, and mid-match state changes the
  // engine cannot yet produce on demand. Underscore-prefixed and deliberately
  // outside the match API — production code (including the bot) must go
  // through orders and `snapshot()`.

  /**
   * Read-only roster projection, for assertions that sweep every soldier
   * (e.g. per-tick condition invariants over a whole match) — not
   * expressible as a placement. Never a mutation surface.
   */
  _soldiers(faction: Faction): readonly Readonly<Soldier>[] {
    return this.sides[faction].soldiers;
  }

  /**
   * Force a condition mid-match (e.g. "subdued", which the engine cannot
   * produce until 6b). Construction-time conditions belong in placements,
   * not here. Forcing "downed" routes through the same transition as
   * lethal damage — body carriable included — so tests stage bodies the
   * way the engine actually makes them.
   */
  _setCondition(id: string, condition: Condition): void {
    const s = this.findSoldier(id);
    if (condition === "downed") {
      this.downSoldier(s);
      return;
    }
    s.condition = condition;
    if (condition === "dead") s.health = 0;
  }

  /**
   * Teleport a soldier mid-match — for staging loss-of-contact after an
   * observation window. Moving via orders would couple tests to move-speed
   * tuning, the same reason drone placements exist.
   */
  _teleport(id: string, x: number, z: number): void {
    const s = this.findSoldier(id);
    s.x = x;
    s.z = z;
  }

  private findSoldier(id: string): Soldier {
    for (const f of ["ukraine", "russia"] as Faction[]) {
      const s = this.sides[f].soldiers.find((x) => x.id === id);
      if (s) return s;
    }
    throw new Error(`no soldier with id "${id}"`);
  }

  /**
   * Server-recorded decisive moments, identical for both players. Same-tick
   * deaths share one moment, so a mutual kill reads as the tie it was.
   */
  get timeline(): TimelineMoment[] {
    return this.timelineMoments;
  }

  private buildSide(faction: Faction, placements: Placement[]): Side {
    // Id scheme lives in rosterIds() — byte-identical to the old inline
    // scheme for default rosters, where each rank appears once.
    const mine = placements.filter((p) => p.faction === faction);
    const ids = rosterIds(mine);
    const soldiers: Soldier[] = mine
      .map((p, i) => {
        const def = SOLDIER_DEFS[p.rank];
        return {
          id: ids[i]!,
          faction,
          rank: p.rank,
          x: p.x,
          z: p.z,
          heading: p.heading ?? (faction === "ukraine" ? Math.PI / 2 : -Math.PI / 2),
          health: p.health ?? def.maxHealth,
          maxHealth: def.maxHealth,
          condition: p.condition ?? "active",
          moving: false,
          fireControl: "engage",
          ammunition: TACTICS.startingAmmo,
          suppression: 0,
          cohesion: "steady",
          target: null,
          path: [],
          cooldown: 0,
          carrying: null,
          downOnLethal: p.downOnLethal ?? false,
          bodyPickupFactions: p.bodyPickupFactions ?? [faction],
          subduing: null,
          revivesInZone: p.revivesInZone ?? null,
          suppressionTarget: null,
          recentAttackerTick: -Infinity,
          isLeader: p.isLeader === true,
        };
      });
    return {
      faction,
      soldiers,
      drone: {
        faction,
        x: MAP.spawns[faction][2]!.x,
        z: MAP.spawns[faction][2]!.z,
        health: DRONE.maxHealth,
        battery: DRONE.battery,
        status: "ready",
        target: null,
      },
    };
  }

  // ----- Orders -------------------------------------------------------------

  moveOrder(faction: Faction, soldierIds: string[], target: Vec2): void {
    const clamped = {
      x: Math.max(-MAP.size, Math.min(MAP.size, target.x)),
      z: Math.max(-MAP.size, Math.min(MAP.size, target.z)),
    };
    const selected = this.sides[faction].soldiers.filter(
      (s) => canAct(s) && soldierIds.includes(s.id),
    );
    // Spread group targets slightly so soldiers don't stack.
    selected.forEach((s, i) => {
      s.subduing = null; // a move order interrupts a subdue wind-up
      const angle = (i / Math.max(1, selected.length)) * Math.PI * 2;
      const spread = selected.length > 1 ? 1.4 : 0;
      const goal = {
        x: Math.max(-MAP.size, Math.min(MAP.size, clamped.x + Math.cos(angle) * spread)),
        z: Math.max(-MAP.size, Math.min(MAP.size, clamped.z + Math.sin(angle) * spread)),
      };
      const path = findPath(s.x, s.z, goal.x, goal.z);
      if (path && path.length) {
        s.target = path[path.length - 1]!;
        s.path = path;
      } else {
        s.target = null;
        s.path = [];
      }
    });
  }

  stopOrder(faction: Faction, soldierIds: string[]): void {
    for (const s of this.sides[faction].soldiers) {
      if (soldierIds.includes(s.id)) {
        s.target = null;
        s.path = [];
        s.subduing = null; // a stop order interrupts a subdue wind-up
      }
    }
  }

  fireControlOrder(
    faction: Faction,
    soldierIds: string[],
    fireControl: FireControl,
  ): void {
    for (const s of this.sides[faction].soldiers) {
      if (!soldierIds.includes(s.id) || !canAct(s)) continue;
      s.fireControl = fireControl;
      if (fireControl !== "suppress") s.suppressionTarget = null;
    }
  }

  suppressOrder(faction: Faction, soldierIds: string[], target: Vec2): void {
    const point = clampToMap(target);
    for (const s of this.sides[faction].soldiers) {
      if (!soldierIds.includes(s.id) || !canAct(s) || s.ammunition <= 0) continue;
      if (!this.canEngage(s, faction, point.x, point.z)) continue;
      s.fireControl = "suppress";
      s.suppressionTarget = point;
    }
  }

  /**
   * Begin a subdue wind-up (step 6b). Preconditions are checked at issue
   * time and the order is rejected SILENTLY on failure, like every other
   * invalid order — never queued. During the wind-up the subduer cannot
   * move or fire, and remains a valid target: deliberately the most
   * exposed action in the game.
   */
  subdueOrder(faction: Faction, soldierId: string, targetId: string): void {
    const s = this.sides[faction].soldiers.find((x) => x.id === soldierId);
    if (
      !s ||
      s.condition !== "active" ||
      s.cohesion === "pinned" ||
      s.carrying !== null
    )
      return;
    const t = this.sides[otherFaction(faction)].soldiers.find(
      (x) => x.id === targetId,
    );
    if (!t || t.condition !== "active") return;
    // Capture only: ordinary soldiers and Classic mode never set isLeader.
    if (!t.isLeader) return;
    if (dist(s.x, s.z, t.x, t.z) > SUBDUE_RANGE) return;
    if (!hasLineOfSight(s.x, s.z, t.x, t.z)) return;
    s.target = null;
    s.path = [];
    s.moving = false;
    s.subduing = { targetId, ticksRemaining: SUBDUE_TICKS };
  }

  deployDrone(faction: Faction, target: Vec2): void {
    const d = this.sides[faction].drone;
    if (d.status !== "ready") return;
    d.status = "deployed";
    d.target = clampToMap(target);
  }

  moveDrone(faction: Faction, target: Vec2): void {
    const d = this.sides[faction].drone;
    if (d.status !== "deployed") return;
    d.target = clampToMap(target);
  }

  recallDrone(faction: Faction): void {
    // MVV: recall just parks the drone where it is (stops movement).
    const d = this.sides[faction].drone;
    if (d.status === "deployed") d.target = null;
  }

  afterAction(result: MatchResult): NonNullable<MatchResult["afterAction"]> {
    const byFaction = {} as NonNullable<MatchResult["afterAction"]>["byFaction"];
    for (const f of FACTIONS) {
      const roster = this.sides[f].soldiers;
      const active = roster.filter(canAct).length;
      const casualties = roster.length - active;
      const ammunitionSpent = roster.reduce(
        (sum, s) => sum + (TACTICS.startingAmmo - s.ammunition),
        0,
      );
      // Factual: only an objective/capture win counts as completing the objective.
      // Elimination, timeout, and forfeit are wins without objective completion.
      const objectiveCompleted =
        result.winner === f &&
        (result.reason === "capture" || result.reason === "objective" || result.reason === "scenario");
      const forcePreserved = roster.length ? active / roster.length : 0;
      const assessment = !objectiveCompleted
        ? "mission_failed"
        : casualties === 0 && ammunitionSpent <= roster.length * 12
          ? "exemplary"
          : forcePreserved >= 0.6
            ? "disciplined"
            : "costly";
      byFaction[f] = {
        objectiveCompleted,
        forcePreserved,
        casualties,
        captures: this.captures[f],
        rescues: this.rescues[f],
        ammunitionSpent,
        elapsedSeconds: Math.round(this.time),
        assessment,
      };
    }
    return { byFaction };
  }

  forfeit(loser: Faction): void {
    if (this.finished) return;
    this.finished = true;
    this.result = {
      winner: loser === "ukraine" ? "russia" : "ukraine",
      reason: "forfeit",
    };
  }

  // ----- Simulation ----------------------------------------------------------

  get isFinished(): boolean {
    return this.finished;
  }

  step(dt: number): void {
    if (this.finished) return;
    this.tick += 1;
    this.time += dt;
    this.shots = [];
    this.witnessedDeaths = { ukraine: [], russia: [] };

    this.stepCohesion(dt);
    for (const f of FACTIONS) this.stepMovement(this.sides[f], dt);
    for (const f of FACTIONS) this.stepDrone(this.sides[f], dt);
    // Wind-ups tick before combat; completions COMMIT after combat so the
    // same-tick shot that would pin/damage the subduer still interrupts.
    this.pendingSubdueCompletions = this.stepSubdueWindups();
    this.stepCombat(dt);
    this.commitSubdues(this.pendingSubdueCompletions);
    this.pendingSubdueCompletions = [];
    // After combat so a carrier killed this tick drops in the same tick;
    // zones after carriables so delivery state is current when rules run.
    this.stepCarriables();
    this.stepZones();
    this.stepContacts();
    this.rules.step?.(this.ctx, dt);
    if (!this.finished) {
      const r = this.rules.evaluate(this.ctx);
      if (r) {
        this.finished = true;
        this.result = r;
      }
    }
  }

  private stepMovement(side: Side, dt: number): void {
    for (const s of side.soldiers) {
      if (s.subduing !== null) {
        // Immobile during the wind-up. Orders that could have left a path
        // here clear `subduing` at issue time, so this is belt-and-braces.
        s.moving = false;
        continue;
      }
      if (!canAct(s) || s.cohesion === "pinned" || !s.path.length) {
        s.moving = false;
        continue;
      }
      // Advance past reached waypoints.
      let wp = s.path[0]!;
      while (dist(s.x, s.z, wp.x, wp.z) < ARRIVE_EPS) {
        s.path.shift();
        if (!s.path.length) break;
        wp = s.path[0]!;
      }
      if (!s.path.length) {
        s.target = null;
        s.moving = false;
        continue;
      }
      const d = dist(s.x, s.z, wp.x, wp.z);
      // Carry speed is read from the carriable, not copied onto the
      // soldier — one source of truth.
      const carried = s.carrying
        ? this.carriables.find((c) => c.id === s.carrying)
        : undefined;
      const speed = SOLDIER_DEFS[s.rank].speed * (carried?.carrySpeed ?? 1);
      const step = Math.min(speed * dt, d);
      const nx = s.x + ((wp.x - s.x) / d) * step;
      const nz = s.z + ((wp.z - s.z) / d) * step;
      s.heading = Math.atan2(wp.x - s.x, wp.z - s.z);
      if (!blockedAt(nx, nz)) {
        s.x = nx;
        s.z = nz;
        s.moving = true;
      } else if (!blockedAt(nx, s.z)) {
        s.x = nx; // slide along x
        s.moving = true;
      } else if (!blockedAt(s.x, nz)) {
        s.z = nz; // slide along z
        s.moving = true;
      } else if (s.target) {
        // Waypoint unexpectedly blocked: replan from here.
        const path = findPath(s.x, s.z, s.target.x, s.target.z);
        if (path && path.length) {
          s.path = path;
        } else {
          s.target = null;
          s.path = [];
          s.moving = false;
        }
      }
    }
  }

  private stepCohesion(dt: number): void {
    for (const f of FACTIONS) {
      for (const s of this.sides[f].soldiers) {
        if (!canAct(s)) continue;
        s.suppression = Math.max(
          0,
          s.suppression - TACTICS.suppressionRecoveryPerSecond * dt,
        );
        s.cohesion = cohesionBand(s.suppression);
      }
    }
  }

  private stepDrone(side: Side, dt: number): void {
    const d = side.drone;
    if (d.status !== "deployed") return;
    d.battery -= dt;
    if (d.battery <= 0) {
      d.battery = 0;
      d.status = "depleted";
      return;
    }
    if (d.target) {
      const dd = dist(d.x, d.z, d.target.x, d.target.z);
      if (dd < ARRIVE_EPS) {
        d.target = null;
      } else {
        const step = Math.min(DRONE.speed * dt, dd);
        d.x += ((d.target.x - d.x) / dd) * step;
        d.z += ((d.target.z - d.z) / dd) * step;
      }
    }
  }

  /**
   * Is a ground position visible to `faction`?
   * Rule: any living soldier personally sees it (`soldierSees`), or the
   * faction's deployed drone has it in range (aerial — ignores ground
   * sight blockers).
   */
  private visibleTo(faction: Faction, x: number, z: number): boolean {
    const side = this.sides[faction];
    for (const s of side.soldiers) {
      if (soldierSees(s, x, z)) return true;
    }
    const d = side.drone;
    return d.status === "deployed" && dist(d.x, d.z, x, z) <= DRONE.visionRange;
  }

  /**
   * May soldier `s` (of `faction`) fire on ground target (tx, tz)?
   * Rule: three conditions compose — the target is within the soldier's fire
   * range, the soldier personally has ground LOS to it, and the TEAM observes
   * it. A spotter lets you shoot; a wall still stops you.
   */
  canEngage(s: Soldier, faction: Faction, tx: number, tz: number): boolean {
    return (
      dist(s.x, s.z, tx, tz) <= SOLDIER_DEFS[s.rank].fireRange &&
      hasLineOfSight(s.x, s.z, tx, tz) &&
      this.visibleTo(faction, tx, tz)
    );
  }

  /**
   * Can `faction` observe an airborne drone at (x, z)?
   *
   * Drones fly at DRONE.altitude, clear of every obstacle on the map, so
   * ground sight blockers do not occlude them — range alone decides. This is
   * the ONLY drone-observation predicate: both `snapshot()` and combat
   * targeting call it, so what a player can see and what their soldiers may
   * shoot at can never disagree.
   */
  private canSeeDrone(faction: Faction, x: number, z: number): boolean {
    const side = this.sides[faction];
    for (const s of side.soldiers) {
      if (!canAct(s)) continue;
      if (dist(s.x, s.z, x, z) <= SOLDIER_DEFS[s.rank].visionRange) return true;
    }
    const d = side.drone;
    return d.status === "deployed" && dist(d.x, d.z, x, z) <= DRONE.visionRange;
  }

  /**
   * Update each faction's last-known-contact memory. Runs AFTER combat so
   * deaths resolved this tick count as "confirmed dead while observed".
   *
   * Rules per enemy unit:
   * - Observed and alive → refresh the remembered position.
   * - Confirmed dead while its position is observed → forget it.
   * - Unobserved → entry is untouched (frozen), whether the unit lives,
   *   moved, or died out of sight. You do not know he is dead.
   * - Expiry is radius-driven: once `speed * age` exceeds
   *   CONTACT_EXPIRY_RADIUS the marker means nothing — drop it. Faster units
   *   decay sooner, so the scout is the hardest unit to track.
   */
  private stepContacts(): void {
    for (const viewer of FACTIONS) {
      const enemyFaction: Faction = viewer === "ukraine" ? "russia" : "ukraine";
      const mem = this.contactMemory[viewer];
      const enemy = this.sides[enemyFaction];

      for (const e of enemy.soldiers) {
        const positionObserved = this.visibleTo(viewer, e.x, e.z);
        // isPresent, not canAct (step 6a): a downed enemy in plain sight
        // must refresh his contact — otherwise he would stay frozen at his
        // last ACTIVE position while you look directly at the body.
        if (isPresent(e) && positionObserved) {
          mem.set(e.id, {
            kind: "soldier",
            faction: enemyFaction,
            rank: e.rank,
            x: e.x,
            z: e.z,
            seenAt: this.time,
            speed: SOLDIER_DEFS[e.rank].speed,
          });
        } else if (
          // Explicit condition check, not !canAct: witnessed death must fire
          // on "dead" specifically — once downed/subdued become reachable,
          // !canAct would report a capture as a kill.
          e.condition === "dead" &&
          positionObserved &&
          !this.confirmedDead[viewer].has(e.id)
        ) {
          // First observed confirmation of this death: forget the contact
          // and tell the viewer explicitly, exactly once — later ticks over
          // the same corpse are silent. (Not gated on contact memory: a unit
          // first seen on the very tick it dies still confirms.)
          mem.delete(e.id);
          this.confirmedDead[viewer].add(e.id);
          this.witnessedDeaths[viewer].push(e.id);
        }
      }

      const ed = enemy.drone;
      const droneId = `${enemyFaction}-drone`;
      if (ed.status === "deployed" && this.canSeeDrone(viewer, ed.x, ed.z)) {
        mem.set(droneId, {
          kind: "drone",
          faction: enemyFaction,
          x: ed.x,
          z: ed.z,
          seenAt: this.time,
          speed: DRONE.speed,
        });
      } else if (
        ed.status !== "deployed" &&
        this.canSeeDrone(viewer, ed.x, ed.z)
      ) {
        // Watched it go down (or run dry) → no stale marker.
        mem.delete(droneId);
      }

      for (const [id, c] of mem) {
        if (c.speed * (this.time - c.seenAt) > CONTACT_EXPIRY_RADIUS) {
          mem.delete(id);
        }
      }
    }
  }

  /**
   * Two-phase combat so resolution is side-order independent.
   * Phase A: from the state at the start of the combat tick, every living
   * soldier picks a target and rolls its shot — damage is recorded, not
   * applied. Phase B: all damage lands simultaneously, then deaths are
   * processed. A soldier damaged (even fatally) this tick still fires.
   */
  private stepCombat(dt: number): void {
    interface SoldierHit {
      target: Soldier;
      dmg: number;
    }
    interface DroneHit {
      drone: Drone;
    }
    const soldierHits: SoldierHit[] = [];
    const droneHits: DroneHit[] = [];
    const suppressionHits: { target: Soldier; pressure: number }[] = [];
    // Attack memory must not flip mid-Phase-A or the second faction in
    // FACTIONS gets same-tick Return Fire while the first does not.
    const attackedThisTick = new Set<string>();

    // ----- Phase A: intent (no state mutation besides cooldown/heading/ammo) -----
    for (const f of FACTIONS) {
      const enemyFaction: Faction = f === "ukraine" ? "russia" : "ukraine";
      const side = this.sides[f];
      const enemy = this.sides[enemyFaction];
      for (const s of side.soldiers) {
        if (!canAct(s)) continue;
        // A subduer cannot fire during the wind-up — excluded from the
        // shooter loop entirely (cooldown frozen too). He remains a valid
        // target throughout.
        if (s.subduing !== null) continue;
        s.cooldown = Math.max(0, s.cooldown - dt);
        if (s.cooldown > 0 || s.ammunition <= 0 || s.fireControl === "hold") continue;
        if (
          s.fireControl === "return_fire" &&
          this.tick - s.recentAttackerTick > TACTICS.returnFireMemoryTicks
        )
          continue;
        const def = SOLDIER_DEFS[s.rank];

        if (s.fireControl === "suppress" && s.suppressionTarget) {
          const point = s.suppressionTarget;
          if (!this.canEngage(s, f, point.x, point.z)) {
            s.suppressionTarget = null;
            continue;
          }
          s.cooldown = def.fireCooldown;
          s.ammunition -= 1;
          s.heading = Math.atan2(point.x - s.x, point.z - s.z);
          for (const e of enemy.soldiers) {
            if (!isTargetable(e) || dist(e.x, e.z, point.x, point.z) > 4) continue;
            const cover = coverFor(s.x, s.z, e.x, e.z);
            const mitigation = cover ? COVER_REDUCTION[cover] : 0;
            suppressionHits.push({
              target: e,
              pressure: TACTICS.suppressionPerShot * (1 - mitigation),
            });
            attackedThisTick.add(e.id);
          }
          this.shots.push({
            shooter: f,
            fx: s.x,
            fz: s.z,
            tx: point.x,
            tz: point.z,
            hit: false,
            targetKind: "soldier",
          });
          continue;
        }

        // Nearest engageable enemy soldier (targetable at tick start).
        let target: Soldier | null = null;
        let targetDist = Infinity;
        for (const e of enemy.soldiers) {
          if (!isTargetable(e)) continue;
          const de = dist(s.x, s.z, e.x, e.z);
          if (de >= targetDist) continue;
          if (!this.canEngage(s, f, e.x, e.z)) continue;
          target = e;
          targetDist = de;
        }

        if (target) {
          s.cooldown = def.fireCooldown;
          s.ammunition -= 1;
          s.heading = Math.atan2(target.x - s.x, target.z - s.z);
          attackedThisTick.add(target.id);
          const targetCover = coverFor(s.x, s.z, target.x, target.z);
          const suppressionMitigation = targetCover ? COVER_REDUCTION[targetCover] : 0;
          suppressionHits.push({
            target,
            pressure: TACTICS.suppressionPerShot * (1 - suppressionMitigation),
          });
          const hit = this.rng() < HIT_CHANCE;
          if (hit) {
            let dmg = this.rand(def.damage[0], def.damage[1]);
            const cover = coverFor(s.x, s.z, target.x, target.z);
            if (cover) dmg *= 1 - COVER_REDUCTION[cover];
            soldierHits.push({ target, dmg });
          }
          this.shots.push({
            shooter: f,
            targetFaction: target.faction,
            fx: s.x,
            fz: s.z,
            tx: target.x,
            tz: target.z,
            hit,
            targetKind: "soldier",
          });
          continue;
        }

        // No soldier target: engage the enemy drone only when it is both in
        // range and actually observed by this side — range alone must not
        // grant shots at a drone the player cannot see.
        const ed = enemy.drone;
        if (
          ed.status === "deployed" &&
          dist(s.x, s.z, ed.x, ed.z) <= DRONE.engageRange &&
          this.canSeeDrone(f, ed.x, ed.z)
        ) {
          s.cooldown = def.fireCooldown;
          s.ammunition -= 1;
          const hit = this.rng() < DRONE.hitChance;
          if (hit) droneHits.push({ drone: ed });
          this.shots.push({
            shooter: f,
            fx: s.x,
            fz: s.z,
            tx: ed.x,
            tz: ed.z,
            hit,
            targetKind: "drone",
          });
        }
      }
    }

    // Apply attack memory only after BOTH factions decided Return Fire from
    // the pre-tick recentAttackerTick values — simultaneous combat.
    for (const id of attackedThisTick) {
      const s = this.findSoldier(id);
      if (s) s.recentAttackerTick = this.tick;
    }

    // ----- Phase B: resolve all damage simultaneously -----
    const moment: TimelineEvent[] = [];
    this.damagedLastCombat.clear();
    for (const { target, pressure } of suppressionHits) {
      if (!canAct(target)) continue;
      target.suppression = Math.min(100, target.suppression + pressure);
      target.cohesion = cohesionBand(target.suppression);
      if (target.cohesion === "pinned") target.moving = false;
    }
    for (const { target, dmg } of soldierHits) {
      target.health -= dmg;
      // Any damage interrupts a subdue: read by stepSubdue, which runs
      // BEFORE combat, so the interrupt lands on the next subdue step —
      // completion always precedes the tick's own fire.
      this.damagedLastCombat.add(target.id);
    }
    for (const f of FACTIONS) {
      for (const s of this.sides[f].soldiers) {
        if (canAct(s) && s.health <= 0) {
          s.health = 0;
          s.moving = false;
          s.target = null;
          s.path = [];
          if (s.downOnLethal) {
            // Downed, not dead: still isPresent, no longer isTargetable —
            // and from this tick a body carriable other soldiers can carry.
            // No timeline moment: this is not an elimination, and the
            // MEDEVAC timeout that could turn it into one is deliberately
            // not in this substrate.
            this.downSoldier(s);
          } else {
            s.condition = "dead";
            moment.push({ kind: "elimination", faction: f, rank: s.rank });
          }
        }
      }
    }
    for (const { drone } of droneHits) {
      if (drone.status !== "deployed") continue; // already destroyed this tick
      drone.health -= DRONE.hitDamage;
      if (drone.health <= 0) {
        drone.health = 0;
        drone.status = "destroyed";
        moment.push({ kind: "drone_down", faction: drone.faction });
      }
    }
    if (moment.length) {
      this.timelineMoments.push({ tick: this.tick, time: this.time, events: moment });
    }
  }


  /**
   * Mirror → drop → pickup. Runs after stepCombat so a carrier killed this
   * tick drops in the same tick, at the position it died.
   *
   * Pickup only considers carriables that were ALREADY loose when the step
   * began: an item dropped this tick lies on the ground for at least one
   * tick before anyone (including an adjacent teammate) can take it, so a
   * drop is observable on the wire before the handoff.
   */
  private stepCarriables(): void {
    const looseAtStart = new Set(
      this.carriables.filter((c) => c.carrierId === null).map((c) => c.id),
    );

    for (const c of this.carriables) {
      if (c.carrierId === null) continue;
      const carrier = this.findSoldier(c.carrierId);
      // Mirror: a carried carriable is wherever its carrier is.
      c.x = carrier.x;
      c.z = carrier.z;
      this.writeThroughBody(c);
      // Drop: a carrier no longer able to act — dead now, downed or subdued
      // later — leaves it exactly where it fell.
      if (!canAct(carrier)) {
        c.carrierId = null;
        carrier.carrying = null;
      }
    }

    for (const c of this.carriables) {
      if (c.carrierId !== null || !looseAtStart.has(c.id)) continue;
      // Eligible: can act, faction allowed, empty-handed, within radius.
      // Nearest wins; ties break on ascending soldier id — this runs inside
      // seeded scenarios and must replay identically.
      let best: Soldier | null = null;
      let bestDist = Infinity;
      for (const f of c.pickupFactions) {
        for (const s of this.sides[f].soldiers) {
          if (!canAct(s) || s.carrying !== null) continue;
          const d = dist(s.x, s.z, c.x, c.z);
          if (d > c.pickupRadius) continue;
          if (d < bestDist || (d === bestDist && best && s.id < best.id)) {
            best = s;
            bestDist = d;
          }
        }
      }
      if (best) {
        c.carrierId = best.id;
        best.carrying = c.id;
        // Mirror immediately: snapshots and rules this tick must see the
        // carriable at its carrier, never at the stale ground position.
        c.x = best.x;
        c.z = best.z;
        this.writeThroughBody(c);
      }
    }
  }

  /**
   * Advance every subdue wind-up. Runs BEFORE stepCombat so a completion
   * this tick removes the captive from the combat loop the same tick.
   * Interrupts: subduer damaged (last combat phase) or no longer active,
   * target no longer active (downed/killed by other fire is a legitimate
   * outcome — a body at 0.55 instead of a captive at 0.8), or out of
   * range. Move/stop orders clear `subduing` at issue time.
   */
  /**
   * Advance wind-ups and stage potential completions. Does NOT capture yet —
   * combat on this tick must still be able to interrupt the subduer.
   */
  private stepSubdueWindups(): { targetId: string; winnerId: string }[] {
    const completions = new Map<string, Soldier>();
    for (const f of FACTIONS) {
      for (const s of this.sides[f].soldiers) {
        if (s.subduing === null) continue;
        const t = this.findSoldier(s.subduing.targetId);
        if (
          s.condition !== "active" ||
          s.cohesion === "pinned" ||
          this.damagedLastCombat.has(s.id) ||
          !t ||
          t.condition !== "active" ||
          !t.isLeader ||
          dist(s.x, s.z, t.x, t.z) > SUBDUE_RANGE
        ) {
          s.subduing = null;
          continue;
        }
        s.subduing.ticksRemaining -= 1;
        if (s.subduing.ticksRemaining <= 0) {
          const prev = completions.get(t.id);
          if (!prev || s.id < prev.id) completions.set(t.id, s);
        }
      }
    }
    return [...completions.entries()].map(([targetId, winner]) => ({
      targetId,
      winnerId: winner.id,
    }));
  }

  /** Commit staged subdues only if the subduer is still eligible post-combat. */
  private commitSubdues(
    staged: { targetId: string; winnerId: string }[],
  ): void {
    for (const { targetId, winnerId } of staged) {
      const winner = this.findSoldier(winnerId);
      const t = this.findSoldier(targetId);
      if (
        !winner ||
        !t ||
        winner.condition !== "active" ||
        winner.cohesion === "pinned" ||
        this.damagedLastCombat.has(winner.id) ||
        t.condition !== "active" ||
        !t.isLeader ||
        dist(winner.x, winner.z, t.x, t.z) > SUBDUE_RANGE
      ) {
        if (winner) winner.subduing = null;
        continue;
      }
      this.downSoldier(t, "subdued");
      this.captures[winner.faction] += 1;
      for (const f of FACTIONS) {
        for (const s of this.sides[f].soldiers) {
          if (s.subduing?.targetId === targetId) s.subduing = null;
        }
      }
    }
  }

  /**
   * The single hors-de-combat transition: condition, health floor,
   * movement halt, and the body carriable, created in the same tick at the
   * soldier's position. Idempotent — a soldier has at most one body.
   * A subdued captive is escorted, not carried: SUBDUE_CARRY_SPEED.
   */
  private downSoldier(s: Soldier, condition: "downed" | "subdued" = "downed"): void {
    s.condition = condition;
    s.health = 0;
    s.moving = false;
    s.target = null;
    s.path = [];
    s.subduing = null;
    if (!this.carriables.some((c) => c.soldierId === s.id)) {
      this.carriables.push({
        id: `body-${s.id}`,
        kind: "body",
        soldierId: s.id,
        carrierId: null,
        x: s.x,
        z: s.z,
        pickupFactions: [...s.bodyPickupFactions],
        pickupRadius: PICKUP_RADIUS_DEFAULT,
        carrySpeed: condition === "subdued" ? SUBDUE_CARRY_SPEED : BODY_CARRY_SPEED,
      });
    }
  }

  /**
   * Write-through keeps ONE position of record: when a body carriable
   * moves, the downed soldier moves with it, so fog, contacts, cover, and
   * rendering need no special case for a carried body.
   */
  private writeThroughBody(c: Carriable): void {
    if (c.soldierId === undefined) return;
    const s = this.findSoldier(c.soldierId);
    s.x = c.x;
    s.z = c.z;
  }

  /**
   * Observation dwell accrues per (zone, faction) while any acting soldier
   * of that faction personally sees the zone center; it resets the moment
   * LOS breaks (see DWELL_VALUE_ON_LOS_BREAK). Extraction and protected
   * zones need no per-tick state — rules test containment directly.
   */
  private stepZones(): void {
    for (const z of this.zoneList) {
      if (z.kind !== "observation") continue;
      const dwell = this.zoneDwell.get(z.id)!;
      const need = this.dwellTicksNeeded.get(z.id) ?? Infinity;
      for (const f of FACTIONS) {
        const observed = this.sides[f].soldiers.some((s) =>
          soldierSees(s, z.x, z.z),
        );
        const before = dwell[f];
        dwell[f] = observed ? dwell[f] + 1 : DWELL_VALUE_ON_LOS_BREAK;
        // Fire on the threshold CROSSING, not on every tick past it —
        // otherwise anything re-added to pendingUnlocks later (step 6b+)
        // would be re-unlocked implicitly by a dwell that completed ages ago.
        if (before < need && dwell[f] >= need) {
          this.completeUnlocks(z, f);
        }
      }
    }
    this.stepRevives();
  }

  /**
   * Declarative rescue (step 6b), the same pattern as unlockedBy: a body
   * carriable inside its soldier's `revivesInZone` reverts the soldier to
   * `active` at REVIVE_HEALTH_FRACTION of maxHealth and is destroyed.
   * Engine-owned so rules stay pure. A rescued soldier can be captured
   * again — intended; a leader changing hands twice is the mode's best
   * match.
   */
  private stepRevives(): void {
    for (let i = this.carriables.length - 1; i >= 0; i--) {
      const c = this.carriables[i]!;
      if (c.soldierId === undefined) continue;
      const s = this.findSoldier(c.soldierId);
      if (s.revivesInZone === null) continue;
      if (s.condition !== "downed" && s.condition !== "subdued") continue;
      const zone = this.zoneList.find((z) => z.id === s.revivesInZone);
      if (!zone || dist(c.x, c.z, zone.x, zone.z) > zone.radius) continue;
      // Drop from any carrier, destroy the body, restore the soldier.
      if (c.carrierId !== null) {
        const carrier = this.findSoldier(c.carrierId);
        if (carrier.carrying === c.id) carrier.carrying = null;
      }
      this.carriables.splice(i, 1);
      s.condition = "active";
      s.health = s.maxHealth * REVIVE_HEALTH_FRACTION;
      this.rescues[s.faction] += 1;
      // Clear any wind-up targeting him: a revive mid-subdue invalidates it.
      for (const f of FACTIONS) {
        for (const x of this.sides[f].soldiers) {
          if (x.subduing?.targetId === s.id) x.subduing = null;
        }
      }
    }
  }

  /**
   * Dwell completed: spawn every carriable unlocked by this zone. Recipient
   * is the LOWEST-ID canAct, empty-handed soldier of the dwelling faction
   * currently observing the zone centre — lowest id, not nearest, because
   * nearest invites float ties and this runs in seeded scenarios. If the
   * eligible set is somehow empty on the completion tick, spawn loose at
   * the zone centre rather than dropping the carriable silently.
   */
  private completeUnlocks(zone: Zone, faction: Faction): void {
    const pending = this.pendingUnlocks.get(zone.id);
    if (!pending?.length) return;
    // A faction only completes unlocks it is allowed to carry: an enemy
    // camping the observation point must not spawn YOUR film into hands
    // that cannot even drop it. Ineligible pendings stay locked until an
    // eligible faction completes its own dwell.
    const unlocked = pending.filter((c) => c.pickupFactions.includes(faction));
    if (!unlocked.length) return;
    const rest = pending.filter((c) => !c.pickupFactions.includes(faction));
    if (rest.length) this.pendingUnlocks.set(zone.id, rest);
    else this.pendingUnlocks.delete(zone.id);
    let recipient: Soldier | null = null;
    for (const s of this.sides[faction].soldiers) {
      if (!canAct(s) || s.carrying !== null) continue;
      if (!soldierSees(s, zone.x, zone.z)) continue;
      if (!recipient || s.id < recipient.id) recipient = s;
    }
    for (const c of unlocked) {
      if (recipient && recipient.carrying === null) {
        c.carrierId = recipient.id;
        c.x = recipient.x;
        c.z = recipient.z;
        recipient.carrying = c.id;
      }
      this.carriables.push(c);
    }
  }

  private aliveCount(f: Faction): number {
    return this.sides[f].soldiers.filter((s) => canAct(s)).length;
  }

  // ----- Snapshots ------------------------------------------------------------

  /** Fog-of-war-filtered snapshot for one player. */
  snapshot(viewer: Faction): TickState {
    const enemyFaction: Faction = viewer === "ukraine" ? "russia" : "ukraine";
    const mine = this.sides[viewer];
    const theirs = this.sides[enemyFaction];

    const soldiers: SoldierState[] = [];
    for (const s of mine.soldiers) {
      // Own active soldiers: always exact. Own downed/subdued body in enemy
      // custody: live coordinates only when the position is observed — otherwise
      // the captive tracks the hidden carrier through fog (CRITICAL leak).
      if (s.condition === "active" || s.condition === "dead") {
        soldiers.push(toSoldierState(s));
        continue;
      }
      const body = this.carriables.find((c) => c.soldierId === s.id);
      const enemyCarrier =
        body?.carrierId != null &&
        theirs.soldiers.some((e) => e.id === body.carrierId);
      if (enemyCarrier && !this.visibleTo(viewer, s.x, s.z)) {
        // Omit live position. Contact memory for captives can follow; no leak.
        continue;
      }
      soldiers.push(toSoldierState(s));
    }
    for (const e of theirs.soldiers) {
      // isPresent, not canAct (step 6a): an observed downed enemy IS the
      // body you can see. Excluding the dead is still what makes corpse
      // ghosts client-side (witnessedDeaths remains the sole death source).
      if (isPresent(e) && this.visibleTo(viewer, e.x, e.z)) {
        soldiers.push(toSoldierState(e));
      }
    }

    const drones: DroneState[] = [toDroneState(mine.drone)];
    const ed = theirs.drone;
    if (ed.status === "deployed" && this.canSeeDrone(viewer, ed.x, ed.z)) {
      drones.push(toDroneState(ed));
    }

    // Each endpoint of a shot is gated independently. Seeing the impact on
    // your own soldier must never hand you the shooter's coordinates: fire
    // range reaches past vision range, so a tracer drawn back to an
    // unobserved origin is a free, pixel-accurate reveal.
    const shots: ShotEvent[] = [];
    for (const ev of this.shots) {
      const originVisible =
        ev.shooter === viewer || this.visibleTo(viewer, ev.fx, ev.fz);
      // A shot at your own soldier is always felt, even when that soldier was
      // the viewer's last visibility source and died to this very hit —
      // otherwise a player gets no feedback that their unit was killed.
      const targetVisible =
        ev.targetFaction === viewer ||
        (ev.targetKind === "drone"
          ? this.canSeeDrone(viewer, ev.tx, ev.tz)
          : this.visibleTo(viewer, ev.tx, ev.tz));
      if (originVisible) {
        shots.push({
          fx: ev.fx,
          fz: ev.fz,
          tx: ev.tx,
          tz: ev.tz,
          hit: ev.hit,
          targetKind: ev.targetKind,
        });
      } else if (targetVisible) {
        // Impact only: the viewer learns it was fired upon, not from where.
        shots.push({
          tx: ev.tx,
          tz: ev.tz,
          hit: ev.hit,
          targetKind: ev.targetKind,
        });
      }
    }

    // Carriable fog, no special case: your own faction's carriables are
    // always visible to you; otherwise a carriable is visible when its
    // position is observed — for a carried one that position mirrors the
    // carrier, so it is visible exactly when the carrier is. No contact
    // memory in this step: a film leaving observation simply disappears
    // (becomes wrong at step 6, where a captured leader must persist as a
    // decaying contact).
    const carriables: CarriableState[] = [];
    for (const c of this.carriables) {
      const enemyCarrier =
        c.carrierId !== null &&
        theirs.soldiers.some((s) => s.id === c.carrierId);
      // Enemy custody outside LOS: never ship live x/z or carrierId — that
      // was tracking the captor through fog via the prisoner's body.
      if (enemyCarrier && !this.visibleTo(viewer, c.x, c.z)) {
        continue;
      }
      // Own/mission items always known when not in enemy hands; otherwise
      // observation gates knowledge. Pickup eligibility is not knowledge.
      const ours =
        (c.soldierId !== undefined
          ? mine.soldiers.some((s) => s.id === c.soldierId)
          : c.pickupFactions.includes(viewer)) ||
        (c.carrierId !== null && !enemyCarrier);
      if (ours || this.visibleTo(viewer, c.x, c.z)) {
        carriables.push({
          id: c.id,
          kind: c.kind,
          x: c.x,
          z: c.z,
          carrierId: c.carrierId,
        });
      }
    }

    // Last-known contacts: only units NOT observed this tick (observed ones
    // are in soldiers/drones — emitting both would double-render them).
    const contacts: ContactState[] = [];
    for (const [id, c] of this.contactMemory[viewer]) {
      if (c.seenAt >= this.time) continue; // refreshed this tick → live
      contacts.push({
        id,
        faction: c.faction,
        kind: c.kind,
        rank: c.rank,
        x: c.x,
        z: c.z,
        age: this.time - c.seenAt,
      });
    }

    return {
      tick: this.tick,
      time: this.time,
      phase: this.finished ? "finished" : "active",
      soldiers,
      drones,
      shots,
      contacts,
      witnessedDeaths: [...this.witnessedDeaths[viewer]],
      carriables,
      objective: this.rules.presentation?.(this.ctx) ?? null,
      activeCounts: {
        ukraine: this.aliveCount("ukraine"),
        russia: this.aliveCount("russia"),
      },
    };
  }
}

function toSoldierState(s: Soldier): SoldierState {
  return {
    id: s.id,
    faction: s.faction,
    rank: s.rank,
    x: s.x,
    z: s.z,
    heading: s.heading,
    health: Math.round(s.health),
    maxHealth: s.maxHealth,
    condition: s.condition,
    moving: s.moving,
    fireControl: s.fireControl,
    ammunition: s.ammunition,
    suppression: Math.round(s.suppression),
    cohesion: s.cohesion,
    subduing: s.subduing ? { ...s.subduing } : null,
    isLeader: s.isLeader || undefined,
  };
}

function toDroneState(d: Drone): DroneState {
  return {
    faction: d.faction,
    x: d.x,
    z: d.z,
    health: d.health,
    battery: Math.round(d.battery * 10) / 10,
    status: d.status,
  };
}
