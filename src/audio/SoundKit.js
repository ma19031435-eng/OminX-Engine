/**
 * OminX Engine — procedural sound bank.
 *
 * The engine ships no audio files: every sound is synthesised from noise, oscillators and envelopes
 * at load time (a couple of milliseconds) and cached as an `AudioBuffer` per variation. That keeps
 * the build tiny, makes sounds pitch-randomisable per shot (no two gunshots identical) and means a
 * new weapon only needs a recipe, not a recording session.
 *
 * Each entry returns `{ buffer, gain, pitch, category }`. Weapons are layered: a transient crack,
 * a body, a mechanical action and a tail, which is what makes a rifle sound like a rifle.
 *
 * @module src/audio/SoundKit
 */

/** Deterministic-ish noise for reproducible buffers (seeded per sound so a soak is repeatable). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Renders a mono buffer from a per-sample generator.
 * @param {BaseAudioContext} ctx
 * @param {number} seconds
 * @param {(t: number, i: number, rng: () => number) => number} generate
 */
export function renderBuffer(ctx, seconds, generate, seed = 1) {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(seconds * rate));
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  const rng = mulberry32(seed);
  const dt = 1 / rate;
  for (let i = 0; i < length; i++) {
    const value = generate(i * dt, i, rng);
    data[i] = value > 1 ? 1 : value < -1 ? -1 : value;
  }
  return buffer;
}

const noise = (rng) => rng() * 2 - 1;

// --------------------------------------------------------------------------- generators
function gunshotRecipe(opts) {
  const {
    crackDuration = 0.055, crackBright = 0.85, bodyFrequency = 180, bodyDuration = 0.18,
    tailDuration = 0.36, tailGain = 0.35, mechanicalGain = 0.12, mechanicalDelay = 0.045, seed = 7,
  } = opts;
  return (ctx) => renderBuffer(ctx, crackDuration + Math.max(bodyDuration, tailDuration) + 0.1, (t, i, rng) => {
    // Transient: filtered white noise, very short — the "crack".
    let value = 0;
    if (t < crackDuration) {
      const envelope = Math.exp(-t / (crackDuration * 0.34));
      value += noise(rng) * envelope * crackBright;
    }
    // Body: a fast downward sine sweep — the low "thump" that carries the shot.
    if (t < bodyDuration) {
      const sweep = bodyFrequency * (1 + 2.6 * Math.exp(-t * 34));
      const envelope = Math.exp(-t / (bodyDuration * 0.42));
      value += Math.sin(2 * Math.PI * sweep * t) * envelope * 0.55;
    }
    // Tail: decaying noise with a slow envelope — room/outdoor reverb approximation.
    const tailStart = bodyDuration * 0.35;
    if (t > tailStart && t < tailStart + tailDuration) {
      const local = (t - tailStart) / tailDuration;
      value += noise(rng) * Math.exp(-local * 4.2) * tailGain * 0.6;
    }
    // Mechanical: a small metal click a few ms later (bolt, hammer, spring).
    if (mechanicalGain > 0 && Math.abs(t - mechanicalDelay) < 0.012) {
      const local = (t - mechanicalDelay) / 0.012;
      value += Math.sin(2 * Math.PI * 2400 * (t - mechanicalDelay)) * (1 - Math.abs(local)) * mechanicalGain;
    }
    return value;
  }, seed);
}

function clickRecipe({ duration = 0.09, frequency = 1400, gain = 0.45, noiseGain = 0.35, decay = 6, seed = 11 }) {
  return (ctx) => renderBuffer(ctx, duration, (t, i, rng) => {
    const envelope = Math.exp(-t * decay * 10);
    const tone = Math.sin(2 * Math.PI * frequency * t) * envelope * gain;
    const air = noise(rng) * envelope * noiseGain * 0.4;
    return tone + air;
  }, seed);
}

function footstepRecipe({ duration = 0.16, lowFrequency = 120, gain = 0.5, brightness = 0.35, seed = 3 }) {
  return (ctx) => renderBuffer(ctx, duration, (t, i, rng) => {
    const envelope = Math.exp(-t * 26);
    const thud = Math.sin(2 * Math.PI * lowFrequency * (1 - t * 1.6) * t) * envelope * gain;
    const grit = noise(rng) * envelope * brightness;
    return thud + grit;
  }, seed);
}

