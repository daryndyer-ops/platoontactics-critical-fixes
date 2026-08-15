// PlatoonTactics — shared game protocol, rules, and map data.
// Both the authoritative game server and the browser client import from here.

// ---------------------------------------------------------------------------
// Factions & ranks
// ---------------------------------------------------------------------------

export type Faction = "ukraine" | "russia";

export type Rank =
  | "captain"
  | "lieutenant"
  | "sergeant"
  | "master_corporal"
  | "private";

export interface SoldierDef {
  rank: Rank;
  label: string;
  role: string;
  maxHealth: number;
  /** Units per second */
  speed: number;
  /** Vision radius in map units */
  visionRange: number;
  /** Max effective fire range in map units */
  fireRange: number;
  /** Seconds between shots */
  fireCooldown: number;
  /** [min, max] damage per hit */
  damage: [number, number];
}

export const SOLDIER_DEFS: Record<Rank, SoldierDef> = {
  captain: {
    rank: "captain",
    label: "Captain",
    role: "Platoon leader",
    maxHealth: 120,
    speed: 4.2,
    visionRange: 26,
    fireRange: 24,
    fireCooldown: 1.1,
    damage: [22, 28],
  },
  lieutenant: {
    rank: "lieutenant",
    label: "Lieutenant",
    role: "Marksman",
    maxHealth: 110,
    speed: 4.2,
    visionRange: 30,
    fireRange: 30,
    fireCooldown: 1.6,
    damage: [22, 28],
  },
  sergeant: {
    rank: "sergeant",
    label: "Sergeant",
    role: "Machine gunner",
    maxHealth: 100,
    speed: 3.4,
    visionRange: 24,
    fireRange: 24,
    fireCooldown: 0.7,
    damage: [22, 28],
  },
  master_corporal: {
    rank: "master_corporal",
    label: "Master Corporal",
    role: "Scout",
    maxHealth: 100,
    speed: 5.2,
    visionRange: 30,
    fireRange: 22,
    fireCooldown: 1.1,
    damage: [22, 28],
  },
  private: {
    rank: "private",
    label: "Private",
    role: "Rifleman",
    maxHealth: 90,
    speed: 4.4,
    visionRange: 25,
    fireRange: 24,
    fireCooldown: 1.0,
    damage: [22, 28],
  },
};

export const PLATOON_RANKS: Rank[] = [
  "captain",
  "lieutenant",
  "sergeant",
  "master_corporal",
  "private",
];

// ---------------------------------------------------------------------------
// Cover
// ---------------------------------------------------------------------------

export type CoverLevel = "light" | "medium" | "heavy";

/** Fractional damage reduction while in cover relative to the shooter. */
export const COVER_REDUCTION: Record<CoverLevel, number> = {
  light: 0.25,
  medium: 0.45,
  heavy: 0.6,
};

/** A soldier must be within this distance of an obstacle to benefit from its cover. */
export const COVER_RADIUS = 2.5;

// ---------------------------------------------------------------------------
// Subdue (Capture the Leader)
// ---------------------------------------------------------------------------

/** Max distance from subduer to target when the order is issued AND held. */
export const SUBDUE_RANGE = 2.0;

/** Wind-up length in ticks (~2.5 s at 15 Hz). Shared so the client can
 * render the progress arc from `SoldierState.subduing.ticksRemaining`. */
export const SUBDUE_TICKS = 38;

// ---------------------------------------------------------------------------
// Drone
// ---------------------------------------------------------------------------

export const DRONE = {
  /** Battery in seconds of flight time */
  battery: 90,
  speed: 9,
  maxHealth: 30,
  visionRange: 20,
  /** Height the drone flies at (render only) */
  altitude: 10,
  /** Soldiers auto-engage enemy drones within this range */
  engageRange: 16,
  /** Chance per eligible shot that a soldier hits the drone */
  hitChance: 0.25,
  /** Damage per hit against a drone */
  hitDamage: 10,
} as const;

