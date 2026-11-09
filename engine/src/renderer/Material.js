/**
 * OminX Engine — PBR materials + the built-in FPS material library.
 *
 * Materials are plain data: the renderer derives a shader variant from a feature mask and
 * uploads uniforms each draw. `MaterialLibrary` builds every surface the game needs
 * (concrete, brick, sandbag, camo, gunmetal, glass, foliage, hazard stripes…) from the
 * procedural texture kit, so a map can be greyboxed and then dressed without any art files.
 * @module engine/renderer/Material
 */
import { Color3 } from '../math/Color3.js';
import { Vector2 } from '../math/Vector2.js';
import { Signal } from '../core/Signal.js';

export const AlphaMode = { Opaque: 'opaque', Cutout: 'cutout', Blend: 'blend', Additive: 'additive', Premultiplied: 'premultiplied' };
export const RenderQueue = { Opaque: 2000, Cutout: 2450, Sky: 1000, Decal: 2500, Transparent: 3000, Water: 3200, Particles: 3500, Sprite: 3600, Overlay: 3800 };

/** Shader feature bits used to build the permutation key. */
export const ShaderFeature = {
  Instanced: 1 << 0,
  Skinned: 1 << 1,
  ShadowCascades: 1 << 2,
  AlphaTest: 1 << 3,
  Wind: 1 << 4,
  Fog: 1 << 5,
  VertexColor: 1 << 6,
  EmissiveMap: 1 << 7,
};

let _id = 0;

export class Material {
  /**
   * @param {object} [opts]
   * @param {string} [opts.name]
   * @param {Color3|string|number[]} [opts.albedo] base color (Color3, hex string, or [r,g,b])
   * @param {number} [opts.opacity=1]
   * @param {number} [opts.roughness=0.8]
   * @param {number} [opts.metalness=0]
   * @param {number} [opts.reflectance=0.5] dielectric F0 scale
   * @param {Color3} [opts.emissive]
   * @param {number} [opts.emissiveIntensity=1]
   * @param {number} [opts.normalStrength=1]
   * @param {Vector2|number[]} [opts.uvScale]
   * @param {string} [opts.alphaMode='opaque']
   * @param {number} [opts.alphaCutoff=0.5]
   * @param {boolean} [opts.doubleSided=false]
   * @param {boolean} [opts.castShadow=true]
   * @param {boolean} [opts.receiveShadow=true]
   * @param {number} [opts.queue] overrides the auto render queue
   * @param {object} [opts.textures] { albedo, normal, roughness, metalness, ao, emissive }
   */
  constructor(opts = {}) {
    this.id = ++_id;
    this.name = opts.name ?? `material_${this.id}`;
    this.uuid = `mat_${this.id}_${Math.random().toString(36).slice(2, 8)}`;
    this.albedo = toColor3(opts.albedo ?? 0xffffff);
    this.opacity = opts.opacity ?? 1;
    this.roughness = opts.roughness ?? 0.82;
    this.metalness = opts.metalness ?? 0;
    this.reflectance = opts.reflectance ?? 0.5;
    this.emissive = toColor3(opts.emissive ?? 0x000000);
    this.emissiveIntensity = opts.emissiveIntensity ?? 1;
    this.normalStrength = opts.normalStrength ?? 1;
    this.aoStrength = opts.aoStrength ?? 1;
    this.uvScale = Array.isArray(opts.uvScale) ? new Vector2(opts.uvScale[0], opts.uvScale[1])
      : opts.uvScale instanceof Vector2 ? opts.uvScale : new Vector2(opts.uvScale ?? 1, opts.uvScale ?? 1);
    this.alphaMode = opts.alphaMode ?? AlphaMode.Opaque;
    this.alphaCutoff = opts.alphaCutoff ?? 0.5;
    this.doubleSided = opts.doubleSided ?? false;
    this.castShadow = opts.castShadow !== false;
    this.receiveShadow = opts.receiveShadow !== false;
    this.tint = opts.tint ? toColor3(opts.tint) : new Color3(1, 1, 1);
    this.saturation = opts.saturation ?? 1;
    this.depthWrite = opts.depthWrite ?? (this.alphaMode === AlphaMode.Opaque || this.alphaMode === AlphaMode.Cutout);
    this.depthTest = opts.depthTest !== false;
    this.sky = !!opts.sky;
    this.wind = !!opts.wind;
    this.vertexColors = opts.vertexColors !== false;
    /** Hooks for gameplay: what bullet holes / footstep sounds this surface produces. */
    this.impactDecal = opts.impactDecal ?? 'concrete';
    this.impactSound = opts.impactSound ?? 'impact_concrete';
    this.footstepSound = opts.footstepSound ?? 'step_concrete';
    this.penetrationResistance = opts.penetrationResistance ?? 0;   // 0 = not penetrable, 1 = paper thin
    this.textures = {
      albedo: opts.textures?.albedo ?? null,
      normal: opts.textures?.normal ?? null,
      roughness: opts.textures?.roughness ?? null,
      metalness: opts.textures?.metalness ?? null,
      ao: opts.textures?.ao ?? null,
      emissive: opts.textures?.emissive ?? null,
    };
    this.shader = opts.shader ?? 'default';
    this.queue = opts.queue ?? this._defaultQueue();
    /** Optional CPU-side custom uniforms for specialised materials (water, portal, thermal). */
    this.uniforms = opts.uniforms ?? {};
    this.version = 1;
    this.Changed = new Signal('Material.Changed');
    this._uniformCache = new Map();
  }