function explosionRecipe({ duration = 1.5, lowFrequency = 60, seed = 17 }) {
  return (ctx) => renderBuffer(ctx, duration, (t, i, rng) => {
    const envelope = Math.exp(-t * 3.1);
    const sub = Math.sin(2 * Math.PI * lowFrequency * (1 - t * 0.5) * t) * Math.exp(-t * 5) * 0.9;
    const body = noise(rng) * envelope * 0.75;
    const crack = t < 0.02 ? noise(rng) * 0.9 : 0;
    // Debris tail
    const debris = t > 0.25 ? noise(rng) * Math.exp(-(t - 0.25) * 2.4) * 0.28 : 0;
    return sub + body + crack + debris;
  }, seed);
}

function whooshRecipe({ duration = 0.32, seed = 23, gain = 0.5 }) {
  return (ctx) => renderBuffer(ctx, duration, (t, i, rng) => {
    // Bullet crack: a short, doppler-ish filtered noise burst sweeping down.
    const envelope = Math.exp(-t * 22) * (1 - Math.exp(-t * 400));
    const tone = Math.sin(2 * Math.PI * (2600 - t * 4200) * t) * 0.2;
    return (noise(rng) * 0.85 + tone) * envelope * gain;
  }, seed);
}

function fleshRecipe({ duration = 0.22, seed = 29 }) {
  return (ctx) => renderBuffer(ctx, duration, (t, i, rng) => {
    const envelope = Math.exp(-t * 16);
    const slap = Math.sin(2 * Math.PI * 140 * (1 - t) * t) * 0.7;
    const wet = noise(rng) * 0.45;
    return (slap + wet) * envelope;
  }, seed);
}

function uiBlipRecipe({ duration = 0.07, frequency = 900, up = true, seed = 31 }) {
  return (ctx) => renderBuffer(ctx, duration, (t) => {
    const sweep = frequency * (up ? 1 + t * 3 : 1 - t * 0.4);
    const envelope = Math.exp(-t * 28) * (1 - Math.exp(-t * 900));
    return Math.sin(2 * Math.PI * sweep * t) * envelope * 0.5;
  }, seed);
}

function reloadRecipe({ stages = 3, seed = 37, duration = 0.9 }) {
  return (ctx) => renderBuffer(ctx, duration, (t, i, rng) => {
    let value = 0;
    for (let s = 0; s < stages; s++) {
      const at = (s / stages) * duration * 0.7;
      const local = t - at;
      if (local < 0 || local > 0.08) continue;
      const envelope = Math.exp(-local * 40);
      const frequency = 900 + s * 420 + rng() * 200;
      value += Math.sin(2 * Math.PI * frequency * local) * envelope * 0.4;
      value += noise(rng) * envelope * 0.12;
    }
    return value;
  }, seed);
}

function ambientWindRecipe({ duration = 4, seed = 41 }) {
  return (ctx) => renderBuffer(ctx, duration, (t, i, rng) => {
    const slow = 0.5 + 0.5 * Math.sin(t * 0.7);
    const gust = 0.35 + 0.65 * Math.sin(t * 0.23 + 1.3);
    return noise(rng) * 0.28 * slow * gust;
  }, seed);
}

function shellDropRecipe({ duration = 0.5, seed = 43 }) {
  return (ctx) => renderBuffer(ctx, duration, (t, i, rng) => {
    const hits = [0.0, 0.11, 0.19, 0.24];
    let value = 0;
    for (const [index, at] of hits.entries()) {
      const local = t - at;
      if (local < 0 || local > 0.05) continue;
      const envelope = Math.exp(-local * 60);
      value += Math.sin(2 * Math.PI * (3200 + index * 700) * local) * envelope * (0.35 / (index + 1));
    }
    value += noise(rng) * 0.05 * Math.exp(-t * 12);
    return value;
  }, seed);
}

/**
 * The bank. Recipes are lazy: a buffer is only rendered the first time a name is played, so the
 * whole set costs nothing until the weapon that uses it fires.
 */