// ---------------------------------------------------------------------------
// Match rules
// ---------------------------------------------------------------------------

export const MATCH = {
  /** Server simulation + broadcast rate (Hz) */
  tickRate: 15,
  /** Cumulative uncontested seconds holding the objective to win */
  objectiveHoldSeconds: 60,
  /** Radius of the central objective zone */
  objectiveRadius: 9,
  /** Hard time limit (seconds); most kills wins at timeout, then objective progress */
  timeLimitSeconds: 15 * 60,
} as const;

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

export interface Vec2 {
  x: number;
  z: number;
}

export type ObstacleKind =
  | "sandbag"
  | "crate"
  | "rock"
  | "wall"
  | "wreck"
  | "building";

export interface Obstacle {
  id: string;
  kind: ObstacleKind;
  /** Center position */
  x: number;
  z: number;
  /** Full width (x-axis) and depth (z-axis) */
  w: number;
  d: number;
  /** Render height */
  h: number;
  cover: CoverLevel;
  /** Blocks line of sight for ground units (buildings, walls, wrecks) */
  blocksSight: boolean;
  /** Blocks movement */
  blocksMovement: boolean;
}

export interface GameMap {
  /** Half-extent: playable area is [-size, size] on x and z */
  size: number;
  objective: { x: number; z: number; radius: number };
  spawns: Record<Faction, Vec2[]>;
  obstacles: Obstacle[];
}

function ob(
  id: string,
  kind: ObstacleKind,
  x: number,
  z: number,
  w: number,
  d: number,
  h: number,
  cover: CoverLevel,
  blocksSight: boolean,
  blocksMovement = true,
): Obstacle {
  return { id, kind, x, z, w, d, h, cover, blocksSight, blocksMovement };
}

/**
 * "Frontline Crossing" — one small map: open ground, scattered cover,
 * a few buildings, central objective. Ukraine spawns west, Russia east.
 */
export const MAP: GameMap = {
  size: 60,
  objective: { x: 0, z: 0, radius: MATCH.objectiveRadius },
  spawns: {
    ukraine: [
      { x: -52, z: -6 },
      { x: -52, z: -3 },
      { x: -52, z: 0 },
      { x: -52, z: 3 },
      { x: -52, z: 6 },
    ],
    russia: [
      { x: 52, z: -6 },
      { x: 52, z: -3 },
      { x: 52, z: 0 },
      { x: 52, z: 3 },
      { x: 52, z: 6 },
    ],
  },
  obstacles: [
    // Central village around the objective
    ob("bldg-1", "building", -8, -14, 10, 8, 6, "heavy", true),
    ob("bldg-2", "building", 9, 12, 9, 9, 5, "heavy", true),
    ob("bldg-3", "building", 14, -10, 8, 7, 5, "heavy", true),
    ob("wall-1", "wall", 0, 8, 14, 1.2, 2, "medium", true),
    ob("wall-2", "wall", -4, -5, 1.2, 10, 2, "medium", true),

    // West approach (Ukraine side)
    ob("sb-w1", "sandbag", -30, -8, 5, 1.4, 1.1, "medium", false),
    ob("sb-w2", "sandbag", -26, 10, 5, 1.4, 1.1, "medium", false),
    ob("crate-w1", "crate", -36, 2, 2.2, 2.2, 1.6, "light", false),
    ob("rock-w1", "rock", -20, -20, 4, 3, 2.2, "medium", true),
    ob("wreck-w1", "wreck", -16, 16, 5.5, 2.4, 2.2, "heavy", true),

    // East approach (Russia side)
    ob("sb-e1", "sandbag", 30, 8, 5, 1.4, 1.1, "medium", false),
    ob("sb-e2", "sandbag", 26, -10, 5, 1.4, 1.1, "medium", false),
    ob("crate-e1", "crate", 36, -2, 2.2, 2.2, 1.6, "light", false),
    ob("rock-e1", "rock", 20, 20, 4, 3, 2.2, "medium", true),
    ob("wreck-e1", "wreck", 16, -16, 5.5, 2.4, 2.2, "heavy", true),

    // North & south flanks
    ob("rock-n1", "rock", 0, -30, 5, 4, 2.5, "medium", true),
    ob("sb-n1", "sandbag", -12, -26, 5, 1.4, 1.1, "medium", false),
    ob("crate-n1", "crate", 12, -28, 2.2, 2.2, 1.6, "light", false),
    ob("rock-s1", "rock", 2, 30, 5, 4, 2.5, "medium", true),
    ob("sb-s1", "sandbag", 14, 26, 5, 1.4, 1.1, "medium", false),
    ob("crate-s1", "crate", -12, 28, 2.2, 2.2, 1.6, "light", false),
  ],
};