  static new(opts) { return new Material(opts); }
  static fromJSON(j) { return new Material(j); }

  _defaultQueue() {
    switch (this.alphaMode) {
      case AlphaMode.Blend: return RenderQueue.Transparent;
      case AlphaMode.Premultiplied: return RenderQueue.Transparent;
      case AlphaMode.Additive: return RenderQueue.Particles;
      case AlphaMode.Cutout: return RenderQueue.Cutout;
      default: return RenderQueue.Opaque;
    }
  }

  /** True when the material needs a depth-prepass before colour (transparent sorting). */
  get isTransparent() { return this.alphaMode === AlphaMode.Blend || this.alphaMode === AlphaMode.Additive || this.alphaMode === AlphaMode.Premultiplied; }
  get hasAlphaTest() { return this.alphaMode === AlphaMode.Cutout; }

  /** Stable 32-bit hash driving batching, sorting and shader selection. */
  get stateKey() {
    let h = 2166136261;
    const mix = (v) => { h = (h ^ (v | 0)) >>> 0; h = Math.imul(h, 16777619) >>> 0; };
    mix(this.queue);
    mix(this.doubleSided ? 1 : 0);
    mix(this.hasAlphaTest ? 1 : 0);
    mix(this.depthWrite ? 1 : 0);
    mix(this.textures.albedo ? this.textures.albedo.id : 0);
    mix(this.textures.normal ? this.textures.normal.id : 1);
    mix(this.shader.length);
    return h >>> 0;
  }

  /** Feature mask for shader variant selection. */
  featureMask({ instanced = false, skinned = false, shadowCascades = 3, vertexColors = false } = {}) {
    let mask = 0;
    if (instanced) mask |= ShaderFeature.Instanced;
    if (skinned) mask |= ShaderFeature.Skinned;
    if (shadowCascades > 0) mask |= ShaderFeature.ShadowCascades;
    if (this.hasAlphaTest) mask |= ShaderFeature.AlphaTest;
    if (this.wind) mask |= ShaderFeature.Wind;
    if (vertexColors) mask |= ShaderFeature.VertexColor;
    if (this.textures.emissive) mask |= ShaderFeature.EmissiveMap;
    return mask;
  }

