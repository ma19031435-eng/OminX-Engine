/**
 * OminX Engine — replays.
 *
 * A replay is the cheapest debugging tool a shooter can have: record what the player did, run the
 * same simulation again, and the bug happens on demand instead of once every forty matches. It is
 * also what makes "was it a hit?" answerable after the fact, and what a spectator client is built
 * on.
 *
 * The hard part is not storing input — it is *fidelity*. So the recorder stores what the simulation
 * consumes, at the rate the simulation consumes it:
 *
 *   - **Action frames** (`mode: 'actions'`, default) record the resolved action values
 *     (`Move`, `Look`, `Fire`, …) once per fixed tick. Compact, and insensitive to key-mapping
 *     changes — the right choice for playback and for diagnosing gameplay.
 *   - **Key frames** (`mode: 'keys'`) record raw key values instead, so a replay survives rebinding
 *     and can be re-resolved through a different input context (what an input bug actually needs).
 *   - **State samples** (`sampleEvery`) store an optional checksum/state blob, which is what turns
 *     "the replay looks different" into "the replay diverged at tick 412" — deterministic
 *     verification, not eyeballing.
 *
 * Playback drives an `InputMappingSystem` by tick, so the simulation sees exactly the same inputs
 * through exactly the same code path as the live client. It supports speed, pause, single-stepping
 * and seeking (using the periodic snapshots), and a duration/memory budget keeps a long session
 * bounded.
 *
 * @module engine/src/core/Replay
 */
import { MulticastDelegate } from './Delegate.js';
import { createLogger } from './Logger.js';
import { ArchiveWriter, ArchiveReader, PayloadKind, defineStruct } from './Archive.js';

const log = createLogger('Replay');

export const ReplayState = {
  Idle: 'idle',
  Recording: 'recording',
  Loaded: 'loaded',
  Playing: 'playing',
  Paused: 'paused',
  Finished: 'finished',
};

export const replayEvents = {
  onRecordingStarted: new MulticastDelegate('replay.onRecordingStarted'),
  onRecordingStopped: new MulticastDelegate('replay.onRecordingStopped'),
  onFrameRecorded: new MulticastDelegate('replay.onFrameRecorded'),
  onPlaybackStarted: new MulticastDelegate('replay.onPlaybackStarted'),
  onPlaybackTick: new MulticastDelegate('replay.onPlaybackTick'),
  onPlaybackFinished: new MulticastDelegate('replay.onPlaybackFinished'),
  onDivergence: new MulticastDelegate('replay.onDivergence'),
};

/** One recorded tick: the inputs the simulation consumed, plus optional verification data. */
export class ReplayFrame {
  constructor(tick, { actions = null, keys = null, triggers = null, checksum = 0, state = null, deltaSeconds = 0 } = {}) {
    this.tick = tick;
    this.actions = actions;
    this.keys = keys;
    /** Actions whose trigger fired on this tick — playback has to reproduce `wasTriggered()`. */
    this.triggers = triggers;
    this.checksum = checksum;
    this.state = state;
    this.deltaSeconds = deltaSeconds;
  }

  get isEmpty() { return !this.actions && !this.keys; }
}

/** A recording: header, frames, snapshots and the metadata a browser or a bug tracker needs. */
export class Replay {
  constructor({ name = 'Replay', tickRate = 60, mode = 'actions', recordedAt = null, metadata = {} } = {}) {
    this.version = 2;
    this.name = name;
    this.tickRate = tickRate;
    this.mode = mode;
    this.recordedAt = recordedAt ?? new Date().toISOString();
    this.metadata = { ...metadata };
    /** @type {ReplayFrame[]} */
    this.frames = [];
    /** Periodic full-state keys for seeking: `{ tick, frameIndex, state }`. */
    this.snapshots = [];
    /** Per-tick input vocabulary so frames can store small arrays instead of objects. */
    this.channels = [];
    this.checksumFunction = null;
    this.duration = 0;
  }

  get frameCount() { return this.frames.length; }
  get lastTick() { return this.frames.length ? this.frames[this.frames.length - 1].tick : 0; }
  get seconds() { return this.frameCount / Math.max(1, this.tickRate); }
  get empty() { return this.frames.length === 0; }

  get state() { return this._state ?? ReplayState.Idle; }
  set state(value) { this._state = value; }