export const SOUND_RECIPES = {
  // --- firearms (weapon `definition.audio.fire` names) ---
  fire_rifle: { category: 'sfx', gain: 1, pitch: [0.96, 1.04], render: gunshotRecipe({ crackBright: 0.9, bodyFrequency: 170, bodyDuration: 0.2, tailGain: 0.4, seed: 101 }) },
  fire_carbine: { category: 'sfx', gain: 0.95, pitch: [0.98, 1.06], render: gunshotRecipe({ crackBright: 0.95, bodyFrequency: 195, bodyDuration: 0.16, seed: 102 }) },
  fire_smg: { category: 'sfx', gain: 0.86, pitch: [1.0, 1.1], render: gunshotRecipe({ crackBright: 0.98, bodyFrequency: 230, bodyDuration: 0.13, tailGain: 0.28, seed: 103 }) },
  fire_lmg: { category: 'sfx', gain: 1.05, pitch: [0.94, 1.02], render: gunshotRecipe({ crackBright: 0.88, bodyFrequency: 150, bodyDuration: 0.24, tailGain: 0.45, mechanicalGain: 0.16, seed: 104 }) },
  fire_shotgun: { category: 'sfx', gain: 1.1, pitch: [0.95, 1.03], render: gunshotRecipe({ crackBright: 0.8, bodyFrequency: 110, bodyDuration: 0.3, tailGain: 0.5, mechanicalGain: 0.2, mechanicalDelay: 0.07, seed: 105 }) },
  fire_sniper: { category: 'sfx', gain: 1.2, pitch: [0.97, 1.02], render: gunshotRecipe({ crackBright: 1, bodyFrequency: 130, bodyDuration: 0.34, tailDuration: 0.6, tailGain: 0.55, seed: 106 }) },
  fire_pistol: { category: 'sfx', gain: 0.8, pitch: [1.0, 1.08], render: gunshotRecipe({ crackBright: 0.95, bodyFrequency: 260, bodyDuration: 0.12, tailGain: 0.22, seed: 107 }) },
  fire_dmr: { category: 'sfx', gain: 1.0, pitch: [0.96, 1.03], render: gunshotRecipe({ crackBright: 0.95, bodyFrequency: 165, bodyDuration: 0.22, tailGain: 0.42, seed: 108 }) },
  fire_launcher: { category: 'sfx', gain: 1.15, pitch: [0.94, 1.0], render: gunshotRecipe({ crackBright: 0.6, bodyFrequency: 90, bodyDuration: 0.45, tailDuration: 0.7, tailGain: 0.6, seed: 109 }) },
  melee_swing: { category: 'sfx', gain: 0.5, pitch: [1.0, 1.2], render: whooshRecipe({ duration: 0.26, gain: 0.75, seed: 110 }) },

  // --- weapon handling ---
  dryfire: { category: 'sfx', gain: 0.45, pitch: [1.0, 1.05], render: clickRecipe({ duration: 0.05, frequency: 2200, gain: 0.4, noiseGain: 0.5, seed: 120 }) },
  shell_drop: { category: 'sfx', gain: 0.35, pitch: [0.94, 1.1], render: shellDropRecipe({ seed: 121 }) },
  reload_rifle: { category: 'sfx', gain: 0.7, pitch: [0.98, 1.04], render: reloadRecipe({ stages: 4, duration: 1.1, seed: 122 }) },
  reload_pistol: { category: 'sfx', gain: 0.6, pitch: [1.0, 1.08], render: reloadRecipe({ stages: 3, duration: 0.7, seed: 123 }) },
  reload_shotgun: { category: 'sfx', gain: 0.65, pitch: [0.98, 1.03], render: reloadRecipe({ stages: 5, duration: 1.4, seed: 124 }) },
  reload_sniper: { category: 'sfx', gain: 0.65, pitch: [0.96, 1.02], render: reloadRecipe({ stages: 4, duration: 1.3, seed: 125 }) },
  reload_lmg: { category: 'sfx', gain: 0.75, pitch: [0.95, 1.01], render: reloadRecipe({ stages: 4, duration: 1.5, seed: 126 }) },
  reload_launcher: { category: 'sfx', gain: 0.7, pitch: [0.94, 1.0], render: reloadRecipe({ stages: 3, duration: 1.6, seed: 127 }) },
  equip_rifle: { category: 'sfx', gain: 0.55, pitch: [0.98, 1.05], render: clickRecipe({ duration: 0.22, frequency: 700, gain: 0.35, noiseGain: 0.6, decay: 2.2, seed: 130 }) },
  equip_pistol: { category: 'sfx', gain: 0.5, pitch: [1.0, 1.08], render: clickRecipe({ duration: 0.18, frequency: 900, gain: 0.32, noiseGain: 0.5, decay: 2.6, seed: 131 }) },
  equip_shotgun: { category: 'sfx', gain: 0.6, pitch: [0.96, 1.03], render: clickRecipe({ duration: 0.26, frequency: 520, gain: 0.4, noiseGain: 0.7, decay: 1.8, seed: 132 }) },
  equip_sniper: { category: 'sfx', gain: 0.6, pitch: [0.96, 1.02], render: clickRecipe({ duration: 0.28, frequency: 460, gain: 0.42, noiseGain: 0.7, decay: 1.6, seed: 133 }) },
  equip_lmg: { category: 'sfx', gain: 0.62, pitch: [0.95, 1.02], render: clickRecipe({ duration: 0.3, frequency: 420, gain: 0.45, noiseGain: 0.75, decay: 1.5, seed: 134 }) },
  equip_knife: { category: 'sfx', gain: 0.45, pitch: [1.05, 1.2], render: clickRecipe({ duration: 0.14, frequency: 2600, gain: 0.3, noiseGain: 0.8, decay: 4, seed: 135 }) },
  equip_launcher: { category: 'sfx', gain: 0.62, pitch: [0.94, 1.0], render: clickRecipe({ duration: 0.32, frequency: 360, gain: 0.45, noiseGain: 0.8, decay: 1.4, seed: 136 }) },

  // --- impacts ---
  impact_concrete: { category: 'sfx', gain: 0.6, pitch: [0.9, 1.15], render: renderImpact({ seed: 200, low: 260, grit: 0.8, decay: 26, duration: 0.12 }) },
  impact_metal: { category: 'sfx', gain: 0.62, pitch: [0.95, 1.3], render: renderImpact({ seed: 201, low: 420, grit: 0.5, decay: 20, duration: 0.22, ring: 3200 }) },
  impact_wood: { category: 'sfx', gain: 0.55, pitch: [0.9, 1.15], render: renderImpact({ seed: 202, low: 200, grit: 0.6, decay: 30, duration: 0.13, ring: 1200 }) },
  impact_sand: { category: 'sfx', gain: 0.5, pitch: [0.9, 1.1], render: renderImpact({ seed: 203, low: 150, grit: 0.35, decay: 34, duration: 0.1 }) },
  impact_dirt: { category: 'sfx', gain: 0.5, pitch: [0.9, 1.1], render: renderImpact({ seed: 204, low: 140, grit: 0.32, decay: 30, duration: 0.11 }) },
  impact_rock: { category: 'sfx', gain: 0.6, pitch: [0.92, 1.2], render: renderImpact({ seed: 205, low: 300, grit: 0.7, decay: 24, duration: 0.14, ring: 2400 }) },
  impact_grass: { category: 'sfx', gain: 0.42, pitch: [0.95, 1.12], render: renderImpact({ seed: 206, low: 120, grit: 0.25, decay: 36, duration: 0.1 }) },
  impact_glass: { category: 'sfx', gain: 0.6, pitch: [1.0, 1.25], render: renderImpact({ seed: 207, low: 900, grit: 0.85, decay: 16, duration: 0.3, shatter: true }) },
  impact_rubber: { category: 'sfx', gain: 0.45, pitch: [0.9, 1.08], render: renderImpact({ seed: 208, low: 180, grit: 0.2, decay: 34, duration: 0.09 }) },
  impact_water: { category: 'sfx', gain: 0.55, pitch: [0.9, 1.1], render: renderImpact({ seed: 209, low: 320, grit: 0.55, decay: 22, duration: 0.24, splash: true }) },
  impact_flesh: { category: 'sfx', gain: 0.6, pitch: [0.95, 1.1], render: fleshRecipe({ seed: 210 }) },

  // --- explosions, grenades ---
  explosion: { category: 'sfx', gain: 1.25, pitch: [0.94, 1.03], render: explosionRecipe({ seed: 220 }) },
  explosion_large: { category: 'sfx', gain: 1.4, pitch: [0.9, 0.98], render: explosionRecipe({ duration: 2.4, lowFrequency: 44, seed: 221 }) },
  grenade_bounce: { category: 'sfx', gain: 0.4, pitch: [0.95, 1.15], render: clickRecipe({ duration: 0.1, frequency: 700, gain: 0.35, noiseGain: 0.5, decay: 3.4, seed: 222 }) },
  grenade_throw: { category: 'sfx', gain: 0.45, pitch: [1.0, 1.1], render: whooshRecipe({ duration: 0.22, gain: 0.6, seed: 223 }) },
  grenade_frag: { category: 'sfx', gain: 0.5, pitch: [1.0, 1.05], render: clickRecipe({ duration: 0.06, frequency: 1800, gain: 0.4, noiseGain: 0.4, decay: 8, seed: 224 }) },
  grenade_semtex: { category: 'sfx', gain: 0.5, pitch: [1.0, 1.05], render: clickRecipe({ duration: 0.06, frequency: 1500, gain: 0.4, noiseGain: 0.4, decay: 8, seed: 225 }) },
  grenade_smoke: { category: 'sfx', gain: 0.6, pitch: [0.95, 1.05], render: renderImpact({ seed: 226, low: 200, grit: 0.5, decay: 8, duration: 0.7, splash: true }) },
  grenade_flash: { category: 'sfx', gain: 1.3, pitch: [1.0, 1.05], render: renderImpact({ seed: 227, low: 1200, grit: 0.9, decay: 6, duration: 0.5, shatter: true }) },
  grenade_gas: { category: 'sfx', gain: 0.55, pitch: [0.95, 1.05], render: renderImpact({ seed: 228, low: 260, grit: 0.4, decay: 6, duration: 0.9, splash: true }) },
  grenade_emp: { category: 'sfx', gain: 0.7, pitch: [1.0, 1.1], render: uiBlipRecipe({ duration: 0.35, frequency: 3200, up: false, seed: 229 }) },
  grenade_fire: { category: 'sfx', gain: 0.7, pitch: [0.9, 1.0], render: explosionRecipe({ duration: 1.1, lowFrequency: 90, seed: 230 }) },

  // --- player state ---
  player_hurt: { category: 'sfx', gain: 0.7, pitch: [0.94, 1.06], render: fleshRecipe({ duration: 0.3, seed: 240 }) },
  player_death: { category: 'sfx', gain: 0.8, pitch: [0.9, 1.0], render: renderImpact({ seed: 241, low: 180, grit: 0.5, decay: 6, duration: 0.8, splash: true }) },
  player_land: { category: 'sfx', gain: 0.75, pitch: [0.92, 1.05], render: footstepRecipe({ duration: 0.22, lowFrequency: 90, gain: 0.7, brightness: 0.4, seed: 242 }) },
  player_jump: { category: 'sfx', gain: 0.4, pitch: [1.0, 1.12], render: footstepRecipe({ duration: 0.12, lowFrequency: 160, gain: 0.4, brightness: 0.25, seed: 243 }) },
  player_breath: { category: 'sfx', gain: 0.28, pitch: [0.95, 1.05], render: ambientWindRecipe({ duration: 1.4, seed: 244 }) },

  // --- footsteps by surface ---
  footstep_concrete: { category: 'sfx', gain: 0.42, pitch: [0.9, 1.14], render: footstepRecipe({ seed: 300, lowFrequency: 130, brightness: 0.4 }) },
  footstep_metal: { category: 'sfx', gain: 0.45, pitch: [0.95, 1.2], render: footstepRecipe({ seed: 301, lowFrequency: 220, brightness: 0.6 }) },
  footstep_wood: { category: 'sfx', gain: 0.4, pitch: [0.92, 1.12], render: footstepRecipe({ seed: 302, lowFrequency: 150, brightness: 0.38 }) },
  footstep_dirt: { category: 'sfx', gain: 0.36, pitch: [0.9, 1.1], render: footstepRecipe({ seed: 303, lowFrequency: 100, brightness: 0.22 }) },
  footstep_sand: { category: 'sfx', gain: 0.32, pitch: [0.9, 1.08], render: footstepRecipe({ seed: 304, lowFrequency: 90, brightness: 0.18 }) },
  footstep_grass: { category: 'sfx', gain: 0.34, pitch: [0.92, 1.12], render: footstepRecipe({ seed: 305, lowFrequency: 110, brightness: 0.26 }) },
  footstep_glass: { category: 'sfx', gain: 0.4, pitch: [1.0, 1.25], render: footstepRecipe({ seed: 306, lowFrequency: 400, brightness: 0.75 }) },
  footstep_water: { category: 'sfx', gain: 0.42, pitch: [0.9, 1.1], render: footstepRecipe({ seed: 307, lowFrequency: 180, brightness: 0.55 }) },
  footstep_rock: { category: 'sfx', gain: 0.42, pitch: [0.9, 1.12], render: footstepRecipe({ seed: 308, lowFrequency: 170, brightness: 0.45 }) },

  // --- feedback ---
  hitmarker: { category: 'ui', gain: 0.5, pitch: [1.0, 1.06], render: uiBlipRecipe({ duration: 0.06, frequency: 1500, up: true, seed: 400 }) },
  hitmarker_headshot: { category: 'ui', gain: 0.6, pitch: [1.0, 1.05], render: uiBlipRecipe({ duration: 0.08, frequency: 2100, up: true, seed: 401 }) },
  hitmarker_kill: { category: 'ui', gain: 0.65, pitch: [0.98, 1.04], render: uiBlipRecipe({ duration: 0.12, frequency: 1200, up: false, seed: 402 }) },
  kill_confirm: { category: 'ui', gain: 0.6, pitch: [1.0, 1.05], render: clickRecipe({ duration: 0.14, frequency: 1800, gain: 0.4, noiseGain: 0.15, decay: 6, seed: 403 }) },
  ui_click: { category: 'ui', gain: 0.35, pitch: [1.0, 1.08], render: uiBlipRecipe({ duration: 0.04, frequency: 1200, up: true, seed: 404 }) },
  ui_hover: { category: 'ui', gain: 0.2, pitch: [1.05, 1.15], render: uiBlipRecipe({ duration: 0.03, frequency: 1800, up: true, seed: 405 }) },
  capture_progress: { category: 'ui', gain: 0.35, pitch: [1.0, 1.02], render: uiBlipRecipe({ duration: 0.1, frequency: 700, up: true, seed: 406 }) },
  capture_complete: { category: 'ui', gain: 0.55, pitch: [1.0, 1.04], render: uiBlipRecipe({ duration: 0.3, frequency: 600, up: true, seed: 407 }) },
  capture_lost: { category: 'ui', gain: 0.5, pitch: [1.0, 1.04], render: uiBlipRecipe({ duration: 0.3, frequency: 500, up: false, seed: 408 }) },
  pickup_health: { category: 'ui', gain: 0.45, pitch: [1.0, 1.06], render: uiBlipRecipe({ duration: 0.18, frequency: 800, up: true, seed: 409 }) },
  pickup_armor: { category: 'ui', gain: 0.45, pitch: [1.0, 1.06], render: uiBlipRecipe({ duration: 0.18, frequency: 600, up: true, seed: 410 }) },
  pickup_ammo: { category: 'ui', gain: 0.45, pitch: [1.0, 1.06], render: uiBlipRecipe({ duration: 0.16, frequency: 1000, up: true, seed: 411 }) },
  near_miss: { category: 'sfx', gain: 0.55, pitch: [0.95, 1.15], render: whooshRecipe({ duration: 0.3, gain: 0.7, seed: 412 }) },
  suppressed_crack: { category: 'sfx', gain: 0.4, pitch: [1.0, 1.2], render: whooshRecipe({ duration: 0.2, gain: 0.55, seed: 413 }) },

  // --- ambience ---
  ambience_wind: { category: 'ambient', gain: 0.4, pitch: [1, 1], loop: true, render: ambientWindRecipe({ duration: 6, seed: 500 }) },
  ambience_fire: { category: 'ambient', gain: 0.35, pitch: [1, 1], loop: true, render: ambientWindRecipe({ duration: 4, seed: 501 }) },
};