  setColor(hexOrColor) { this.albedo = toColor3(hexOrColor); this.version++; this.Changed.emit('albedo'); return this; }
  setTexture(slot, texture) {
    if (!(slot in this.textures)) throw new Error(`Unknown texture slot "${slot}"`);
    this.textures[slot] = texture;
    this.version++;
    this.Changed.emit(slot);
    return this;
  }
  setUniform(name, value) { this.uniforms[name] = value; this.version++; return this; }
  setAlpha(value) { this.opacity = value; this.version++; return this; }
  setRoughness(value) { this.roughness = value; this.version++; return this; }
  setMetalness(value) { this.metalness = value; this.version++; return this; }
  setEmissive(color, intensity = null) {
    this.emissive = toColor3(color);
    if (intensity !== null) this.emissiveIntensity = intensity;
    this.version++;
    return this;
  }
  setUVScale(x, y = x) { this.uvScale.set(x, y); this.version++; return this; }
  setTint(hex) { this.tint = toColor3(hex); this.version++; return this; }
  /** Creates a modified copy — used for damage flashes and team-colored variants. */
  clone() {
    const m = new Material({
      name: this.name,
      albedo: this.albedo.clone(),
      opacity: this.opacity,
      roughness: this.roughness,
      metalness: this.metalness,
      reflectance: this.reflectance,
      emissive: this.emissive.clone(),
      emissiveIntensity: this.emissiveIntensity,
      normalStrength: this.normalStrength,
      aoStrength: this.aoStrength,
      uvScale: this.uvScale.clone(),
      alphaMode: this.alphaMode,
      alphaCutoff: this.alphaCutoff,
      doubleSided: this.doubleSided,
      castShadow: this.castShadow,
      receiveShadow: this.receiveShadow,
      tint: this.tint.clone(),
      saturation: this.saturation,
      depthWrite: this.depthWrite,
      depthTest: this.depthTest,
      wind: this.wind,
      vertexColors: this.vertexColors,
      impactDecal: this.impactDecal,
      impactSound: this.impactSound,
      footstepSound: this.footstepSound,
      penetrationResistance: this.penetrationResistance,
      shader: this.shader,
      queue: this.queue,
      uniforms: { ...this.uniforms },
    });
    m.textures = { ...this.textures };
    return m;
  }
  copyFrom(other) {
    this.albedo.copy(other.albedo);
    this.roughness = other.roughness;
    this.metalness = other.metalness;
    this.opacity = other.opacity;
    this.emissive.copy(other.emissive);
    this.textures = { ...other.textures };
    this.version++;
    return this;
  }

  /** Uploads all material uniforms to a bound program. */
  apply(program, { lightCount = 0 } = {}) {
    const u = this.uniforms;
    program.applyAll({
      uAlbedoColor: this.albedo,
      uOpacity: this.opacity,
      uRoughness: this.roughness,
      uMetalness: this.metalness,
      uReflectance: this.reflectance,
      uEmissive: [this.emissive.r * this.emissiveIntensity, this.emissive.g * this.emissiveIntensity, this.emissive.b * this.emissiveIntensity],
      uAlphaCutoff: this.hasAlphaTest ? this.alphaCutoff : 0,
      uNormalStrength: this.normalStrength,
      uAoStrength: this.aoStrength,
      uUVScale: [this.uvScale.x, this.uvScale.y],
      uTint: [this.tint.r, this.tint.g, this.tint.b, this.opacity],
      uSaturation: this.saturation,
      uUseVertexColor: this.vertexColors ? 1 : 0,
      uHasAlbedoMap: this.textures.albedo ? 1 : 0,
      uHasNormalMap: this.textures.normal ? 1 : 0,
      uHasRoughnessMap: this.textures.roughness ? 1 : 0,
      uHasMetalnessMap: this.textures.metalness ? 1 : 0,
      uHasAoMap: this.textures.ao ? 1 : 0,
      uHasEmissiveMap: this.textures.emissive ? 1 : 0,
    });
    for (const [key, value] of Object.entries(u)) program.apply(key, value);
    void lightCount;
    return this;
  }