// ---------------------------------------------------------------------------
// Cover geometry — THE cover rule, shared by the damage model and the HUD
//
// Moved here from the engine so both sides import one function: the readout
// cannot disagree with the damage model, because it IS the damage model's
// code. Pure relocation — behaviour is gated by the engine's combat tests.
// ---------------------------------------------------------------------------

function dist2d(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(bx - ax, bz - az);
}

/** Segment vs expanded AABB (slab method) on the XZ plane. */
export function segmentHitsBox(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  o: Obstacle,
  pad = 0,
): boolean {
  const minX = o.x - o.w / 2 - pad;
  const maxX = o.x + o.w / 2 + pad;
  const minZ = o.z - o.d / 2 - pad;
  const maxZ = o.z + o.d / 2 + pad;
  const dx = bx - ax;
  const dz = bz - az;
  let tmin = 0;
  let tmax = 1;
  for (const [p, d, lo, hi] of [
    [ax, dx, minX, maxX],
    [az, dz, minZ, maxZ],
  ] as const) {
    if (Math.abs(d) < 1e-9) {
      if (p < lo || p > hi) return false;
    } else {
      let t1 = (lo - p) / d;
      let t2 = (hi - p) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
  }
  return true;
}

/**
 * Best cover level protecting `target` from a shot originating at shooter.
 *
 * THE 0.4 PAD IS THE PEEK MECHANIC, not an inconsistency with the engine's
 * `hasLineOfSight` (which pads by 0). A shot that grazes past a corner by
 * less than 0.4 has line of sight — it can be taken — but the corner still
 * grants the target its cover reduction. Sight is exact; protection is
 * generous. Tested in visibility.test.ts ("peek"); change with care.
 */
export function coverFor(
  sx: number,
  sz: number,
  tx: number,
  tz: number,
): CoverLevel | null {
  let best: CoverLevel | null = null;
  let bestVal = 0;
  for (const o of MAP.obstacles) {
    // Target must hug the obstacle
    const nearX = Math.max(o.x - o.w / 2, Math.min(tx, o.x + o.w / 2));
    const nearZ = Math.max(o.z - o.d / 2, Math.min(tz, o.z + o.d / 2));
    if (dist2d(tx, tz, nearX, nearZ) > COVER_RADIUS) continue;
    // Obstacle must lie between shooter and target (shot path clips its box,
    // slightly padded, closer to the target than to the shooter).
    if (!segmentHitsBox(sx, sz, tx, tz, o, 0.4)) continue;
    const val = COVER_REDUCTION[o.cover];
    if (val > bestVal) {
      bestVal = val;
      best = o.cover;
    }
  }
  return best;
}

/**
 * Generic "is there anything here that could protect me" sweep — direction
 * agnostic. Only honest when there is nobody to be protected from; the HUD
 * uses it solely as the no-known-threats fallback of `coverReadout`.
 */
export function nearCover(x: number, z: number): CoverLevel | null {
  let best: CoverLevel | null = null;
  let bestVal = 0;
  for (const o of MAP.obstacles) {
    const nearX = Math.max(o.x - o.w / 2, Math.min(x, o.x + o.w / 2));
    const nearZ = Math.max(o.z - o.d / 2, Math.min(z, o.z + o.d / 2));
    if (dist2d(x, z, nearX, nearZ) > COVER_RADIUS) continue;
    const val = COVER_REDUCTION[o.cover];
    if (val > bestVal) {
      bestVal = val;
      best = o.cover;
    }
  }
  return best;
}

/**
 * What a unit card should say about a soldier's cover, judged against the
 * threats the viewer knows about (see `knownThreats`).
 *
 * Worst case wins: the honest question is "am I exposed to anything", not
 * "is something protecting me from something". With no known threats this
 * falls back to `nearCover` — "is there anything here that could protect
 * me" is the right answer exactly until there is somebody to be protected
 * from.
 */
export type CoverReadout =
  | { kind: "cover"; level: CoverLevel }
  | { kind: "exposed"; uncovered: number };

export function coverReadout(
  x: number,
  z: number,
  threats: Vec2[],
): CoverReadout {
  if (threats.length === 0) {
    const level = nearCover(x, z);
    return level
      ? { kind: "cover", level }
      : { kind: "exposed", uncovered: 0 };
  }
  let uncovered = 0;
  let worst: CoverLevel | null = null;
  let worstVal = Infinity;
  for (const t of threats) {
    const c = coverFor(t.x, t.z, x, z);
    if (c === null) uncovered += 1;
    else if (COVER_REDUCTION[c] < worstVal) {
      worstVal = COVER_REDUCTION[c];
      worst = c;
    }
  }
  return uncovered > 0
    ? { kind: "exposed", uncovered }
    : { kind: "cover", level: worst! };
}

/**
 * The viewer's known threat set: every visible ACTIVE enemy soldier plus
 * every frozen soldier contact. Deliberately client-side and fog-derived —
 * computing this against all enemies server-side would leak the existence
 * and rough bearing of unobserved enemies through the cover indicator.
 * Drone contacts are excluded: drones cannot fire on soldiers.
 */
export function knownThreats(
  state: Pick<TickState, "soldiers" | "contacts">,
  viewer: Faction,
): Vec2[] {
  const threats: Vec2[] = [];
  for (const s of state.soldiers) {
    if (s.faction !== viewer && isActive(s)) threats.push({ x: s.x, z: s.z });
  }
  for (const c of state.contacts) {
    if (c.kind === "soldier") threats.push({ x: c.x, z: c.z });
  }
  return threats;
}

// ---------------------------------------------------------------------------
// Wire state (what the server broadcasts, already fog-of-war filtered)
// ---------------------------------------------------------------------------

/**
 * A soldier's participation state.
 *
 * `downed` and `subdued` are declared here but not produced by the engine
 * until the carriable substrate lands (steps 4 and 6). Clients must handle
 * them without crashing — treat as non-combatant, present on the map.
 */
export type Condition = "active" | "downed" | "subdued" | "dead";

/** The commander decides when a unit may open fire. */
export type FireControl = "hold" | "return_fire" | "suppress" | "engage";
export type CohesionBand = "steady" | "suppressed" | "pinned";

export const TACTICS = {
  startingAmmo: 48,
  suppressionPerShot: 18,
  suppressionRecoveryPerSecond: 11,
  suppressedAt: 35,
  pinnedAt: 70,
  returnFireMemoryTicks: 75,
} as const;

export function cohesionBand(pressure: number): CohesionBand {
  if (pressure >= TACTICS.pinnedAt) return "pinned";
  if (pressure >= TACTICS.suppressedAt) return "suppressed";
  return "steady";
}

/** Shoots, moves under own power, contributes to team vision. */
export const isActive = (s: { condition: Condition }): boolean =>
  s.condition === "active";

export interface SoldierState {
  id: string;
  faction: Faction;
  rank: Rank;
  x: number;
  z: number;
  /** Facing angle (radians, atan2(dx, dz) style around Y) */
  heading: number;
  health: number;
  maxHealth: number;
  condition: Condition;
  moving: boolean;
  /** Full tactical state is sent only for owned or currently observed units. */
  fireControl: FireControl;
  ammunition: number;
  suppression: number;
  cohesion: CohesionBand;
  /**
   * In-progress subdue wind-up (step 6b). Fog-filtered like any other
   * soldier field: you see an enemy's wind-up only when you can see the
   * enemy — the defender must be able to see a capture attempt and react.
   */
  subduing: { targetId: string; ticksRemaining: number } | null;
  /** Present when this unit is the Capture-mode leader. */
  isLeader?: boolean;
}

export interface DroneState {
  faction: Faction;
  x: number;
  z: number;
  health: number;
  battery: number;
  /** deployed = flying; destroyed/depleted drones are gone for the match */
  status: "ready" | "deployed" | "destroyed" | "depleted";
}

export interface ShotEvent {
  /**
   * Shooter position — present only when the viewer currently observes the
   * shooter. Omitted otherwise so incoming fire cannot reveal a position the
   * player has not earned; render an impact instead of a tracer line.
   */
  fx?: number;
  fz?: number;
  /** Target position (always present — it is a position the viewer can see) */
  tx: number;
  tz: number;
  hit: boolean;
  targetKind: "soldier" | "drone";
  /**
   * Tick the shot was fired, when it differs from the tick that delivered
   * it (backpressure carry-forward). The client must age carried shots into
   * the fade curve from this — never render a seconds-old shot as live fire
   * — and drop anything already past the tracer window.
   */
  tick?: number;
}

export type MatchPhase = "waiting" | "active" | "finished";

export interface ObjectiveState {
  /** Which faction is alone in the zone right now (null = empty or contested) */
  controlledBy: Faction | null;
  contested: boolean;
  /** Cumulative hold seconds per faction */
  progress: Record<Faction, number>;
}

/** Per-player, fog-filtered snapshot broadcast every tick. */
export interface TickState {
  tick: number;
  /** Match clock in seconds */
  time: number;
  phase: MatchPhase;
  /** Your soldiers (full info) + enemy soldiers currently visible to you */
  soldiers: SoldierState[];
  /** Your drone (always, if it exists) + enemy drone when visible */
  drones: DroneState[];
  /** Shots that happened since last tick and are visible to you */
  shots: ShotEvent[];
  /** Last-known positions of enemy units currently out of view */
  contacts: ContactState[];
  /**
   * Enemy soldier ids whose death THIS VIEWER witnessed this tick (their
   * corpse position was observed at the moment of confirmation). The only
   * legitimate source for rendering an enemy as dead — never infer a corpse
   * from activeCounts plus disappearance, which cannot distinguish "died"
   * from "slipped out of view".
   */
  witnessedDeaths: string[];
  /**
   * Carriables you may know about, fog-filtered: your faction's are always
   * shown; others when their position is observed. Empty in default matches.
   */
  carriables: CarriableState[];
  /**
   * Rule-set presentation state. Null when the active rule set has no
   * objective payload (unreachable under ClassicRules, which always emits).
   */
  objective: ObjectiveState | null;
  /** Alive counts are public knowledge (kill feed keeps score honest) */
  /**
   * Soldiers who can still ACT (fire, move under own power) — not soldiers
   * who are alive. In Capture a subdued soldier is alive but not counted
   * here; the old name ("alive counts") lied about exactly that.
   */
  activeCounts: Record<Faction, number>;
}

/**
 * A contact marker expires when its uncertainty radius (`speed * age`)
 * exceeds this many units — roughly one vision range. Radius-driven expiry
 * self-tunes per rank: faster units are harder to track once lost.
 */
export const CONTACT_EXPIRY_RADIUS = 25;

/**
 * A last-known enemy position, frozen at the moment contact was LOST and
 * never updated after. Uncertainty is derivable client-side from public
 * constants: the unit is within `speed * age` of (x, z). The server never
 * sends a fresher position for an unobserved unit than the last one
 * legitimately observed.
 */
export interface ContactState {
  id: string;
  faction: Faction;
  kind: "soldier" | "drone";
  /** Rank as legitimately observed at contact time (soldiers only). */
  rank?: Rank;
  /** Position at the moment contact was lost. Never updated. */
  x: number;
  z: number;
  /** Seconds since contact was lost. */
  age: number;
}

// ---------------------------------------------------------------------------
// Carriables & zones (Objective Substrate step 4)
// ---------------------------------------------------------------------------

/**
 * `body` is declared but not produced until subdue lands (step 6) — bodies
 * require `downed`/`subdued` to be reachable. Step 4 is film-only.
 */
export type CarriableKind = "film" | "body";

/**
 * Wire view of a carriable, fog-filtered. Deliberately omits
 * pickupFactions, pickupRadius, and carrySpeed — rules the client neither
 * needs nor should be trusted with.
 */
export interface CarriableState {
  id: string;
  kind: CarriableKind;
  x: number;
  z: number;
  /** Soldier id, or null when loose on the ground. */
  carrierId: string | null;
}

export type ZoneKind = "extraction" | "observation" | "protected" | "objective";

export interface Zone {
  id: string;
  kind: ZoneKind;
  /** Extraction zones belong to a faction. */
  faction?: Faction;
  x: number;
  z: number;
  radius: number;
  /** Observation only. */
  dwellSeconds?: number;
}

/** One entry in the server-recorded decisive-moment timeline. */
export interface TimelineEvent {
  kind: "elimination" | "drone_down";
  faction: Faction;
  rank?: Rank;
}

/**
 * All decisive events that resolved in the same tick, as one moment.
 * Identical for both players; a mutual kill is a single moment with an
 * elimination from each faction.
 */
export interface TimelineMoment {
  tick: number;
  time: number;
  events: TimelineEvent[];
}

export interface CommandMeasures {
  objectiveCompleted: boolean;
  forcePreserved: number;
  casualties: number;
  captures: number;
  rescues: number;
  ammunitionSpent: number;
  elapsedSeconds: number;
  assessment: "exemplary" | "disciplined" | "costly" | "mission_failed";
}

export interface AfterActionReport {
  byFaction: Record<Faction, CommandMeasures>;
}

export interface MatchResult {
  winner: Faction | null;
  reason: "elimination" | "objective" | "timeout" | "forfeit" | "scenario" | "capture";
  /** Server-authored factual command assessment; kills are never points. */
  afterAction?: AfterActionReport;
  /**
   * For scenario endings: the OutcomeRule id that fired, so the player
   * learns WHICH condition ended it. Absent for non-scenario endings.
   */
  ruleId?: string;
}

// ---------------------------------------------------------------------------
// Construction placements & scenarios (Objective Substrate steps 3–5)
// ---------------------------------------------------------------------------

export interface Placement {
  faction: Faction;
  rank: Rank;
  x: number;
  z: number;
  /** Radians. Defaults to the faction's spawn heading. */
  heading?: number;
  /** Defaults to SOLDIER_DEFS[rank].maxHealth. */
  health?: number;
  /** Defaults to "active". */
  condition?: Condition;
  /**
   * When true, damage that would kill this soldier instead leaves them
   * `downed` at 0 health. They do not act, cannot be targeted, and become
   * a body carriable. There is no timeout — a downed soldier stays downed
   * until a rule set does something about them.
   */
  downOnLethal?: boolean;
  /**
   * Factions whose soldiers may pick up this soldier's body.
   * Defaults to the soldier's own faction.
   */
  bodyPickupFactions?: Faction[];
  /** Capture-the-leader: exactly one per faction under CaptureRules. */
  isLeader?: boolean;
  /**
   * When this soldier's body carriable is inside the named zone, the
   * soldier reverts to `active` and the carriable is destroyed.
   * The engine performs this in stepZones; rules stay pure.
   */
  revivesInZone?: string;
}

/** An airborne drone staged at construction (status "deployed"). */
export interface DronePlacement {
  faction: Faction;
  x: number;
  z: number;
}

export interface CarriablePlacement {
  id: string;
  kind: CarriableKind;
  /** Start carried by this soldier… */
  carrierId?: string;
  /** …or loose here. Exactly one of the three forms. */
  x?: number;
  z?: number;
  /**
   * When set, this carriable does not exist until the named observation
   * zone's dwell completes. It spawns carried by the soldier who completed
   * it. Mutually exclusive with carrierId and with x/z.
   */
  unlockedBy?: string;
  pickupFactions: Faction[];
  /** Default 1.5. */
  pickupRadius?: number;
  /** Speed multiplier while carried. Default 1.0 for film. */
  carrySpeed?: number;
}

export interface OutcomeRuleBase {
  /** Stable id, surfaced in MatchResult so the player learns WHICH
   *  condition ended it. A loss with no named cause teaches nothing. */
  id: string;
  result: "win" | "loss";
}

export type OutcomeRule = OutcomeRuleBase &
  (
    | { on: "carriable_in_zone"; carriableId: string; zoneId: string }
    | { on: "zone_observed"; zoneId: string }
    | { on: "unit_condition"; unitId: string; condition: Condition }
    | { on: "unit_in_zone"; unitId: string; zoneId: string }
    | { on: "faction_eliminated"; faction: Faction }
    | { on: "time_expired" }
  );

export interface Scenario {
  id: string;
  title: string;
  briefing: string;
  seed: number;
  /** Which side the player commands. Maps "win"/"loss" onto a winner. */
  playerFaction: Faction;
  placements: Placement[];
  drones?: DronePlacement[];
  carriables?: CarriablePlacement[];
  zones?: Zone[];
  /** Scenario clock, independent of MATCH.timeLimitSeconds. */
  timeLimitSeconds: number;
  /**
   * Evaluated in array order — the order is LOAD-BEARING. A tick where two
   * outcomes hold simultaneously (film delivered as the last soldier dies)
   * resolves to whichever rule is listed first.
   */
  outcomes: OutcomeRule[];
}

// ---------------------------------------------------------------------------
// WebSocket messages
// ---------------------------------------------------------------------------

/**
 * Selectable rule set on match creation. Default "classic" when absent, so
 * existing clients and the bot path are unaffected.
 */
export type MatchMode = "classic" | "capture";

/** Client -> server */
export type ClientMessage =
  | { type: "create_match"; name: string; mode?: MatchMode }
  | { type: "create_solo"; name: string; mode?: MatchMode }
  | { type: "join_match"; code: string; name: string }
  | { type: "move_order"; soldierIds: string[]; target: Vec2 }
  | { type: "stop_order"; soldierIds: string[] }
  | { type: "fire_control_order"; soldierIds: string[]; fireControl: FireControl }
  | { type: "suppress_order"; soldierIds: string[]; target: Vec2 }
  | { type: "subdue_order"; soldierId: string; targetId: string }
  | { type: "deploy_drone"; target: Vec2 }
  | { type: "drone_move"; target: Vec2 }
  | { type: "recall_drone" }
  | { type: "leave_match" };

/** Server -> client */
export type ServerMessage =
  | { type: "match_created"; code: string; faction: Faction; mode: MatchMode }
  | { type: "match_joined"; code: string; faction: Faction; mode: MatchMode }
  | { type: "opponent_joined"; opponentName: string }
  // Static match facts ride match_start once rather than repeating on ticks.
  | { type: "match_start"; faction: Faction; opponentName: string; zones: Zone[]; mode: MatchMode }
  | { type: "tick"; state: TickState }
  | { type: "match_over"; result: MatchResult; state: TickState; timeline: TimelineMoment[] }
  | { type: "opponent_left" }
  | { type: "error"; message: string };

/** WebSocket endpoint path (routed through the shared proxy under /api). */
export const WS_PATH = "/api/ws";
