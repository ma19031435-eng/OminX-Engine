/**
 * OminX Engine — procedural humanoid rigs.
 *
 * R15-style blocky rig so the animation layer can pose joints without skinning (cheap, and
 * bots stay readable at range — critical in an FPS). Both player and bot rigs share the same
 * part names, so the same animation clips and attachment logic drive both.
 *
 * Rig hierarchy (local space, +Y up, character faces -Z):
 *   root → hips → spine → chest → neck → head
 *                       → shoulderL/R → upperArmL/R → lowerArmL/R → handL/R
 *          → upperLegL/R → lowerLegL/R → footL/R
 *
 * @module engine/geometry/CharacterMeshes
 */
import { Mesh } from './Mesh.js';
import { Vector3 } from '../math/Vector3.js';
import { Vector3 as V3 } from '../math/Vector3.js';
import { createBox, createCylinder, createSphere, createCapsule, createIcosphere } from './Primitives.js';

/** Default humanoid proportions in metres (a 1.8 m character). */
export const HumanoidProportions = {
  headSize: 0.24,
  neckLength: 0.06,
  torsoHeight: 0.42,
  torsoWidth: 0.36,
  torsoDepth: 0.19,
  hipWidth: 0.26,
  upperArmLength: 0.28,
  lowerArmLength: 0.26,
  handLength: 0.09,
  upperLegLength: 0.44,
  lowerLegLength: 0.42,
  footLength: 0.24,
  hipHeight: 0.92,
};

/**
 * @param {object} [opts]
 * @param {'player'|'soldier'|'bot'|'robot'|'heavy'} [opts.style='soldier']
 * @param {string} [opts.team='blue']
 * @returns {CharacterRig}
 */