  toJSON() {
    return {
      name: this.name,
      albedo: this.albedo.toArray(),
      opacity: this.opacity,
      roughness: this.roughness,
      metalness: this.metalness,
      emissive: this.emissive.toArray(),
      alphaMode: this.alphaMode,
      uvScale: [this.uvScale.x, this.uvScale.y],
    };
  }
  toString() { return `Material(${this.name}${this.isTransparent ? ', transparent' : ''})`; }
}

function toColor3(v) {
  if (v instanceof Color3) return v.clone();
  if (typeof v === 'string') return Color3.fromCSS(v);
  if (typeof v === 'number') return Color3.fromHex(`#${v.toString(16).padStart(6, '0')}`);
  if (Array.isArray(v)) return Color3.fromArray(v);
  return new Color3(1, 1, 1);
}

/** Authoring-name aliases: prop/character/weapon part keys → library material names. */
export const MATERIAL_ALIASES = {
  concrete: 'concrete', Concrete: 'concrete', concreteDark: 'concreteDark', brick: 'brick',
  metal: 'metal', Metal: 'metal', steel: 'metal', Rust: 'rust', rust: 'rust',
  wood: 'wood', Wood: 'wood', sandbag: 'sandbag', Sandbag: 'sandbag',
  dirt: 'dirt', Dirt: 'dirt', Ground: 'dirt', ground: 'dirt',
  rock: 'rock', Rock: 'rock', grass: 'grass', Grass: 'grass',
  foliage: 'foliage', Foliage: 'foliage', Leaves: 'foliage', leaves: 'foliage',
  hazard: 'hazard', Hazard: 'hazard', glass: 'glass', Glass: 'glass',
  rubber: 'rubber', Rubber: 'rubber', paint: 'rubber', Paint: 'rubber',
  skin: 'CharacterSkin', CharacterSkin: 'CharacterSkin', PlayerSkin: 'CharacterSkin',
  playerSkin: 'CharacterSkin', Skin: 'CharacterSkin',
  CharacterMid: 'CharacterMid', CharacterDark: 'CharacterDark', CharacterVest: 'CharacterVest',
  CharacterPouch: 'CharacterPouch', CharacterHelmet: 'CharacterHelmet',
  CharacterGoggle: 'CharacterGoggle', CharacterGlove: 'CharacterGlove',
  CharacterBoot: 'CharacterBoot', CharacterPants: 'CharacterPants', CharacterPack: 'CharacterPack',
  Vest: 'CharacterVest', Helmet: 'CharacterHelmet', Goggles: 'CharacterGoggle',
  BotArmor: 'BotArmor', botArmor: 'BotArmor', BotVisor: 'BotVisor', BotBlade: 'BotBlade',
  Tracer: 'Tracer', tracer: 'Tracer', MuzzleFlash: 'MuzzleFlash', muzzleFlash: 'MuzzleFlash',
  Smoke: 'Smoke', smoke: 'Smoke', Spark: 'Spark', spark: 'Spark', Blood: 'Blood', blood: 'Blood',
  Dust: 'Dust', dust: 'dust', Decal: 'Decal', decal: 'Decal', Water: 'Water', water: 'Water',
  TeamRed: 'TeamRed', TeamBlue: 'TeamBlue', Red: 'TeamRed', Blue: 'TeamBlue',
  Accent: 'Accent', accent: 'Accent', Health: 'Health', Ammo: 'Ammo', Objective: 'Objective',
  Neutral: 'Neutral', Invisible: 'Invisible', invisible: 'Invisible',
  WeaponGunmetal: 'WeaponGunmetal', WeaponPolymer: 'WeaponPolymer', WeaponWood: 'WeaponWood',
  WeaponAccent: 'WeaponAccent', WeaponGlass: 'WeaponGlass', WeaponBrass: 'WeaponBrass',
};