  /** Compactness report: bytes per frame, which decides whether a 20-minute replay fits. */
  describe() {
    return {
      name: this.name, mode: this.mode, version: this.version, tickRate: this.tickRate,
      frames: this.frameCount, ticks: this.lastTick, seconds: round3(this.seconds),
      channels: this.channels.length, snapshots: this.snapshots.length, recordedAt: this.recordedAt,
      bytesPerFrame: round3(estimateBytes(this.frames) / Math.max(1, this.frameCount)),
      metadata: this.metadata,
    };
  }
}

/**
 * Records inputs tick by tick. Attach it to an engine and it samples every fixed step; the buffer is
 * bounded (`maxFrames`), so a session that forgets to stop cannot exhaust memory.
 */
export class ReplayRecorder {
  constructor({ engine = null, name = 'Replay', mode = 'actions', maxFrames = 60 * 60 * 10, sampleEvery = 60, checksum = null, metadata = {} } = {}) {
    this.engine = engine;
    this.mode = mode;
    this.maxFrames = maxFrames;
    this.sampleEvery = Math.max(0, sampleEvery);
    this.checksum = checksum;
    this.replay = new Replay({ name, tickRate: engine?.tickRate ?? 60, mode, metadata });
    this.state = ReplayState.Idle;
    this.tick = 0;
    this.dropped = 0;
    this._connection = null;
  }

  get recording() { return this.state === ReplayState.Recording; }

  /**
   * Starts recording from the engine's next fixed step. `sources` names the input systems to sample
   * (`engine.inputMappings` by default).
   */
  start({ name = null, metadata = null } = {}) {
    const engine = this.engine;
    if (!engine) throw new Error('ReplayRecorder needs an engine');
    if (this.recording) this.stop();
    if (name) this.replay.name = name;
    if (metadata) Object.assign(this.replay.metadata, metadata);
    this.replay.frames = [];
    this.replay.snapshots = [];
    this.replay.channels = [];
    this.replay.tickRate = engine.tickRate;
    this.replay.mode = this.mode;
    this.replay.recordedAt = new Date().toISOString();
    this.tick = 0;
    this.dropped = 0;
    this.state = ReplayState.Recording;

    // Sampling is hooked to the fixed step, so the recording is in ticks, not in frames: a replay
    // recorded at 144 Hz and played back at 30 Hz still produces identical inputs.
    this._connection = engine.scheduler.PreSimulation.connect(() => this.captureTick());
    replayEvents.onRecordingStarted.broadcast(this.replay, this);
    log.info(`recording "${this.replay.name}" (${this.mode} mode, tick ${this.tick})`);
    return this;
  }

  stop() {
    if (this._connection) { this._connection.disconnect(); this._connection = null; }
    if (this.state !== ReplayState.Recording) return this.replay;
    this.state = ReplayState.Idle;
    this.replay.duration = this.replay.seconds;
    replayEvents.onRecordingStopped.broadcast(this.replay, this);
    log.info(`recording stopped — ${this.replay.frameCount} frames, ${this.replay.seconds.toFixed(1)} s${this.dropped ? `, ${this.dropped} dropped` : ''}`);
    return this.replay;
  }

  /** Captures one tick. Called by the engine; callable directly for a scripted replay. */
  captureTick({ deltaSeconds = this.engine?.fixedDeltaTime ?? 1 / 60 } = {}) {
    if (this.state !== ReplayState.Recording) return null;
    if (this.replay.frameCount >= this.maxFrames) {
      if (this.dropped === 0) log.warn(`replay buffer full (${this.maxFrames} frames) — dropping the tail`);
      this.dropped++;
      return null;
    }
    const frame = this._sample(deltaSeconds);
    this.replay.frames.push(frame);
    if (this.sampleEvery > 0 && this.tick % this.sampleEvery === 0) {
      this.replay.snapshots.push({ tick: frame.tick, frameIndex: this.replay.frameCount - 1, checksum: frame.checksum, state: frame.state });
    }
    replayEvents.onFrameRecorded.broadcast(frame, this);
    this.tick++;
    return frame;
  }

