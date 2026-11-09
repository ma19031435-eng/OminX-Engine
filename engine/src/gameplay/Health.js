/**
 * OminX Engine — health, armour, status effects and death/respawn bookkeeping.
 *
 * A single component used by players, bots and destructible props, so damage rules live in one
 * place: armour absorption (with plate break), health regeneration after a delay, damage-over-time
 * effects (fire, gas, bleeding), invulnerability windows (spawn protection), death with
 * attribution (who killed you, with what, from where, how far), and respawn scheduling.
 *
 * Signals are what the HUD, audio and netcode listen to — `Damaged`, `Healed`, `ArmorBroken`,
 * `Died`, `Respawned`, `EffectApplied`.
 *
 * @module engine/src/gameplay/Health.js
 */
import { Signal } from '../core/Signal.js';
import { Vector3 } from '../math/Vector3.js';
import { clamp, clamp01 } from '../math/MathUtils.js';

/** Status effects that can be stacked on a health component. */
export const StatusEffect = {
  Burning: 'burning',
  Gassed: 'gassed',
  Bleeding: 'bleeding',
  Suppressed: 'suppressed',
  Blinded: 'blinded',
  Electrified: 'electrified',
  Slowed: 'slowed',
  Marked: 'marked',
};

export class Health {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxHealth=100]
   * @param {number} [opts.maxArmor=0]
   * @param {number} [opts.regenDelay=6] seconds after last damage before regen starts
   * @param {number} [opts.regenRate=12] hp per second while regenerating
   * @param {number} [opts.regenCap=1] fraction of max health that can be regenerated to
   * @param {number} [opts.armorAbsorption=0.5] share of incoming damage armour takes
   * @param {boolean} [opts.regenerating=true]
   */
  constructor(opts = {}) {
    this.maxHealth = opts.maxHealth ?? 100;
    this.maxArmor = opts.maxArmor ?? 0;
    this.health = opts.health ?? this.maxHealth;
    this.armor = opts.armor ?? this.maxArmor;
    this.regenDelay = opts.regenDelay ?? 6;
    this.regenRate = opts.regenRate ?? 12;
    this.regenCap = opts.regenCap ?? 1;
    this.armorAbsorption = opts.armorAbsorption ?? 0.5;
    this.armorPiercingScale = opts.armorPiercingScale ?? 1.6;
    this.regenerating = opts.regenerating !== false;
    this.invulnerable = false;
    this.spawnProtection = opts.spawnProtection ?? 0;
    this.dead = false;
    this.respawnDelay = opts.respawnDelay ?? 5;
    this.respawnTimer = 0;
    this.respawnsLeft = opts.respawnsLeft ?? Infinity;
    this.owner = opts.owner ?? null;
    this.team = opts.team ?? 'neutral';
    this.lastDamageTime = -Infinity;
    this.lastAttacker = null;
    this.lastWeapon = null;
    this.lastDamageDirection = new Vector3();
    this.lastDamagePoint = new Vector3();
    this.lastDamageAmount = 0;
    this.damageTaken = 0;
    this.damageDealt = 0;
    this.kills = 0;
    this.deaths = 0;
    this.hitFlash = 0;              // 0..1, decays — drives the HUD blood vignette
    this.healthBlend = 1;           // smoothed health fraction for the HUD bar
    this.time = 0;

    /** @type {Map<string, {kind, remaining, dps, source, tick}>} */
    this.effects = new Map();
    this.Damaged = new Signal('Health.Damaged');
    this.Healed = new Signal('Health.Healed');
    this.ArmorBroken = new Signal('Health.ArmorBroken');
    this.Died = new Signal('Health.Died');
    this.Respawned = new Signal('Health.Respawned');
    this.EffectApplied = new Signal('Health.EffectApplied');
    this.EffectEnded = new Signal('Health.EffectEnded');
  }

  static create(opts) { return new Health(opts); }

  get alive() { return !this.dead; }
  get healthFraction() { return clamp01(this.health / this.maxHealth); }
  get armorFraction() { return this.maxArmor > 0 ? clamp01(this.armor / this.maxArmor) : 0; }
  get critical() { return this.alive && this.healthFraction <= 0.25; }
  get effectiveResistance() { return clamp01(this.armorFraction * this.armorAbsorption); }

  /** Applies a damage packet; returns `{applied, absorbed, killed, overkill, headshot}`. */
  damage(info) {
    if (this.dead || this.invulnerable || info.amount <= 0) {
      return { applied: 0, absorbed: 0, killed: false, overkill: 0, headshot: !!info.headshot, blocked: true };
    }
    if (this.spawnProtection > 0) {
      return { applied: 0, absorbed: 0, killed: false, overkill: 0, headshot: !!info.headshot, blocked: true, spawnProtected: true };
    }
    let incoming = info.amount;
    let absorbed = 0;
    if (this.armor > 0 && info.type !== 'fall') {
      // Armour eats a share of the damage; armour-piercing rounds shift that share away.
      const piercing = clamp01(info.armorPiercing ?? 0);
      const share = clamp01(this.armorAbsorption * (1 - piercing * this.armorPiercingScale));
      const armorDamage = Math.min(this.armor, incoming * share);
      absorbed = armorDamage;
      this.armor -= armorDamage;
      incoming -= armorDamage;
      if (this.armor <= 0 && absorbed > 0) this.ArmorBroken.emit(this);
    }
    const applied = Math.min(this.health, incoming);
    this.health -= applied;
    const overkill = Math.max(0, incoming - applied);
    this.damageTaken += applied + absorbed;
    this.lastDamageTime = this.time;
    this.lastDamageAmount = applied + absorbed;
    this.lastAttacker = info.attacker ?? this.lastAttacker;
    this.lastWeapon = info.weapon ?? info.inflictor ?? this.lastWeapon;
    this.hitFlash = Math.min(1, this.hitFlash + clamp01((applied + absorbed) / Math.max(20, this.maxHealth * 0.6)));
    if (info.direction) this.lastDamageDirection.copy(info.direction).negate();
    if (info.point) this.lastDamagePoint.copy(info.point);

    const result = { applied, absorbed, killed: false, overkill, headshot: !!info.headshot };
    this.Damaged.emit({ health: this, info, ...result });
    if (this.health <= 0) {
      this.health = 0;
      result.killed = true;
      this.die(info);
    }
    return result;
  }

  /** Convenience wrapper for direct calls (`health.damage(25)` style). */
  applyDamage(amountOrInfo) {
    if (typeof amountOrInfo === 'number') return this.damage({ amount: amountOrInfo });
    return this.damage(amountOrInfo);
  }

  heal(amount, { source = null, revive = false } = {}) {
    if (this.dead && !revive) return 0;
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + amount);
    const healed = this.health - before;
    if (healed > 0) this.Healed.emit({ health: this, amount: healed, source });
    return healed;
  }

  addArmor(amount) {
    const before = this.armor;
    this.armor = Math.min(this.maxArmor || amount, this.armor + amount);
    if (this.maxArmor < this.armor) this.maxArmor = this.armor;
    return this.armor - before;
  }

  /** Applies (or refreshes) a status effect. */
  applyEffect(kind, { duration = 3, dps = 0, source = null, data = null } = {}) {
    const existing = this.effects.get(kind);
    if (existing) {
      existing.remaining = Math.max(existing.remaining, duration);
      existing.dps = Math.max(existing.dps, dps);
      return existing;
    }
    const effect = { kind, remaining: duration, dps, source, data, tick: 0 };
    this.effects.set(kind, effect);
    this.EffectApplied.emit({ health: this, effect });
    return effect;
  }

  hasEffect(kind) { return this.effects.has(kind); }
  getEffect(kind) { return this.effects.get(kind) ?? null; }
  clearEffects() { this.effects.clear(); return this; }

  /** Kills the owner with attribution. */
  die(info = {}) {
    if (this.dead) return this;
    this.dead = true;
    this.deaths++;
    this.health = 0;
    this.effects.clear();
    this.respawnTimer = this.respawnDelay;
    this.deadInfo = {
      killer: info.attacker ?? null,
      weapon: info.weapon ?? null,
      headshot: !!info.headshot,
      type: info.type ?? 'bullet',
      distance: info.distance ?? 0,
      penetrated: info.penetrated ?? 0,
      time: this.time,
      direction: this.lastDamageDirection.clone(),
      point: (info.point ?? this.lastDamagePoint).clone?.() ?? new Vector3(),
    };
    this.Died.emit({ health: this, info, info2: this.deadInfo });
    if (this.lastAttacker?.health) this.lastAttacker.health.kills++;
    return this;
  }

  /** Revives (respawn or defibrillator) and clears combat state. */
  revive({ health = null, armor = null, spawnProtection = 2 } = {}) {
    this.dead = false;
    this.health = health ?? this.maxHealth;
    this.armor = armor ?? this.maxArmor;
    this.respawnTimer = 0;
    this.invulnerable = false;
    this.spawnProtection = spawnProtection;
    this.hitFlash = 0;
    this.effects.clear();
    this.Respawned.emit({ health: this });
    return this;
  }

  update(dt) {
    this.time += dt;
    if (this.spawnProtection > 0) this.spawnProtection = Math.max(0, this.spawnProtection - dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt * 1.4);
    this.healthBlend += (this.healthFraction - this.healthBlend) * Math.min(1, dt * 6);

    if (this.dead) {
      if (this.respawnTimer > 0) this.respawnTimer = Math.max(0, this.respawnTimer - dt);
      return this;
    }

    // Damage over time.
    if (this.effects.size > 0) {
      for (const [kind, effect] of [...this.effects]) {
        effect.remaining -= dt;
        if (effect.dps > 0) {
          effect.tick += dt;
          if (effect.tick >= 0.5) {
            const seconds = effect.tick;
            effect.tick = 0;
            this.damage({
              amount: effect.dps * seconds,
              type: kind === StatusEffect.Burning ? 'fire' : 'gas',
              attacker: effect.source,
              point: this.owner?.position?.clone() ?? new Vector3(),
              direction: new Vector3(0, 1, 0),
            });
            if (this.dead) return this;
          }
        }
        if (effect.remaining <= 0) {
          this.effects.delete(kind);
          this.EffectEnded.emit({ health: this, effect });
        }
      }
    }

    // Regeneration.
    if (this.regenerating && this.maxHealth > 0) {
      const since = this.time - this.lastDamageTime;
      if (since > this.regenDelay && this.health < this.maxHealth * this.regenCap) {
        this.heal(this.regenRate * dt, { source: 'regen' });
      }
    }
    return this;
  }

  getState() {
    return {
      health: this.health,
      maxHealth: this.maxHealth,
      armor: this.armor,
      maxArmor: this.maxArmor,
      dead: this.dead,
      respawnTimer: this.respawnTimer,
      hitFlash: this.hitFlash,
      effects: [...this.effects.keys()],
      lastDamageDirection: this.lastDamageDirection,
      lastAttacker: this.lastAttacker?.displayName ?? null,
    };
  }

  serialize() {
    return { h: Math.round(this.health * 10) / 10, a: Math.round(this.armor * 10) / 10, d: this.dead ? 1 : 0, t: Math.round(this.respawnTimer * 100) / 100 };
  }
}

void clamp;

export default Health;