/**
 * MaterialLibrary — the engine's art direction. Keys are stable strings used by
 * `Renderer.getMaterial('concrete')`, map scenes, prop physics and the editor palette.
 */
export class MaterialLibrary {
  constructor(device, textures = {}) {
    this.device = device;
    this.textures = textures;
    this.materials = new Map();
    this._buildDefaults();
  }

  static create(device, textures) { return new MaterialLibrary(device, textures); }

  register(name, material) {
    material.name = material.name ?? name;
    this.materials.set(name, material);
    this._lower?.set(name.toLowerCase(), name);
    return material;
  }

  /**
   * Resolves a material by key with tolerance for authoring case and legacy aliases.
   * Map props, character parts and weapon parts each name their surface slightly
   * differently ("Concrete" vs "concrete" vs "PlayerSkin"); this keeps level code from
   * having to care, while still being an exact-match lookup on the hot path.
   */
  resolve(key, fallback = 'default') {
    if (!key) return this.get(fallback);
    const direct = this.materials.get(key);
    if (direct) return direct;
    this._lower ??= new Map();
    if (this._lower.size === 0) for (const name of this.materials.keys()) this._lower.set(name.toLowerCase(), name);
    const byCase = this._lower.get(String(key).toLowerCase());
    if (byCase) return this.materials.get(byCase);
    const alias = MATERIAL_ALIASES[key] ?? MATERIAL_ALIASES[String(key).toLowerCase()];
    if (alias) {
      const m = this.materials.get(alias);
      if (m) return m;
    }
    return this.get(fallback);
  }

  get(name, fallback = 'default') {
    const m = this.materials.get(name);
    if (m) return m;
    const k = String(name ?? '').toLowerCase();
    this._lower ??= new Map();
    if (this._lower.size === 0) for (const n of this.materials.keys()) this._lower.set(n.toLowerCase(), n);
    const byCase = this._lower.get(k);
    if (byCase) return this.materials.get(byCase);
    const alias = MATERIAL_ALIASES[name] ?? MATERIAL_ALIASES[k];
    if (alias && this.materials.has(alias)) return this.materials.get(alias);
    const base = this.materials.get(fallback);
    return base ?? this.materials.get('default');
  }
  has(name) { return this.materials.has(name) || this._lower?.has(String(name).toLowerCase()) || !!MATERIAL_ALIASES[name]; }
  all() { return [...this.materials.values()]; }
  names() { return [...this.materials.keys()]; }
  /** Creates (and caches) a tinted variant — e.g. team-colored spawn pads, damage flashes. */
  variant(baseName, suffix, overrides = {}) {
    const key = `${baseName}__${suffix}`;
    if (this.materials.has(key)) return this.materials.get(key);
    const base = this.get(baseName);
    const mat = base.clone();
    Object.assign(mat, overrides);
    if (overrides.albedo) mat.albedo = toColor3(overrides.albedo);
    if (overrides.tint) mat.tint = toColor3(overrides.tint);
    mat.name = key;
    this.materials.set(key, mat);
    return mat;
  }

