/**
 * OminX Engine — FPS heads-up display.
 *
 * Two layers, because they have different update costs:
 *  · a **2D canvas** for everything that moves every frame — dynamic crosshair, hit markers,
 *    directional damage arcs, flash blindness, reload ring, damage numbers and the minimap;
 *  · **DOM** for text panels that change rarely — health/ammo, kill feed, scoreboard, objective
 *    banner, notices, the pause menu and the end-of-match card (styled by `src/styles.css`).
 *
 * The HUD never touches the 3D renderer's state, so it can be scaled, hidden or swapped (spectator
 * view, editor preview) without disturbing a frame.
 *
 * @module src/game/HUD
 */
import { Vector3 } from '../../engine/src/math/Vector3.js';
import { clamp, clamp01, DEG2RAD } from '../../engine/src/math/MathUtils.js';
import { createLogger } from '../../engine/src/core/Logger.js';

const log = createLogger('HUD');

const TEAM_COLORS = { red: '#ff5a52', blue: '#57b6ff', neutral: '#d8dee9' };

export class HUD {
  /**
   * @param {object} [opts]
   * @param {HTMLCanvasElement} [opts.canvas] overlay 2D canvas (created if omitted)
   * @param {HTMLElement} [opts.root] DOM container for the text panels
   */
  constructor(opts = {}) {
    this.settings = { ...(opts.settings ?? {}) };
    this.audio = opts.audio ?? null;
    this.renderer = opts.renderer ?? null;
    this.session = null;
    this.canvas = opts.canvas ?? null;
    this.ctx = null;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.time = 0;
    this.visible = true;
    this.notices = [];
    this.damageNumbers = [];
    this.killFeed = [];
    this.matchOver = null;
    this.scoreboardVisible = false;
    this.minimapVisible = true;
    this.roots = {};
    this._lastPanelState = {};
    this._bindOverlay(opts.root ?? null);
  }

  // ------------------------------------------------------------------ setup
  _bindOverlay(root) {
    if (typeof document === 'undefined') return;
    this.root = root ?? document.getElementById('hud-root') ?? null;
    if (!this.canvas) {
      this.canvas = document.getElementById('hud-canvas') ?? null;
      if (!this.canvas) {
        this.canvas = document.createElement('canvas');
        this.canvas.id = 'hud-canvas';
        this.canvas.className = 'hud-canvas';
        (this.root?.parentElement ?? document.body).appendChild(this.canvas);
      }
    }
    this.ctx = this.canvas?.getContext?.('2d') ?? null;
    if (this.ctx) this.resize(this.canvas.width || 1280, this.canvas.height || 720);
    this._buildPanels();
  }

  /** Creates the DOM panels once; afterwards only their text content changes. */
  _buildPanels() {
    if (typeof document === 'undefined' || !this.root) return;
    const make = (id, className, html = '') => {
      let node = this.root.querySelector(`#${id}`);
      if (!node) {
        node = document.createElement('div');
        node.id = id;
        node.className = className;
        node.innerHTML = html;
        this.root.appendChild(node);
      }
      return node;
    };
    this.roots.killFeed = make('hud-killfeed', 'hud-killfeed');
    this.roots.notice = make('hud-notice', 'hud-notice', '<span class="notice-text"></span><span class="notice-sub"></span>');
    this.roots.objective = make('hud-objective', 'hud-objective');
    this.roots.status = make('hud-status', 'hud-status', `
      <div class="status-bars">
        <div class="bar bar-health"><span class="bar-label">HP</span><span class="bar-fill"></span><span class="bar-value">100</span></div>
        <div class="bar bar-armor"><span class="bar-label">ARM</span><span class="bar-fill"></span><span class="bar-value">0</span></div>
      </div>`);
    this.roots.weapon = make('hud-weapon', 'hud-weapon', `
      <div class="weapon-name">—</div>
      <div class="weapon-ammo"><span class="ammo-mag">0</span><span class="ammo-sep">/</span><span class="ammo-reserve">0</span></div>
      <div class="weapon-meta"><span class="weapon-mode">auto</span><span class="weapon-attachments"></span></div>
      <div class="weapon-grenades"></div>`);
    this.roots.teamScore = make('hud-teamscore', 'hud-teamscore', `
      <div class="team team-red"><span class="team-name">Red</span><span class="team-score">0</span></div>
      <div class="match-clock">0:00</div>
      <div class="team team-blue"><span class="team-score">0</span><span class="team-name">Blue</span></div>`);
    this.roots.scoreboard = make('hud-scoreboard', 'hud-scoreboard', '<div class="scoreboard-inner"></div>');
    this.roots.stats = make('hud-stats', 'hud-stats');
    this.roots.respawn = make('hud-respawn', 'hud-respawn', '<div class="respawn-title">YOU DIED</div><div class="respawn-sub">Press <kbd>Space</kbd> or click to respawn</div><div class="respawn-timer"></div>');
    this.roots.matchOver = make('hud-matchover', 'hud-matchover', '<div class="card"></div>');
    this.roots.chat = make('hud-chat', 'hud-chat');
  }