/** Impacts share one recipe shape with per-surface tuning. */
function renderImpact({ seed = 1, low = 200, grit = 0.5, decay = 24, duration = 0.12, ring = 0, shatter = false, splash = false }) {
  return (ctx) => renderBuffer(ctx, duration, (t, i, rng) => {
    const envelope = Math.exp(-t * decay);
    let value = Math.sin(2 * Math.PI * low * (1 - t * 0.7) * t) * envelope * 0.55;
    value += noise(rng) * envelope * grit * 0.55;
    if (ring) value += Math.sin(2 * Math.PI * ring * t) * Math.exp(-t * decay * 0.6) * 0.22;
    if (shatter && t < duration) {
      // A handful of little glass shards landing after the initial break.
      for (let s = 0; s < 5; s++) {
        const at = 0.03 + s * 0.045 + rng() * 0.02;
        const local = t - at;
        if (local < 0 || local > 0.02) continue;
        value += Math.sin(2 * Math.PI * (2600 + rng() * 2600) * local) * Math.exp(-local * 200) * 0.3;
      }
    }
    if (splash && t > 0.02) value += noise(rng) * Math.exp(-t * 6) * 0.25;
    return value;
  }, seed);
}

/** Convenience: every sound name the engine can request. */
export const SOUND_NAMES = Object.keys(SOUND_RECIPES);

export { gunshotRecipe, clickRecipe, footstepRecipe, explosionRecipe, whooshRecipe, renderImpact, mulberry32 };
export default SOUND_RECIPES;