  _sample(deltaSeconds) {
    const inputs = this.engine ? [...this.engine.inputMappings.values()] : [];
    const frame = new ReplayFrame(this.tick, { deltaSeconds });
    if (this.mode === 'keys') {
      frame.keys = {};
      for (const input of inputs) {
        for (const [key, value] of input.keyValues) if (value !== 0) frame.keys[key] = round3(value);
      }
    } else {
      frame.actions = {};
      for (const input of inputs) {
        for (const action of input.actions.values()) {
          const active = typeof action.value === 'object'
            ? (Math.abs(action.value.x ?? 0) > 1e-4 || Math.abs(action.value.y ?? 0) > 1e-4 || Math.abs(action.value.z ?? 0) > 1e-4)
            : Math.abs(action.value) > 1e-4;
          if (!active && !action.triggered) continue;
          if (typeof action.value === 'object') frame.actions[action.name] = { x: round3(action.value.x), y: round3(action.value.y), z: round3(action.value.z) };
          else frame.actions[action.name] = round3(action.value);
        }
      }
      if (!this.replay.channels.length) this.replay.channels = inputs.flatMap((input) => input.actionNames());
      const triggered = [];
      for (const input of inputs) for (const action of input.actions.values()) if (action.triggered) triggered.push(action.name);
      if (triggered.length) frame.triggers = triggered;
    }
    if (this.checksum) {
      frame.checksum = this.checksum(this.engine) >>> 0;
      frame.state = this.sampleState?.() ?? null;
    }
    return frame;
  }

  /** Optional hook a game sets to capture a verification blob at each sample point. */
  setStateSampler(fn) { this.sampleState = fn; return this; }
}

/**
 * Plays a recording back into a live engine. Playback is tick-accurate: `advance` applies the
 * recorded input for the current tick and moves on, and the host drives it from the same clock as
 * the simulation.
 */
export class ReplayPlayer {
  constructor({ engine = null, sampleRate = 1 } = {}) {
    this.engine = engine;
    this.state = ReplayState.Idle;
    this.replay = null;
    this.speed = sampleRate;
    this.cursor = 0;              // index into replay.frames
    this.ticks = 0;
    this.divergences = [];
    this._accumulator = 0;
  }

  get tick() { return this.replay?.frames[this.cursor]?.tick ?? 0; }
  get progress() { return this.replay && this.replay.frameCount ? this.cursor / this.replay.frameCount : 0; }
  get playing() { return this.state === ReplayState.Playing; }
  get finished() { return this.state === ReplayState.Finished; }

  load(replay) {
    this.replay = replay;
    this.cursor = 0;
    this.ticks = 0;
    this._accumulator = 0;
    this.divergences.length = 0;
    this.state = ReplayState.Loaded;
    return this;
  }

  play({ from = null } = {}) {
    if (!this.replay) return false;
    if (from !== null) this.seekToTick(from);
    if (this.state === ReplayState.Finished) this.cursor = 0;
    // Whatever fraction of a tick was left over belongs to the previous run: carrying it into a new
    // one applies an extra frame and makes playback jump a tick.
    this._accumulator = 0;
    this.state = ReplayState.Playing;
    replayEvents.onPlaybackStarted.broadcast(this.replay, this);
    return true;
  }

  pause() { if (this.playing) this.state = ReplayState.Paused; return this; }
  resume() { if (this.state === ReplayState.Paused) this.state = ReplayState.Playing; return this; }
  setSpeed(speed) { this.speed = Math.max(0.05, Number(speed) || 1); return this; }

  stop() {
    this.state = ReplayState.Loaded;
    this.cursor = 0;
    if (this.engine) for (const input of this.engine.inputMappings.values()) input.clearActionValues();
    return this;
  }

  /** Jumps to a tick, using the nearest snapshot when the replay has them. */
  seekToTick(tick) {
    this._accumulator = 0;
    const frames = this.replay?.frames ?? [];
    if (!frames.length) return false;
    const snapshot = [...(this.replay.snapshots ?? [])].reverse().find((entry) => entry.tick <= tick);
    let index = snapshot ? snapshot.frameIndex : 0;
    while (index < frames.length && frames[index].tick < tick) index++;
    this.cursor = Math.min(index, frames.length - 1);
    this.snapshotApplied = snapshot ?? null;
    return true;
  }

  /** Applies the frame at the cursor to the engine's input systems. Returns the frame. */
  step() {
    const frame = this.replay?.frames[this.cursor];
    if (!frame) return null;
    this._apply(frame);
    this.cursor++;
    this.ticks++;
    replayEvents.onPlaybackTick.broadcast(frame, this);
    if (this.cursor >= this.replay.frameCount) {
      this.state = ReplayState.Finished;
      replayEvents.onPlaybackFinished.broadcast(this.replay, this);
    }
    return frame;
  }

  /**
   * Advances playback by `deltaSeconds` of wall time (scaled by `speed`), applying one recorded
   * frame per simulation tick. Returns the number of frames applied.
   */
  advance(deltaSeconds) {
    if (!this.playing || !this.replay) return 0;
    const tickDuration = 1 / Math.max(1, this.replay.tickRate);
    this._accumulator += deltaSeconds * this.speed;
    let applied = 0;
    // Epsilon: 0.25 s at 4× is 60 ticks, and floating point must not turn that into 59.
    while (this._accumulator + 1e-9 >= tickDuration && this.cursor < this.replay.frameCount) {
      this._accumulator -= tickDuration;
      this.step();
      applied++;
      if (this.state === ReplayState.Finished) break;
    }
    return applied;
  }