export function createHumanoid(opts = {}) {
  const style = opts.style ?? 'soldier';
  const p = { ...HumanoidProportions, ...(opts.proportions ?? {}) };
  const bulk = style === 'heavy' ? 1.18 : style === 'bot' || style === 'robot' ? 0.94 : 1;
  const parts = [];

  const add = (name, mesh, parentName, offset, materialKey, joint = null) => {
    const part = { name, mesh, parent: parentName, offset, material: materialKey, joint };
    parts.push(part);
    return part;
  };

  // ---------------------------------------------------------------- root & hips
  add('root', new Mesh({ name: 'root' }), null, new V3(0, 0, 0), 'Invisible');
  add('hips', createBox(p.hipWidth * bulk, 0.16, p.torsoDepth * 0.95), 'root', new V3(0, p.hipHeight, 0), 'CharacterDark');
  add('spine', createBox(p.torsoWidth * 0.92 * bulk, 0.12, p.torsoDepth * 0.9), 'hips', new V3(0, 0.11, 0), 'CharacterMid');
  add('chest', createBox(p.torsoWidth * bulk, 0.3, p.torsoDepth * bulk), 'spine', new V3(0, 0.14, 0), 'CharacterMid');
  // chest rig / plate carrier — instantly readable faction silhouette
  if (style === 'soldier' || style === 'heavy') {
    const vest = createBox(p.torsoWidth * bulk * 1.04, 0.26, p.torsoDepth * bulk * 1.16);
    add('vest', vest, 'chest', new V3(0, 0.0, 0), 'CharacterVest');
    for (let i = 0; i < 3; i++) {
      add(`pouch${i}`, createBox(0.075, 0.085, 0.05), 'chest', new V3(-0.09 + i * 0.09, -0.03, p.torsoDepth * bulk * 0.58), 'CharacterPouch');
    }
  }
  add('neck', createCylinder(0.05, 0.05, p.neckLength, 10), 'chest', new V3(0, 0.17, 0), 'CharacterSkin');

  // ---------------------------------------------------------------- head
  const head = createBox(p.headSize, p.headSize, p.headSize * 1.05);
  add('head', head, 'neck', new V3(0, p.headSize / 2 + 0.02, 0), 'CharacterSkin');
  if (style === 'bot' || style === 'robot') {
    // cyclops optic instead of eyes + exposed cabling
    add('visor', createBox(p.headSize * 0.86, 0.05, 0.02), 'head', new V3(0, 0.02, -p.headSize * 0.54), 'BotVisor', 'eyeL');
    add('skullPlate', createBox(p.headSize * 0.9, 0.04, p.headSize * 1.0), 'head', new V3(0, p.headSize * 0.5, 0), 'BotArmor');
    add('antenna', createCylinder(0.006, 0.006, 0.14, 6), 'head', new V3(0.06, p.headSize * 0.5 + 0.07, 0.02), 'BotArmor');
  } else {
    // helmet + goggles + headset: the "operator" look
    add('helmet', createBox(p.headSize * 1.12, p.headSize * 0.9, p.headSize * 1.12), 'head', new V3(0, 0.045, 0.005), 'CharacterHelmet');
    add('goggles', createBox(p.headSize * 0.94, 0.06, 0.03), 'head', new V3(0, 0.015, -p.headSize * 0.56), 'CharacterGoggle', 'eyeL');
    add('earPiece', createBox(0.03, 0.06, 0.05), 'head', new V3(-p.headSize * 0.55, 0, 0), 'CharacterDark');
    add('microphone', createCylinder(0.006, 0.006, 0.09, 6), 'head', new V3(-0.07, -0.04, -0.05), 'CharacterDark');
  }
  // muzzle anchor for bots so eye-height raycasts line up with the visual head
  add('eyes', new Mesh({ name: 'eyes' }), 'head', new V3(0, 0.01, -p.headSize * 0.55), 'Invisible', 'eyeL');

  // ---------------------------------------------------------------- arms
  const shoulderX = p.torsoWidth * bulk * 0.5 + 0.045;
  for (const side of [-1, 1]) {
    const s = side < 0 ? 'L' : 'R';
    add(`shoulder${s}`, createSphere(0.055 * bulk, 10, 8), 'chest', new V3(side * shoulderX, 0.1, 0), 'CharacterMid', s === 'R' ? 'shoulderR' : 'shoulderL');
    add(`upperArm${s}`, createBox(0.085 * bulk, p.upperArmLength, 0.085 * bulk), `shoulder${s}`, new V3(0, -p.upperArmLength / 2 - 0.02, 0), 'CharacterMid');
    add(`elbow${s}`, createSphere(0.045, 8, 6), `upperArm${s}`, new V3(0, -p.upperArmLength / 2, 0), 'CharacterDark');
    add(`lowerArm${s}`, createBox(0.078 * bulk, p.lowerArmLength, 0.078 * bulk), `elbow${s}`, new V3(0, -p.lowerArmLength / 2 - 0.01, 0), 'CharacterMid');
    const handMesh = createBox(0.08 * bulk, p.handLength, 0.09 * bulk);
    add(`hand${s}`, handMesh, `lowerArm${s}`, new V3(0, -p.lowerArmLength / 2 - p.handLength / 2, 0), 'CharacterGlove', 'gripPoint');
    // Gloves/boots accents
    add(`glove${s}`, createBox(0.085 * bulk, 0.11, 0.095 * bulk), `lowerArm${s}`, new V3(0, -p.lowerArmLength / 2 - 0.05, 0), 'CharacterGlove');
  }

  // ---------------------------------------------------------------- legs
  for (const side of [-1, 1]) {
    const s = side < 0 ? 'L' : 'R';
    const legX = p.hipWidth * 0.5 - 0.03;
    add(`upperLeg${s}`, createBox(0.115 * bulk, p.upperLegLength, 0.115 * bulk), 'hips', new V3(side * legX, -0.08 - p.upperLegLength / 2, 0), 'CharacterPants');
    add(`knee${s}`, createSphere(0.055, 8, 6), `upperLeg${s}`, new V3(0, -p.upperLegLength / 2, 0), 'CharacterDark');
    add(`lowerLeg${s}`, createBox(0.105 * bulk, p.lowerLegLength, 0.105 * bulk), `knee${s}`, new V3(0, -p.lowerLegLength / 2 - 0.01, 0), 'CharacterPants');
    add(`foot${s}`, createBox(0.11 * bulk, 0.075, p.footLength * bulk), `lowerLeg${s}`, new V3(0, -p.lowerLegLength / 2 - 0.02, -0.04), 'CharacterBoot');
  }

  // ---------------------------------------------------------------- extras
  const extras = {};
  if (style === 'soldier' || style === 'heavy') {
    // backpack silhouette so players are identifiable from behind
    const pack = createBox(0.28 * bulk, 0.34, 0.16);
    parts.push({ name: 'backpack', mesh: pack, parent: 'chest', offset: new V3(0, -0.02, p.torsoDepth * bulk * 0.62), material: 'CharacterPack' });
  }

  return new CharacterRig({
    name: `${style}_rig`,
    parts,
    style,
    team: opts.team ?? 'neutral',
    scale: opts.scale ?? 1,
    anchorNames: {
      head: 'head', eyes: 'eyes', rightHand: 'handR', leftHand: 'handL',
      chest: 'chest', hips: 'hips', feet: 'footL',
      // Combat anchors: bots aim from `gun`, bullets leave from `muzzle`,
      // name tags/health bars float above `head`, hit reactions use `chest`.
      gun: 'handR', muzzle: 'handR',
    },
    interpolated: style !== 'bot',
  });
}