  _buildDefaults() {
    const T = this.textures;
    const tex = (key) => T[key] ?? null;

    this.register('default', new Material({ name: 'default', albedo: 0xb0b3b8, roughness: 0.85 }));

    // --- world surfaces
    this.register('concrete', new Material({
      name: 'concrete', albedo: 0xffffff, roughness: 0.92, metalness: 0,
      normalStrength: 0.6, uvScale: 0.5, impactDecal: 'concrete', footstepSound: 'step_concrete',
      textures: { albedo: tex('concrete'), normal: tex('concreteNormal') },
    }));
    this.register('concreteDark', new Material({
      name: 'concreteDark', albedo: 0xffffff, roughness: 0.95, uvScale: 0.5,
      textures: { albedo: tex('concreteDark') },
    }));
    this.register('brick', new Material({
      name: 'brick', albedo: 0xffffff, roughness: 0.88, uvScale: 0.7,
      textures: { albedo: tex('brick') }, impactDecal: 'concrete',
    }));
    this.register('metal', new Material({
      name: 'metal', albedo: 0xffffff, roughness: 0.42, metalness: 0.85, uvScale: 0.6,
      reflectScale: 1, textures: { albedo: tex('metal'), normal: tex('metalNormal') },
      impactDecal: 'metal', impactSound: 'impact_metal', footstepSound: 'step_metal', penetrationResistance: 0.15,
    }));
    this.register('rust', new Material({
      name: 'rust', albedo: 0xffffff, roughness: 0.85, metalness: 0.35, uvScale: 0.8,
      textures: { albedo: tex('rust') }, impactDecal: 'metal',
    }));
    this.register('wood', new Material({
      name: 'wood', albedo: 0xffffff, roughness: 0.8, uvScale: 0.6,
      textures: { albedo: tex('wood') }, impactDecal: 'wood', footstepSound: 'step_wood',
      penetrationResistance: 0.45,
    }));
    this.register('sandbag', new Material({
      name: 'sandbag', albedo: 0xffffff, roughness: 0.95, uvScale: 0.5,
      textures: { albedo: tex('sandbag') }, impactDecal: 'sand', footstepSound: 'step_sand',
      penetrationResistance: 0.05,
    }));
    this.register('dirt', new Material({
      name: 'dirt', albedo: 0xffffff, roughness: 1.0, uvScale: 0.25,
      textures: { albedo: tex('dirt'), normal: tex('dirtNormal') }, impactDecal: 'sand', footstepSound: 'step_dirt',
    }));
    this.register('rock', new Material({
      name: 'rock', albedo: 0xffffff, roughness: 0.9, uvScale: 0.5,
      textures: { albedo: tex('rock') }, impactDecal: 'concrete', footstepSound: 'step_gravel',
    }));
    this.register('grass', new Material({
      name: 'grass', albedo: 0xffffff, roughness: 0.95, uvScale: 0.4,
      textures: { albedo: tex('grass') }, footstepSound: 'step_grass',
    }));
    this.register('foliage', new Material({
      name: 'foliage', albedo: 0xffffff, roughness: 0.85, uvScale: 1, wind: true,
      alphaMode: AlphaMode.Cutout, alphaCutoff: 0.35, doubleSided: true, castShadow: true,
      textures: { albedo: tex('foliage'), albedoAlpha: tex('foliageAlpha') }, footstepSound: 'step_grass',
      penetrationResistance: 0.9,
    }));
    this.register('hazard', new Material({
      name: 'hazard', albedo: 0xffffff, roughness: 0.6, metalness: 0.15, uvScale: 0.5,
      textures: { albedo: tex('hazard') }, impactDecal: 'metal',
    }));
    this.register('glass', new Material({
      name: 'glass', albedo: 0xbfe4ee, opacity: 0.28, roughness: 0.06, metalness: 0,
      alphaMode: AlphaMode.Blend, doubleSided: true, castShadow: false, queue: RenderQueue.Transparent,
      textures: { albedo: tex('glass') }, impactDecal: 'glass', penetrationResistance: 0.95,
    }));
    this.register('rubber', new Material({ name: 'rubber', albedo: 0x1d1f22, roughness: 0.95, metalness: 0 }));

    // --- characters
    this.register('CharacterSkin', new Material({ name: 'CharacterSkin', albedo: 0xffffff, roughness: 0.72, uvScale: 0.6, textures: { albedo: tex('skin') } }));
    this.register('CharacterMid', new Material({ name: 'CharacterMid', albedo: 0x3e4a35, roughness: 0.85, uvScale: 1.4, textures: { albedo: tex('camoGreen') } }));
    this.register('CharacterDark', new Material({ name: 'CharacterDark', albedo: 0x24282c, roughness: 0.8 }));
    this.register('CharacterVest', new Material({ name: 'CharacterVest', albedo: 0x2b2f26, roughness: 0.75, uvScale: 2 }));
    this.register('CharacterPouch', new Material({ name: 'CharacterPouch', albedo: 0x33382c, roughness: 0.9, uvScale: 2 }));
    this.register('CharacterHelmet', new Material({ name: 'CharacterHelmet', albedo: 0x2f3438, roughness: 0.55, metalness: 0.2 }));
    this.register('CharacterGoggle', new Material({ name: 'CharacterGoggle', albedo: 0x1a2b33, roughness: 0.15, metalness: 0.4 }));
    this.register('CharacterGlove', new Material({ name: 'CharacterGlove', albedo: 0x2a2d31, roughness: 0.85 }));
    this.register('CharacterBoot', new Material({ name: 'CharacterBoot', albedo: 0x1f2225, roughness: 0.9 }));
    this.register('CharacterPants', new Material({ name: 'CharacterPants', albedo: 0x3a4034, roughness: 0.9, uvScale: 1.6, textures: { albedo: tex('camoGreen') } }));
    this.register('CharacterPack', new Material({ name: 'CharacterPack', albedo: 0x39392c, roughness: 0.9, uvScale: 2 }));
    this.register('BotArmor', new Material({ name: 'BotArmor', albedo: 0x9aa1a8, roughness: 0.35, metalness: 0.8, uvScale: 1.2, textures: { albedo: tex('metal') } }));
    this.register('BotVisor', new Material({
      name: 'BotVisor', albedo: 0xff3b1f, emissive: 0xff2a10, emissiveIntensity: 2.4, roughness: 0.2,
    }));
    this.register('BotBlade', new Material({ name: 'BotBlade', albedo: 0x22252a, roughness: 0.4, metalness: 0.6, opacity: 0.65, alphaMode: AlphaMode.Blend }));

    // --- team colors, used from the top-down minimap through to spawn pads
    this.register('TeamRed', new Material({ name: 'TeamRed', albedo: 0xc0392b, roughness: 0.6, emissive: 0x3a0a05, emissiveIntensity: 0.8 }));
    this.register('TeamBlue', new Material({ name: 'TeamBlue', albedo: 0x2f6fb5, roughness: 0.6, emissive: 0x06182e, emissiveIntensity: 0.8 }));
    this.register('Accent', new Material({ name: 'Accent', albedo: 0xd9a441, roughness: 0.45, metalness: 0.3, emissive: 0x2a1c04, emissiveIntensity: 0.9 }));
    this.register('Health', new Material({ name: 'Health', albedo: 0xff4d5e, emissive: 0xff2233, emissiveIntensity: 1.4, roughness: 0.3 }));
    this.register('Ammo', new Material({ name: 'Ammo', albedo: 0xffc75e, emissive: 0xff9d00, emissiveIntensity: 1.1, roughness: 0.4 }));
    this.register('Objective', new Material({ name: 'Objective', albedo: 0x35d9a0, emissive: 0x18c98a, emissiveIntensity: 1.6, roughness: 0.3 }));
    this.register('Neutral', new Material({ name: 'Neutral', albedo: 0x9aa0a6, roughness: 0.7 }));
    this.register('Invisible', new Material({
      name: 'Invisible', albedo: 0xffffff, opacity: 0, alphaMode: AlphaMode.Blend, castShadow: false, receiveShadow: false, queue: RenderQueue.Overlay,
    }));

    // --- weapons
    this.register('WeaponGunmetal', new Material({
      name: 'WeaponGunmetal', albedo: 0x2c2f33, roughness: 0.32, metalness: 0.92, uvScale: 3,
      textures: { normal: tex('metalNormal') }, impactDecal: 'metal',
    }));
    this.register('WeaponPolymer', new Material({
      name: 'WeaponPolymer', albedo: 0x25282b, roughness: 0.68, metalness: 0.05, uvScale: 3,
    }));
    this.register('WeaponWood', new Material({
      name: 'WeaponWood', albedo: 0x6b4423, roughness: 0.6, metalness: 0.02, uvScale: 2,
      textures: { albedo: tex('wood') },
    }));
    this.register('WeaponAccent', new Material({ name: 'WeaponAccent', albedo: 0xc9a227, roughness: 0.35, metalness: 0.85 }));
    this.register('WeaponGlass', new Material({
      name: 'WeaponGlass', albedo: 0x8fd0e0, opacity: 0.35, roughness: 0.08, alphaMode: AlphaMode.Blend, castShadow: false,
    }));
    this.register('WeaponBrass', new Material({ name: 'WeaponBrass', albedo: 0xb08d3a, roughness: 0.28, metalness: 0.95 }));

    // --- effects
    this.register('Tracer', new Material({
      name: 'Tracer', albedo: 0xfff2c0, emissive: 0xffd27a, emissiveIntensity: 3.2,
      alphaMode: AlphaMode.Additive, depthWrite: false, queue: RenderQueue.Particles, castShadow: false, receiveShadow: false,
    }));
    this.register('MuzzleFlash', new Material({
      name: 'MuzzleFlash', albedo: 0xfff0c8, emissive: 0xffc266, emissiveIntensity: 6,
      alphaMode: AlphaMode.Additive, depthWrite: false, queue: RenderQueue.Particles, castShadow: false, receiveShadow: false,
    }));
    this.register('Smoke', new Material({
      name: 'Smoke', albedo: 0x9a9a9a, opacity: 0.55, roughness: 1, alphaMode: AlphaMode.Premultiplied,
      depthWrite: false, queue: RenderQueue.Particles, castShadow: false, receiveShadow: false,
    }));
    this.register('Spark', new Material({
      name: 'Spark', albedo: 0xffd27a, emissive: 0xffb347, emissiveIntensity: 4,
      alphaMode: AlphaMode.Additive, depthWrite: false, queue: RenderQueue.Particles, castShadow: false, receiveShadow: false,
    }));
    this.register('Blood', new Material({
      name: 'Blood', albedo: 0x8c0d10, opacity: 0.9, roughness: 0.4, alphaMode: AlphaMode.Premultiplied,
      depthWrite: false, queue: RenderQueue.Particles, castShadow: false, receiveShadow: false,
    }));
    this.register('Dust', new Material({
      name: 'Dust', albedo: 0xb8ad96, opacity: 0.4, alphaMode: AlphaMode.Premultiplied, depthWrite: false,
      queue: RenderQueue.Particles, castShadow: false, receiveShadow: false,
    }));
    this.register('Decal', new Material({
      name: 'Decal', albedo: 0xffffff, alphaMode: AlphaMode.Blend, depthWrite: false, queue: RenderQueue.Decal,
      castShadow: false, receiveShadow: false,
    }));
    this.register('Water', new Material({
      name: 'Water', albedo: 0x1d5b6b, opacity: 0.72, roughness: 0.08, metalness: 0.1, alphaMode: AlphaMode.Blend,
      queue: RenderQueue.Water, castShadow: false, uvScale: 0.2,
    }));
  }

  /** Swaps all textures at once (used after context restore / quality change). */
  refreshTextures(textures) {
    this.textures = textures;
    for (const mat of this.materials.values()) {
      if (mat.textures.albedo && mat.name === 'concrete') mat.textures.albedo = textures.concrete ?? mat.textures.albedo;
    }
    return this;
  }
  getStats() {
    const stats = { count: this.materials.size, transparent: 0, textured: 0 };
    for (const m of this.materials.values()) {
      if (m.isTransparent) stats.transparent++;
      if (m.textures.albedo) stats.textured++;
    }
    return stats;
  }
}

export default Material;