  _apply(frame) {
    if (!this.engine) return;
    for (const input of this.engine.inputMappings.values()) {
      if (frame.keys) {
        input.keyValues.clear();
        for (const [key, value] of Object.entries(frame.keys)) input.setKeyValue(key, value);
      } else if (frame.actions) {
        const fired = frame.triggers ?? [];
        for (const action of input.actions.values()) {
          const recorded = frame.actions[action.name];
          action.triggered = fired.includes(action.name);
          if (recorded === undefined) { action.value = typeof action.value === 'object' ? { x: 0, y: 0, z: 0 } : 0; continue; }
          action.value = typeof recorded === 'object' ? { ...recorded } : recorded;
        }
      }
    }
  }

  /** Verifies a replay against a live engine: the checksum mismatch tick is the divergence point. */
  verify({ checksum, startTick = 0, onTick = null } = {}) {
    if (!this.replay) return { ok: false, reason: 'no replay loaded' };
    const original = this.cursor;
    const originalState = this.state;
    const startingTicks = this.ticks;
    this.cursor = 0;
    this.seekToTick(startTick);
    this.divergences.length = 0;
    while (this.cursor < this.replay.frameCount) {
      const frame = this.replay.frames[this.cursor];
      this.step();
      onTick?.(frame, this.engine);
      if (checksum) {
        const actual = checksum(this.engine, frame.tick) >>> 0;
        if (frame.checksum && actual !== frame.checksum) {
          this.divergences.push({ tick: frame.tick, expected: frame.checksum, actual });
          replayEvents.onDivergence.broadcast(frame, actual, this);
          break;
        }
      }
    }
    const result = {
      ok: this.divergences.length === 0,
      divergences: [...this.divergences],
      framesChecked: this.ticks - startingTicks,
      firstDivergenceTick: this.divergences[0]?.tick ?? null,
    };
    this.cursor = original;
    this.state = originalState;
    return result;
  }

  describe() {
    return {
      state: this.state, speed: this.speed, cursor: this.cursor, tick: this.tick,
      frames: this.replay?.frameCount ?? 0, progress: round3(this.progress),
      divergences: this.divergences.length,
    };
  }
}

/** Owns a recorder and a player, and exposes them on the engine + console. */
export class ReplaySystem {
  constructor({ engine = null, name = 'Replay', mode = 'actions', sampleEvery = 60, checksum = null, maxFrames = 60 * 60 * 10 } = {}) {
    this.engine = engine;
    this.recorder = new ReplayRecorder({ engine, name, mode, sampleEvery, checksum, maxFrames });
    this.player = new ReplayPlayer({ engine });
    this.last = null;
  }

  static create(options) { return new ReplaySystem(options); }

  get state() { return this.recorder.recording ? ReplayState.Recording : this.player.state; }
  get recording() { return this.recorder.recording; }

  startRecording(options) { return this.recorder.start(options); }
  stopRecording() { this.last = this.recorder.stop(); return this.last; }
  play(replay = null) {
    if (replay) this.player.load(replay);
    else if (!this.player.replay && this.last) this.player.load(this.last);
    return this.player.play();
  }
  pause() { return this.player.pause(); }
  resume() { return this.player.resume(); }
  setSpeed(speed) { return this.player.setSpeed(speed); }

  /** Advances playback from the engine's frame loop. */
  update(deltaSeconds) { return this.player.advance(deltaSeconds); }

  /** Saves the current replay as an archive payload (binary or JSON). */
  save({ format = 'binary', name = null } = {}) {
    const replay = this.player.replay ?? this.last ?? this.recorder.replay;
    ensureReplayStructs();
    const writer = new ArchiveWriter({ format, kind: PayloadKind.Replay, version: replay.version });
    writer.section('header', 'ReplayHeader', {
      name: name ?? replay.name, tickRate: replay.tickRate, mode: replay.mode, recordedAt: replay.recordedAt,
      frameCount: replay.frameCount, channels: replay.channels.join(','), metadata: JSON.stringify(replay.metadata ?? {}),
    });
    writer.section('frames', 'ReplayTrack', { payload: JSON.stringify({ frames: replay.frames, snapshots: replay.snapshots, channels: replay.channels }) });
    return writer.finish();
  }