/** Quadruped-ish drone rig (small flying bot variant) — cheap and menacing. */
export function createDrone() {
  const parts = [];
  parts.push({ name: 'root', mesh: new Mesh({ name: 'root' }), parent: null, offset: new V3(0, 0.9, 0), material: 'Invisible' });
  parts.push({ name: 'body', mesh: createBox(0.34, 0.14, 0.4), parent: 'root', offset: new V3(0, 0, 0), material: 'BotArmor' });
  parts.push({ name: 'head', mesh: createIcosphere(0.11, 1), parent: 'body', offset: new V3(0, 0.02, -0.26), material: 'BotArmor' });
  parts.push({ name: 'eyes', mesh: new Mesh({ name: 'eyes' }), parent: 'head', offset: new V3(0, 0, -0.09), material: 'Invisible' });
  for (const side of [-1, 1]) {
    const s = side < 0 ? 'L' : 'R';
    parts.push({ name: `rotor${s}`, mesh: createCylinder(0.005, 0.005, 0.34, 6), parent: 'body', offset: new V3(side * 0.17, 0.02, 0), material: 'BotArmor' });
    parts.push({ name: `blade${s}`, mesh: createBox(0.3, 0.006, 0.03), parent: `rotor${s}`, offset: new V3(0, 0.05, 0), material: 'BotBlade' });
  }
  parts.push({ name: 'gun', mesh: createBox(0.07, 0.07, 0.22), parent: 'body', offset: new V3(0, -0.06, -0.14), material: 'WeaponGunmetal' });
  return new CharacterRig({ name: 'drone_rig', parts, style: 'drone', anchorNames: { head: 'head', eyes: 'eyes', chest: 'body', gun: 'gun' } });
}

// ---------------------------------------------------------------------------
export class CharacterRig {
  constructor({ name, parts, style, team, scale = 1, anchorNames = {}, interpolated = true }) {
    this.name = name;
    this.style = style;
    this.team = team ?? 'neutral';
    this.scale = scale;
    this.parts = parts.map((p) => ({
      ...p,
      mesh: p.mesh,
      worldMatrix: null,
    }));
    this.partMap = new Map(this.parts.map((p) => [p.name, p]));
    this.anchorNames = anchorNames;
    this.interpolated = interpolated;
    this.triangleCount = this.parts.reduce((s, p) => s + p.mesh.triangleCount, 0);
    this.vertexCount = this.parts.reduce((s, p) => s + p.mesh.vertexCount, 0);
  }
  getPart(name) { return this.partMap.get(name); }
  /** Root offset in the parent (world) space, e.g. hips at 0.92 m. */
  getRootOffset() { return this.partMap.get('root')?.offset ?? new Vector3(); }
  /** Names of parts that act as attachment points. */
  getAnchors() {
    const out = {};
    for (const [key, partName] of Object.entries(this.anchorNames)) {
      const p = this.partMap.get(partName);
      if (p) out[key] = { part: partName, offset: p.offset };
    }
    return out;
  }
  clone() { return new CharacterRig({ name: this.name, parts: this.parts, style: this.style, team: this.team, scale: this.scale, anchorNames: this.anchorNames, interpolated: this.interpolated }); }
  toString() { return `CharacterRig(${this.name}, ${this.parts.length} parts, ${this.triangleCount} tris)`; }
}

/**
 * Builds every character variant the game needs at load time and caches them.
 * (FPS games spawn a lot of these — generating once and sharing meshes is essential.)
 */
export class CharacterLibrary {
  constructor() {
    this.rigs = new Map();
  }
  get(key) {
    if (this.rigs.has(key)) return this.rigs.get(key);
    let rig;
    if (key === 'drone') rig = createDrone();
    else if (key.startsWith('bot')) rig = createHumanoid({ style: key.split(':')[1] ?? 'bot' });
    else if (key.startsWith('player')) rig = createHumanoid({ style: 'soldier' });
    else rig = createHumanoid({ style: key });
    this.rigs.set(key, rig);
    return rig;
  }
  player() { return this.get('player'); }
  bot(variant = 'bot') { return this.get(`bot:${variant}`); }
  drone() { return this.get('drone'); }
  getAll() { return [...this.rigs.values()]; }
  getStats() { return { rigs: this.rigs.size, triangles: this.getAll().reduce((s, r) => s + r.triangleCount, 0) }; }
}

export const CharacterMeshes = { createHumanoid, createDrone, CharacterRig, CharacterLibrary, HumanoidProportions };
export default CharacterMeshes;