  resize(width, height) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    if (this.canvas) {
      this.dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio ?? 1) : 1;
      this.canvas.width = Math.floor(this.width * this.dpr);
      this.canvas.height = Math.floor(this.height * this.dpr);
      if (this.canvas.style) {
        this.canvas.style.width = `${this.width}px`;
        this.canvas.style.height = `${this.height}px`;
      }
      this.ctx?.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    return this;
  }

  applySettings(settings) {
    Object.assign(this.settings, settings);
    if (this.roots.stats) this.roots.stats.style.display = this.settings.showFps ? '' : 'none';
    return this;
  }

  setSession(session) {
    this.session = session;
    this.matchOver = null;
    if (this.roots.matchOver) this.roots.matchOver.classList.remove('visible');
    if (this.roots.respawn) this.roots.respawn.classList.remove('visible');
    return this;
  }

  setVisible(visible) {
    this.visible = !!visible;
    if (this.canvas?.style) this.canvas.style.display = this.visible ? '' : 'none';
    if (this.root?.classList) this.root.classList.toggle('hud-hidden', !this.visible);
    return this;
  }

  // ------------------------------------------------------------------ events
  notice(text, sub = '', duration = 2.4) {
    this.notices.push({ text, sub, time: 0, duration });
    if (this.notices.length > 3) this.notices.shift();
    log.debug(text);
  }

  /** Called for every bullet that hits *anyone*; the HUD decides what the local player should see. */
  onHit(event) {
    const local = this.session?.localPlayer;
    if (!local) return;
    if (event?.attacker === local && event?.actor && event.actor !== local) {
      this.hitmarker = { time: 0, duration: 0.32, kill: !!event.killed, headshot: !!event.headshot, armour: false };
      if (this.settings.damageNumbers && event.point) {
        this.damageNumbers.push({
          position: event.point.clone ? event.point.clone() : new Vector3(event.point.x, event.point.y, event.point.z),
          amount: Math.round(event.damage ?? event.info?.damage ?? 0),
          headshot: !!event.headshot,
          time: 0,
        });
        if (this.damageNumbers.length > 24) this.damageNumbers.shift();
      }
      if (event.killed) this.audio?.playHitmarker?.('kill');
      else if (this.settings.hitmarkers) this.audio?.playHitmarker?.(event.headshot ? 'headshot' : 'hit');
    }
    if (event?.actor === local) {
      this.damageTakenFlash = { time: 0, duration: 0.5, amount: clamp01((event.damage ?? 20) / 60) };
    }
  }

  /** Damage applied to the local player (ballistics `onDamage` hook) → directional indicator. */
  onDamage(info, localPlayer) {
    if (!info || !localPlayer) return;
    if (info.target && info.target !== localPlayer) return;
    const direction = info.direction ? { x: -info.direction.x, z: -info.direction.z } : null;
    const local = localPlayer.getForward ? localPlayer.getForward(new Vector3()) : new Vector3(0, 0, -1);
    let angle = 0;
    if (direction) {
      const dot = local.x * direction.x + local.z * direction.z;
      const cross = local.x * direction.z - local.z * direction.x;
      angle = Math.atan2(cross, dot);
    }
    this.damageArcs = this.damageArcs ?? [];
    this.damageArcs.push({ angle, time: 0, duration: 1.6, strength: clamp01((info.damage ?? 20) / 40) });
    if (this.damageArcs.length > 6) this.damageArcs.shift();
  }

  onKill(event, localPlayer) {
    void localPlayer;
    if (event?.killer && this.killFeedCanShow(event)) {
      this.killFeed.push({ ...event, age: 0 });
      if (this.killFeed.length > 6) this.killFeed.shift();
    }
  }

  killFeedCanShow(event) {
    const local = this.session?.localPlayer;
    if (!local) return true;
    return event.killer?.team === local.team || event.victim?.team === local.team || event.killer === local || event.victim === local;
  }

  setMatchOver(info) {
    this.matchOver = info;
    if (!this.roots.matchOver) return;
    const winnerName = info.winner ? `${cap(info.winner)} team` : 'Draw';
    const local = this.session?.localPlayer;
    const won = local && info.winner === local.team;
    this.roots.matchOver.querySelector('.card').innerHTML = `
      <h2 class="${won ? 'win' : 'lose'}">${winnerName} wins</h2>
      <div class="score"><span class="red">${info.red.score}</span><span class="colon">:</span><span class="blue">${info.blue.score}</span></div>
      <div class="summary">
        <div>Kills <b>${local?.kills ?? 0}</b></div>
        <div>Deaths <b>${local?.deaths ?? 0}</b></div>
        <div>Score <b>${local?.score ?? 0}</b></div>
        <div>Streak <b>${local?.streak ?? 0}</b></div>
      </div>
      <p class="hint">Press <kbd>Space</kbd> to play again</p>`;
    this.roots.matchOver.classList.add('visible');
  }

  // ------------------------------------------------------------------ frame
  update(dt, engine) {
    this.time += dt;
    const session = this.session ?? engine?.session ?? null;
    this.session = session;
    const player = session?.localPlayer ?? engine?.player ?? null;
    this.localPlayer = player;
    const camera = engine?.camera ?? null;
    this.camera = camera;

    for (const notice of this.notices) notice.time += dt;
    while (this.notices.length && this.notices[0].time > this.notices[0].duration) this.notices.shift();
    for (const number of this.damageNumbers) number.time += dt;
    while (this.damageNumbers.length && this.damageNumbers[0].time > 1.1) this.damageNumbers.shift();
    for (const arc of this.damageArcs ?? []) arc.time += dt;
    this.damageArcs = (this.damageArcs ?? []).filter((arc) => arc.time < arc.duration);
    if (this.hitmarker) {
      this.hitmarker.time += dt;
      if (this.hitmarker.time > this.hitmarker.duration) this.hitmarker = null;
    }
    for (const entry of this.killFeed) entry.age += dt;
    this.killFeed = this.killFeed.filter((entry) => entry.age < 8);

    this._draw(player, camera, engine);
    this._updatePanels(player, session, engine);
  }

  _draw(player, camera, engine) {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.visible || !player) return;
    const hud = player.getHudState ? player.getHudState() : null;
    if (!hud) return;

    this._drawDamageOverlay(ctx, hud);
    if (hud.alive) {
      this._drawCrosshair(ctx, hud, player);
      this._drawHitmarker(ctx, hud);
      this._drawGrenades(ctx, hud);
      if (this.settings.showNetGraph) this._drawNetGraph(ctx, engine);
    } else if (hud.state === 'dead' && this.roots.respawn) {
      this.roots.respawn.classList.add('visible');
      const remaining = Math.max(0, hud.respawnTimer ?? 0);
      this.roots.respawn.querySelector('.respawn-timer').textContent = remaining > 0 ? `${remaining.toFixed(1)}s` : '';
    } else if (this.roots.respawn) {
      this.roots.respawn.classList.remove('visible');
    }
    if (hud.alive && this.roots.respawn) this.roots.respawn.classList.remove('visible');
    this._drawDamageNumbers(ctx, camera);
    if (this.minimapVisible && this.settings.showMinimap !== false) this._drawMinimap(ctx, player, engine);
  }

  _drawDamageOverlay(ctx, hud) {
    const { width, height } = this;
    // Directional damage arcs.
    for (const arc of this.damageArcs ?? []) {
      const t = arc.time / arc.duration;
      const alpha = (1 - t) * 0.75 * arc.strength;
      const radius = Math.min(width, height) * 0.22;
      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.rotate(arc.angle + Math.PI / 2);
      ctx.beginPath();
      ctx.arc(0, 0, radius, -Math.PI * 0.5 - 0.42, -Math.PI * 0.5 + 0.42);
      ctx.strokeStyle = `rgba(255, 64, 48, ${alpha})`;
      ctx.lineWidth = Math.max(4, height * 0.012);
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.restore();
    }
    // Health-based screen pulse + low-health vignette.
    if (hud.healthFraction < 0.35) {
      const pulse = 0.25 + Math.sin(this.time * 6) * 0.08;
      const gradient = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.25, width / 2, height / 2, Math.max(width, height) * 0.62);
      gradient.addColorStop(0, 'rgba(120,0,0,0)');
      gradient.addColorStop(1, `rgba(150,8,8,${pulse * (1 - hud.healthFraction / 0.35) * 0.9})`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }
    // Hit direction flash + blood splatter.
    if (this.damageTakenFlash) {
      this.damageTakenFlash.time += 1 / 60;
      const t = this.damageTakenFlash.time / this.damageTakenFlash.duration;
      if (t < 1) {
        ctx.fillStyle = `rgba(148, 12, 12, ${(1 - t) * 0.28 * this.damageTakenFlash.amount})`;
        ctx.fillRect(0, 0, width, height);
      } else {
        this.damageTakenFlash = null;
      }
    }
    // Flashbang / stun blindness.
    if (hud.flashIntensity > 0.02) {
      ctx.fillStyle = `rgba(255,255,255,${clamp01(hud.flashIntensity)})`;
      ctx.fillRect(0, 0, width, height);
    }
    // Scope overlay.
    if (hud.scoped) {
      ctx.fillStyle = 'rgba(0,0,0,0.92)';
      ctx.fillRect(0, 0, width, height);
      const r = Math.min(width, height) * 0.42;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = 'rgba(10,10,10,0.9)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(width / 2 - r, height / 2);
      ctx.lineTo(width / 2 + r, height / 2);
      ctx.moveTo(width / 2, height / 2 - r);
      ctx.lineTo(width / 2, height / 2 + r);
      ctx.strokeStyle = 'rgba(20,20,20,0.75)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  _drawCrosshair(ctx, hud, player) {
    const { width, height } = this;
    const style = this.settings.crosshairStyle ?? 'dynamic';
    const cx = width / 2;
    const cy = height / 2;
    const gap = style === 'dynamic' ? clamp(hud.crosshairRadius, 2, 90) : 6;
    const length = 8 + gap * 0.08;
    const thickness = hud.adsBlend > 0.7 ? 1.5 : 2;
    const alpha = hud.adsBlend > 0.9 && hud.scoped ? 0 : 0.92;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = hud.weapon && hud.ammo && hud.ammo.magazine === 0 ? 'rgba(255,90,70,0.95)' : 'rgba(235,255,240,0.92)';
    ctx.lineWidth = thickness;
    ctx.lineCap = 'round';
    ctx.beginPath();
    // four ticks
    ctx.moveTo(cx - gap - length, cy); ctx.lineTo(cx - gap, cy);
    ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + gap + length, cy);
    ctx.moveTo(cx, cy - gap - length); ctx.lineTo(cx, cy - gap);
    ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + gap + length);
    if (style === 'cross' || style === 'dynamic') {
      ctx.moveTo(cx - 2, cy); ctx.lineTo(cx + 2, cy);
      ctx.moveTo(cx, cy - 2); ctx.lineTo(cx, cy + 2);
    }
    ctx.stroke();
    // Hit direction tick (the classic "X" when you are being shot at).
    if (hud.damageDirection) {
      const angle = Math.atan2(-hud.damageDirection.z ?? 0, hud.damageDirection.x ?? 0);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.strokeStyle = 'rgba(255,70,60,0.75)';
      ctx.beginPath();
      ctx.moveTo(0, -gap - 12);
      ctx.lineTo(0, -gap - 4);
      ctx.stroke();
      ctx.restore();
    }
    // Suppression ring: bullets cracking overhead compress the reticle.
    if (hud.suppression > 0.05) {
      ctx.strokeStyle = `rgba(255,210,120,${0.35 * clamp01(hud.suppression)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, gap + 22, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
    void player;
  }

  _drawHitmarker(ctx, hud) {
    const marker = this.hitmarker;
    if (!marker || !this.settings.hitmarkers) return;
    const t = marker.time / marker.duration;
    const alpha = 1 - t;
    const size = 7 + t * 7;
    const color = marker.kill ? '255,80,70' : marker.headshot ? '255,205,90' : '255,255,255';
    ctx.save();
    ctx.translate(this.width / 2, this.height / 2);
    ctx.rotate(Math.PI / 4);
    ctx.strokeStyle = `rgba(${color},${alpha})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-size, -size); ctx.lineTo(-size * 0.4, -size * 0.4);
    ctx.moveTo(size, -size); ctx.lineTo(size * 0.4, -size * 0.4);
    ctx.moveTo(-size, size); ctx.lineTo(-size * 0.4, size * 0.4);
    ctx.moveTo(size, size); ctx.lineTo(size * 0.4, size * 0.4);
    ctx.stroke();
    ctx.restore();
  }

  _drawGrenades(ctx, hud) {
    const grenades = Object.entries(hud.grenades ?? {}).filter(([, count]) => count > 0);
    if (!grenades.length) return;
    ctx.save();
    ctx.font = `${Math.round(12 * (this.settings.hudScale ?? 1))}px ui-monospace, monospace`;
    ctx.fillStyle = 'rgba(220,230,240,0.85)';
    ctx.textAlign = 'right';
    let y = this.height - 96;
    for (const [kind, count] of grenades) {
      ctx.fillText(`${kind.toUpperCase()} ×${count}`, this.width - 36, y);
      y -= 16;
    }
    ctx.restore();
  }

  _drawDamageNumbers(ctx, camera) {
    if (!camera || !this.settings.damageNumbers) return;
    ctx.save();
    ctx.textAlign = 'center';
    for (const number of this.damageNumbers) {
      const screen = camera.worldToScreen(number.position, { x: 0, y: 0, visible: false });
      if (!screen.visible) continue;
      const t = number.time / 1.1;
      const alpha = 1 - t * t;
      const rise = t * 34;
      const scale = number.headshot ? 1.35 : 1;
      ctx.font = `bold ${Math.round(15 * scale * (this.settings.hudScale ?? 1))}px ui-monospace, monospace`;
      ctx.fillStyle = number.headshot ? `rgba(255,205,90,${alpha})` : `rgba(255,255,255,${alpha})`;
      ctx.strokeStyle = `rgba(0,0,0,${alpha * 0.7})`;
      ctx.lineWidth = 3;
      const text = number.headshot ? `${number.amount}!` : `${number.amount}`;
      ctx.strokeText(text, screen.x, screen.y - rise);
      ctx.fillText(text, screen.x, screen.y - rise);
    }
    ctx.restore();
  }

  _drawMinimap(ctx, player, engine) {
    const session = this.session;
    const size = Math.round(148 * (this.settings.hudScale ?? 1));
    const margin = 18;
    const x = this.width - size - margin;
    const y = margin;
    const scale = size / 120; // 120 m across
    const center = player.character?.position ?? new Vector3();
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = 'rgba(8,12,16,0.55)';
    ctx.strokeStyle = 'rgba(140,180,210,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect?.(x, y, size, size, 8);
    if (!ctx.roundRect) ctx.rect(x, y, size, size);
    ctx.fill();
    ctx.stroke();
    ctx.clip();
    const project = (position) => ({
      x: x + size / 2 + (position.x - center.x) * scale,
      y: y + size / 2 + (position.z - center.z) * scale,
    });
    // Objectives
    for (const objective of session?.objectives ?? []) {
      const point = project(objective.position);
      ctx.fillStyle = objective.owner === 'neutral' ? 'rgba(220,220,220,0.7)' : TEAM_COLORS[objective.owner] ?? '#fff';
      ctx.beginPath();
      ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(objective.label.slice(0, 2), point.x, point.y + 3);
    }
    // Teammates + visible enemies (bots only reveal themselves when an ally sees them, like a real
    // minimap: sound contacts appear as a ring).
    for (const actor of engine?.actors ?? []) {
      if (actor === player) continue;
      const position = actor.character?.position;
      if (!position) continue;
      const point = project(position);
      const friendly = actor.team === player.team;
      if (!friendly) {
        const spotted = session?.aliveActors?.(player.team)?.some?.((ally) => ally.visibleTargets?.includes?.(actor));
        if (!spotted) continue;
      }
      ctx.fillStyle = friendly ? 'rgba(90,180,255,0.95)' : 'rgba(255,90,80,0.95)';
      ctx.beginPath();
      ctx.arc(point.x, point.y, friendly ? 3 : 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // Local player: arrow pointing along yaw.
    const self = project(center);
    ctx.translate(self.x, self.y);
    ctx.rotate(-(player.yaw ?? 0));
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4, 5);
    ctx.lineTo(0, 2.5);
    ctx.lineTo(-4, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = 'rgba(140,180,210,0.25)';
    ctx.strokeRect(x, y, size, size);
    ctx.restore();
  }

  _drawNetGraph(ctx, engine) {
    const net = engine?.net;
    if (!net) return;
    const width = 180;
    const height = 54;
    const x = this.width - width - 18;
    const y = this.height - height - 18;
    ctx.save();
    ctx.fillStyle = 'rgba(6,10,14,0.6)';
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = 'rgba(120,200,255,0.5)';
    ctx.strokeRect(x, y, width, height);
    ctx.fillStyle = 'rgba(180,230,255,0.9)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(`ping ${Math.round(net.ping ?? 0)}ms  loss ${(net.loss ?? 0).toFixed(1)}%`, x + 6, y + 14);
    ctx.fillText(`in ${(net.bytesIn / 1024 || 0).toFixed(1)}kB/s  out ${(net.bytesOut / 1024 || 0).toFixed(1)}kB/s`, x + 6, y + 28);
    ctx.fillText(`tick ${net.serverTick ?? 0}  ${net.state ?? 'offline'}`, x + 6, y + 42);
    ctx.restore();
  }

  // ------------------------------------------------------------------ DOM panels
  _updatePanels(player, session, engine) {
    const roots = this.roots;
    if (!roots.status) return;
    const hud = player?.getHudState?.() ?? null;
    if (hud) {
      const scale = this.settings.hudScale ?? 1;
      if (roots.status.style) roots.status.style.transform = `scale(${scale})`;
      setText(roots.status, '.bar-health .bar-value', Math.max(0, Math.round(hud.health)));
      setWidth(roots.status, '.bar-health .bar-fill', hud.healthFraction);
      setText(roots.status, '.bar-armor .bar-value', Math.round(hud.armor ?? 0));
      setWidth(roots.status, '.bar-armor .bar-fill', (hud.armor ?? 0) / Math.max(1, hud.maxArmor || 100));
      roots.status.classList.toggle('critical', hud.healthFraction < 0.3);

      setText(roots.weapon, '.weapon-name', hud.weapon?.name ?? 'Unarmed');
      setText(roots.weapon, '.ammo-mag', hud.ammo?.magazine ?? 0);
      setText(roots.weapon, '.ammo-reserve', hud.ammo?.reserve ?? 0);
      setText(roots.weapon, '.weapon-mode', (hud.weapon?.fireMode ?? 'auto').toUpperCase());
      setText(roots.weapon, '.weapon-attachments', (hud.weapon?.attachments ?? []).length ? `${hud.weapon.attachments.length} att` : '');
      const grenadeList = Object.entries(hud.grenades ?? {}).filter(([, count]) => count > 0).map(([kind, count]) => `${kind}×${count}`).join('  ');
      setText(roots.weapon, '.weapon-grenades', grenadeList);
      roots.weapon.classList.toggle('reloading', !!hud.reloading);
      const progress = hud.reloading ? clamp01(hud.reloadProgress) : 0;
      if (roots.weapon.style) roots.weapon.style.setProperty('--reload', `${(progress * 100).toFixed(0)}%`);

      const reloadRing = hud.reloading ? `reloading ${Math.round(hud.reloadProgress * 100)}%` : '';
      setText(roots.status, '.reload-hint', reloadRing);
      const spread = hud.spread ? `${(hud.spread * 57.2958).toFixed(2)}°` : '';
      setText(roots.weapon, '.weapon-spread', spread);
    }

    if (session) {
      setText(roots.teamScore, '.team-red .team-score', session.teams.red.score);
      setText(roots.teamScore, '.team-blue .team-score', session.teams.blue.score);
      setText(roots.teamScore, '.match-clock', formatClock(session.matchTime));
      const objective = session.objectives?.[0];
      if (objective) {
        roots.objective.classList.add('visible');
        roots.objective.innerHTML = session.objectives.map((o) => `
          <span class="objective-chip owner-${o.owner}">
            <b>${o.label}</b>
            <i style="width:${Math.round(clamp01(o.progress) * 100)}%"></i>
          </span>`).join('');
      } else if (roots.objective) {
        roots.objective.classList.remove('visible');
      }
      if (this.scoreboardVisible) roots.scoreboard.classList.add('visible');
      else roots.scoreboard.classList.remove('visible');
      this._renderScoreboard(session);
    }

    if (roots.killFeed) {
      const html = this.killFeed.map((entry) => {
        const killer = entry.killer ? `<span class="killer team-${entry.killer.team}">${escapeHtml(entry.killer.name)}</span>` : '<span class="world">WORLD</span>';
        const victim = `<span class="victim team-${entry.victim.team}">${escapeHtml(entry.victim.name)}</span>`;
        const tags = [entry.headshot ? 'HS' : null, entry.wallbang ? 'WB' : null, entry.distance > 45 ? `${entry.distance}m` : null].filter(Boolean).join(' ');
        const alpha = clamp01(1 - (entry.age - 6) / 2);
        return `<div class="feed-row" style="opacity:${alpha.toFixed(2)}">${killer}<span class="weapon">${escapeHtml(entry.weapon)}</span>${victim}<span class="tags">${tags}</span></div>`;
      }).join('');
      if (this._lastPanelState.killFeed !== html) {
        roots.killFeed.innerHTML = html;
        this._lastPanelState.killFeed = html;
      }
    }

    if (roots.notice) {
      const notice = this.notices[0];
      if (notice) {
        roots.notice.classList.add('visible');
        setText(roots.notice, '.notice-text', notice.text);
        setText(roots.notice, '.notice-sub', notice.sub ?? '');
      } else {
        roots.notice.classList.remove('visible');
      }
    }

    if (roots.stats) {
      const stats = engine?.stats ?? null;
      if (stats && this.settings.showFps) {
        const text = `${stats.fps} fps · ${stats.frameMs.toFixed(1)} ms · ${stats.drawCalls} draws · ${(stats.triangles / 1000).toFixed(1)}k tris · ${stats.parts} parts · ${stats.actors} actors · ${stats.backend}`;
        if (this._lastPanelState.stats !== text) {
          roots.stats.textContent = text;
          this._lastPanelState.stats = text;
        }
      }
    }

    if (roots.respawn) {
      const dead = hud && !hud.alive && hud.state === 'dead';
      roots.respawn.classList.toggle('visible', !!dead && session?.phase !== 'over');
    }
    if (roots.chat && this._chatLines) {
      const html = this._chatLines.slice(-5).map((line) => `<div class="chat-row"><span class="chat-name">${escapeHtml(line.name)}</span>${escapeHtml(line.text)}</div>`).join('');
      if (this._lastPanelState.chat !== html) {
        roots.chat.innerHTML = html;
        this._lastPanelState.chat = html;
      }
    }
  }

  _renderScoreboard(session) {
    const rows = session.getScoreboard();
    const html = `
      <div class="scoreboard-inner">
        <div class="scoreboard-head">
          <span class="sb-team sb-red">RED</span>
          <span class="sb-mode">${session.mode.toUpperCase()} · round ${session.round} · ${session.phase}</span>
          <span class="sb-team sb-blue">BLUE</span>
        </div>
        <table>
          <thead><tr><th>Player</th><th>K</th><th>D</th><th>A</th><th>Score</th><th>Ping</th></tr></thead>
          <tbody>${rows.map((row) => `<tr class="${row.isLocal ? 'local' : ''} ${row.alive ? '' : 'dead'}">
            <td class="name team-${row.team}">${row.isBot ? '<span class="bot-tag">BOT</span>' : ''}${escapeHtml(row.name)}${row.weapon ? `<span class="sb-weapon">${escapeHtml(row.weapon)}</span>` : ''}</td>
            <td>${row.kills}</td><td>${row.deaths}</td><td>${row.assists}</td><td><b>${row.score}</b></td><td>${row.ping}</td>
          </tr>`).join('')}</tbody>
        </table>
        <div class="scoreboard-foot">obj: ${session.objectives.map((o) => `${o.label}=${o.owner}`).join(' · ') || 'none'}</div>
      </div>`;
    if (this._lastPanelState.scoreboard !== html) {
      this.roots.scoreboard.innerHTML = html;
      this._lastPanelState.scoreboard = html;
    }
  }

  /** Chat lines are pushed by the network client (or the local console). */
  pushChat(name, text, team = 'all') {
    this._chatLines ??= [];
    this._chatLines.push({ name: team === 'team' ? `[T] ${name}` : name, text, time: this.time });
    if (this._chatLines.length > 40) this._chatLines.shift();
    return this;
  }

  setScoreboardVisible(visible) {
    this.scoreboardVisible = !!visible;
    return this;
  }

  destroy() {
    this.killFeed.length = 0;
    this.damageNumbers.length = 0;
    this.ctx?.clearRect?.(0, 0, this.width, this.height);
  }
}

function setText(root, selector, value) {
  const node = root?.querySelector?.(selector);
  if (!node) return;
  const text = String(value);
  if (node.textContent !== text) node.textContent = text;
}

function setWidth(root, selector, fraction) {
  const node = root?.querySelector?.(selector);
  if (!node || !node.style) return;
  const percent = `${(clamp01(fraction) * 100).toFixed(1)}%`;
  if (node.style.width !== percent) node.style.width = percent;
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function cap(text) { return String(text).charAt(0).toUpperCase() + String(text).slice(1); }

export { TEAM_COLORS, DEG2RAD };
export default HUD;