  /** Loads a replay saved by `save()`. */
  load(data) {
    ensureReplayStructs();
    const reader = new ArchiveReader(data);
    const header = reader.read('header');
    const track = reader.read('frames');
    if (!header || !track) return null;
    const replay = new Replay({
      name: header.name, tickRate: header.tickRate, mode: header.mode, recordedAt: header.recordedAt,
      metadata: header.metadata ? JSON.parse(header.metadata) : {},
    });
    const parsed = JSON.parse(track.payload);
    replay.frames = parsed.frames.map((frame) => Object.assign(new ReplayFrame(frame.tick, {}), frame));
    replay.snapshots = parsed.snapshots ?? [];
    replay.channels = parsed.channels ?? [];
    this.player.load(replay);
    this.last = replay;
    return replay;
  }

  describe() {
    return {
      state: this.state,
      recording: this.recorder.describe?.() ?? { frames: this.recorder.replay.frameCount },
      player: this.player.describe(),
      last: this.last?.describe() ?? null,
      replay: (this.player.replay ?? this.recorder.replay).describe(),
    };
  }

  installConsoleCommands(console_) {
    const system = this;
    console_.registerCommand({
      name: 'replay', aliases: ['replay.status'], category: 'Replay', description: 'Recording/playback state and the current replay summary.',
      execute: () => {
        const replay = system.player.replay ?? system.recorder.replay;
        return [
          `  state ${system.state}${system.recording ? ` · tick ${system.recorder.tick}` : ''}${system.player.playing ? ` · cursor ${system.player.cursor}/${replay.frameCount}` : ''}`,
          `  replay "${replay.name}" ${replay.frameCount} frames (${replay.seconds.toFixed(1)} s @ ${replay.tickRate} Hz, ${replay.mode})`,
          `  snapshots ${replay.snapshots.length} · channels ${replay.channels.length}`,
        ].join('\n');
      },
    });
    console_.registerCommand({
      name: 'replay.start', category: 'Replay', description: 'Starts recording input.',
      args: [{ name: 'name', required: false, default: 'Replay' }],
      execute: (args) => { system.startRecording({ name: args.name }); return `recording "${args.name}"`; },
    });
    console_.registerCommand({
      name: 'replay.stop', category: 'Replay', description: 'Stops recording and keeps the result.',
      execute: () => { const replay = system.stopRecording(); return `recorded ${replay.frameCount} frames (${replay.seconds.toFixed(1)} s)`; },
    });
    console_.registerCommand({
      name: 'replay.play', category: 'Replay', description: 'Plays the last recording back into the input system.',
      args: [{ name: 'speed', type: 'number', required: false, min: 0.1, max: 16, default: 1 }],
      execute: (args) => { system.setSpeed(args.speed); const ok = system.play(); return ok ? `playing at ${args.speed}×` : 'nothing to play'; },
    });
    console_.registerCommand({
      name: 'replay.pause', category: 'Replay', description: 'Pauses or resumes playback.',
      execute: () => { system.player.playing ? system.player.pause() : system.player.resume(); return system.player.state; },
    });
    console_.registerCommand({
      name: 'replay.seek', category: 'Replay', description: 'Seeks playback to a tick.',
      args: [{ name: 'tick', type: 'int', min: 0 }],
      execute: (args) => (system.player.seekToTick(args.tick) ? `cursor ${system.player.cursor} (tick ${system.player.tick})` : 'no replay loaded'),
    });
    console_.registerCommand({
      name: 'replay.save', category: 'Replay', description: 'Prints the replay as an archive payload size (binary save goes through the API).',
      execute: () => {
        const bytes = system.save();
        return `replay payload ${bytes.length} B`;
      },
    });
    return console_;
  }
}

// ------------------------------------------------------------------ helpers

function ensureReplayStructs() {
  defineStruct('ReplayHeader', {
    name: 'string', tickRate: 'u16', mode: 'string', recordedAt: 'string',
    frameCount: 'u32', channels: 'string', metadata: 'string',
  });
  defineStruct('ReplayTrack', { payload: 'string' });
}

function estimateBytes(frames) {
  let bytes = 0;
  for (const frame of frames) {
    bytes += 16;
    if (frame.actions) for (const value of Object.values(frame.actions)) bytes += typeof value === 'object' ? 20 : 10;
    if (frame.keys) bytes += Object.keys(frame.keys).length * 12;
    if (frame.state) bytes += 64;
  }
  return bytes;
}

function round3(value) { return Math.round((Number(value) || 0) * 1000) / 1000; }

export default ReplaySystem;
