/**
 * OminX Engine — input mapping (the Enhanced Input model).
 *
 * Reading raw keys inside gameplay is how shooters become unmodifiable: "if W is down" spreads
 * through the movement code, and then keyboard rebinding, gamepad support, ADS sensitivity or a
 * cutscene takeover all require editing gameplay. This module is UE5's Enhanced Input instead:
 * gameplay asks *"how much does the player want to move?"* and never learns which key produced it.
 *
 * ```
 * const input = createInputMapping({ engine });
 * input.addContext(playerContext);          // contexts stack — the HUD opens, the menu wins
 * input.setKeyValue(Keys.W, 1);             // fed by the OS layer each frame
 * input.evaluate(deltaSeconds);
 * const move = input.getActionValue(Actions.Move);   // { x: 0, y: 1 }
 * if (input.wasPressed(Actions.Jump)) jump();
 * ```
 *
 *   - **InputAction** — what the player is trying to do (`Move`, `Look`, `Fire`, `Reload`, `ADS`),
 *     typed as `bool`/`axis1d`/`axis2d`/`axis3d` so wrong usage is caught.
 *   - **InputMappingContext** — a rebindable set of key → action mappings with a priority. The
 *     player's context, the vehicle context and the menu context coexist; higher priority wins and
 *     can consume input so the lower context never sees it (a menu must freeze the player).
 *   - **Modifiers** — transform the raw value on the way in: negate, scale, swizzle, dead zone,
 *     sensitivity curve, aim-down-sights scalar. Recoil compensation and per-zoom sensitivity are
 *     modifier stacks, not special cases in the camera code.
 *   - **Triggers** — decide *when* the action fires: pressed, released, tap, hold, pulse, chorded
 *     (two keys held together), or a multi-step combo. Launching a grenade is `Hold(0.35)`,
 *     a quick melee is `Tap(0.15)`.
 *
 * The system is device-agnostic: something outside it (browser events, XInput, a replay file, a
 * test) calls `setKeyValue`. That is what makes input replayable in a test and identical between a
 * live client and a headless soak run.
 *
 * @module engine/src/core/InputMapping
 */
import { MulticastDelegate } from './Delegate.js';
import { createLogger } from './Logger.js';

const log = createLogger('Input');

/** Named action values — a bool reads as 1/0, axes as -1..1, 2D as x/y. */
export const InputValueType = {
  Bool: 'bool',
  Axis1D: 'axis1d',
  Axis2D: 'axis2d',
  Axis3D: 'axis3d',
};

/** Keys are names, not codes: rebinding, replay and tests all use the same vocabulary. */
export const Keys = {
  W: 'W', A: 'A', S: 'S', D: 'D', Q: 'Q', E: 'E', R: 'R', F: 'F', G: 'G', C: 'C', V: 'V', X: 'X', Z: 'Z',
  SpaceBar: 'SpaceBar', Shift: 'Shift', Ctrl: 'Ctrl', Alt: 'Alt', Tab: 'Tab', Escape: 'Escape', Enter: 'Enter',
  Digit1: 'Digit1', Digit2: 'Digit2', Digit3: 'Digit3', Digit4: 'Digit4', Digit5: 'Digit5',
  MouseLeft: 'MouseLeft', MouseRight: 'MouseRight', MouseMiddle: 'MouseMiddle', MouseWheelUp: 'MouseWheelUp', MouseWheelDown: 'MouseWheelDown',
  MouseX: 'MouseX', MouseY: 'MouseY',
  Gamepad_LeftX: 'Gamepad_LeftX', Gamepad_LeftY: 'Gamepad_LeftY', Gamepad_RightX: 'Gamepad_RightX', Gamepad_RightY: 'Gamepad_RightY',
  Gamepad_LeftTrigger: 'Gamepad_LeftTrigger', Gamepad_RightTrigger: 'Gamepad_RightTrigger',
  Gamepad_FaceButton_Bottom: 'Gamepad_FaceButton_Bottom', Gamepad_FaceButton_Right: 'Gamepad_FaceButton_Right',
  Gamepad_FaceButton_Left: 'Gamepad_FaceButton_Left', Gamepad_FaceButton_Top: 'Gamepad_FaceButton_Top',
  Gamepad_LeftShoulder: 'Gamepad_LeftShoulder', Gamepad_RightShoulder: 'Gamepad_RightShoulder',
  Gamepad_LeftThumbstick: 'Gamepad_LeftThumbstick', Gamepad_RightThumbstick: 'Gamepad_RightThumbstick',
  Gamepad_DPad_Up: 'Gamepad_DPad_Up', Gamepad_DPad_Down: 'Gamepad_DPad_Down', Gamepad_DPad_Left: 'Gamepad_DPad_Left', Gamepad_DPad_Right: 'Gamepad_DPad_Right',
};

export const inputEvents = {
  onActionStarted: new MulticastDelegate('input.onActionStarted'),
  onActionTriggered: new MulticastDelegate('input.onActionTriggered'),
  onActionCompleted: new MulticastDelegate('input.onActionCompleted'),
  onContextChanged: new MulticastDelegate('input.onContextChanged'),
  onUnmappedKey: new MulticastDelegate('input.onUnmappedKey'),
};

/** An intent, typed. `new InputAction('Move', { valueType: InputValueType.Axis2D })`. */
export class InputAction {
  constructor(name, { valueType = InputValueType.Bool, description = '', consumption = 1, category = 'Gameplay' } = {}) {
    this.name = name;
    this.valueType = valueType;
    this.description = description;
    /** How much of the accumulated value this action consumes (a lower-priority action sees the rest). */
    this.consumption = consumption;
    this.category = category;
    this.value = defaultValueFor(valueType);
    this.previous = defaultValueFor(valueType);
    this.started = false;        // value became non-zero this frame
    this.triggered = false;      // a trigger fired this frame
    this.completed = false;      // value returned to zero this frame
    this.heldSeconds = 0;
    this.frames = 0;
    /** Set by `PlayerController`-style owners to block input without unmapping it (cutscenes). */
    this.ignoreWhileBlocked = true;
    this.blocked = false;
  }

  describe() {
    return {
      name: this.name, valueType: this.valueType, category: this.category,
      value: this.value, heldSeconds: round3(this.heldSeconds), triggered: this.triggered,
      consumption: this.consumption,
    };
  }
}

function defaultValueFor(valueType) {
  switch (valueType) {
    case InputValueType.Axis2D: return { x: 0, y: 0 };
    case InputValueType.Axis3D: return { x: 0, y: 0, z: 0 };
    default: return 0;
  }
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value && typeof value === 'object') return Math.max(Math.abs(value.x ?? 0), Math.abs(value.y ?? 0), Math.abs(value.z ?? 0));
  return 0;
}

function isActive(value) { return toNumber(value) > 0.0001; }

function round3(value) { return Math.round((Number(value) || 0) * 1000) / 1000; }

// ------------------------------------------------------------------ modifiers
/**
 * Modifiers transform a raw key value into an action value. They compose in order, and a modifier
 * can decline the input (return `null`) — which is how a dead zone suppresses stick drift entirely
 * rather than passing a small number down to the camera.
 */
export const Modifiers = {
  /** Flips one or more axes: `Negate({ axes: 'y' })` turns a pad up-push into +Y. */
  Negate: (options = {}) => ({
    name: 'Negate',
    apply: (value, axes) => scaleValue(value, axes ?? [options.axes ?? 'x'], -1),
  }),
  /** Multiplies — sensitivity, ADS multiplier, invert-Y. */
  Scale: (options = {}) => ({
    name: `Scale(${options.factor ?? 1})`,
    apply: (value, axes) => scaleValue(value, axes ?? ['x', 'y', 'z'], options.factor ?? 1),
  }),
  /** Reorders axes: `Swizzle({ order: ['y', 'x', 'z'] })`. */
  Swizzle: (options = {}) => ({
    name: 'Swizzle',
    apply: (value) => {
      const order = options.order ?? ['y', 'x', 'z'];
      if (typeof value === 'number') return value;
      const source = { x: value.x ?? 0, y: value.y ?? 0, z: value.z ?? 0 };
      return { x: source[order[0]] ?? 0, y: source[order[1]] ?? 0, z: source[order[2]] ?? 0 };
    },
  }),
  /** Radial dead zone with optional curve remap (the anti-drift modifier every shooter needs). */
  DeadZone: (options = {}) => ({
    name: `DeadZone(${options.lower ?? 0.2})`,
    apply: (value) => {
      const lower = options.lower ?? 0.2;
      const upper = Math.max(lower + 0.0001, options.upper ?? 1);
      if (typeof value === 'number') {
        const magnitude = Math.abs(value);
        if (magnitude < lower) return null;
        const remapped = ((magnitude - lower) / (upper - lower)) * Math.sign(value);
        return options.clamp === false ? remapped : Math.max(-1, Math.min(1, remapped));
      }
      const x = value.x ?? 0;
      const y = value.y ?? 0;
      const magnitude = Math.hypot(x, y);
      if (magnitude < lower) return null;
      const scale = Math.min(1, (magnitude - lower) / (upper - lower)) / (magnitude || 1);
      return { x: x * scale, y: y * scale, z: value.z ?? 0 };
    },
  }),
  /** Exponential response curve — precision near the centre, speed at the edges. */
  Curve: (options = {}) => ({
    name: `Curve(${options.exponent ?? 2})`,
    apply: (value, axes) => {
      const exponent = options.exponent ?? 2;
      if (typeof value === 'number') return Math.sign(value) * Math.pow(Math.abs(value), exponent);
      const shape = (component) => Math.sign(component) * Math.pow(Math.abs(component), exponent);
      return { x: shape(value.x ?? 0), y: shape(value.y ?? 0), z: shape(value.z ?? 0) };
    },
  }),
  /** Frame-rate independent smoothing (mouse look that does not chatter). */
  Smooth: (options = {}) => {
    let current = null;
    const alpha = Math.max(0.001, Math.min(1, options.alpha ?? 0.35));
    return {
      name: 'Smooth',
      apply: (value, _axes, deltaSeconds) => {
        const smoothing = 1 - Math.pow(1 - alpha, Math.max(1, (deltaSeconds ?? 1 / 60) * 60));
        if (typeof value === 'number') {
          current = current === null ? value : current + (value - current) * smoothing;
          return current;
        }
        current ??= { x: 0, y: 0, z: 0 };
        current = {
          x: current.x + ((value.x ?? 0) - current.x) * smoothing,
          y: current.y + ((value.y ?? 0) - current.y) * smoothing,
          z: current.z + ((value.z ?? 0) - current.z) * smoothing,
        };
        return { ...current };
      },
    };
  },
  /** Scales a 1D/2D input by an external value — ADS zoom sensitivity, scoped sway. */
  Scalar: (options = {}) => ({
    name: 'Scalar',
    apply: (value) => {
      const factor = typeof options.factor === 'function' ? options.factor() : (options.factor ?? 1);
      return typeof value === 'number' ? value * factor : { x: (value.x ?? 0) * factor, y: (value.y ?? 0) * factor, z: (value.z ?? 0) * factor };
    },
  }),
  /** Rejects input entirely while a condition holds (blocked reload, no ammo, in a menu). */
  Gate: (options = {}) => ({
    name: 'Gate',
    apply: (value) => (typeof options.condition === 'function' ? (options.condition() ? value : null) : value),
  }),
};

function scaleValue(value, axes, factor) {
  if (typeof value === 'number') return value * factor;
  const out = { x: value.x ?? 0, y: value.y ?? 0, z: value.z ?? 0 };
  for (const axis of axes) if (axis in out) out[axis] *= factor;
  return out;
}

// ------------------------------------------------------------------ triggers
/**
 * Triggers decide when an action counts as *fired*. `evaluate(state)` returns true to fire this
 * frame; state carries `{ value, deltaSeconds, heldSeconds, justPressed, justReleased, otherKeys }`.
 */
export const Triggers = {
  Down: () => ({ name: 'Down', evaluate: (state) => isActive(state.value) }),
  Pressed: () => ({ name: 'Pressed', oneShot: true, evaluate: (state) => state.justPressed && isActive(state.value) }),
  Released: () => ({ name: 'Released', oneShot: true, evaluate: (state) => state.justReleased }),
  /**
   * Fires once, `seconds` after the key went down, and stays fired until it is released (charge a
   * grenade, hold to steady aim). Without `oneShot` this would fire on every frame past the
   * threshold, which is how a held grenade throws itself sixty times a second.
   */
  Hold: (options = {}) => ({ name: `Hold(${options.seconds ?? 0.3})`, oneShot: true, evaluate: (state) => isActive(state.value) && state.heldSeconds >= (options.seconds ?? 0.3) }),
  /**
   * Fires on release if the press was shorter than `seconds` (melee, quick switch). It reads
   * `pressDuration`, not the live hold timer — by the time the key is released the live timer has
   * already been reset, so a ten-second hold would otherwise count as a tap.
   */
  Tap: (options = {}) => ({ name: `Tap(${options.seconds ?? 0.2})`, oneShot: true, evaluate: (state) => state.justReleased && (state.pressDuration ?? state.heldSeconds) <= (options.seconds ?? 0.2) }),
  /** Fires repeatedly every `seconds` while held (auto-fire, hold to place repeated markers). */
  Pulse: (options = {}) => ({ name: `Pulse(${options.seconds ?? 0.1})`, evaluate: (state) => {
    const interval = options.seconds ?? 0.1;
    // Frame deltas are fractional seconds; without the epsilon a 0.1 s interval on a 60 Hz loop
    // fires every 7th frame instead of every 6th.
    const epsilon = 1e-6;
    return isActive(state.value) && state.heldSeconds + epsilon >= interval
      && (state.firedCount === 0 || state.sinceLastFire + epsilon >= interval);
  } }),
  /** Fires only while other keys are held — chords, e.g. Shift+W for sprint. */
  Chorded: (options = {}) => ({ name: 'Chorded', evaluate: (state) => isActive(state.value) && (options.keys ?? []).every((key) => (state.otherKeys?.[key] ?? 0) > 0.5) }),
  /** Multi-step combo: press W W to dodge-roll. Resets after `resetSeconds` without progress. */
  Combo: (options = {}) => {
    const steps = Math.max(2, options.steps ?? 2);
    const window = options.resetSeconds ?? 0.45;
    let progress = 0;
    let last = -Infinity;
    return {
      name: `Combo(${steps})`,
      evaluate: (state) => {
        if (!state.justPressed) return false;
        const now = state.elapsed ?? 0;
        progress = (now - last <= window) ? progress + 1 : 1;
        last = now;
        if (progress >= steps) { progress = 0; return true; }
        return false;
      },
    };
  },
};

/** One key → action mapping inside a context. */
export class InputBinding {
  constructor(action, key, { modifiers = [], triggers = [], disabled = false, axes = null, comment = '' } = {}) {
    this.action = action instanceof InputAction ? action : null;
    this.actionName = action instanceof InputAction ? action.name : String(action);
    this.key = key;
    this.modifiers = [...modifiers];
    this.triggers = triggers.length ? [...triggers] : [Triggers.Down()];
    this.disabled = disabled;
    this.axes = axes;
    this.comment = comment;
  }

  describe() {
    return {
      action: this.actionName, key: this.key, disabled: this.disabled,
      modifiers: this.modifiers.map((modifier) => modifier.name),
      triggers: this.triggers.map((trigger) => trigger.name),
    };
  }
}

/** A prioritized, fully rebindable set of bindings. */
export class InputMappingContext {
  constructor(name, { priority = 0, description = '' } = {}) {
    this.name = name;
    this.priority = priority;
    this.description = description;
    /** @type {InputBinding[]} */
    this.bindings = [];
    this.enabled = true;
    this.tags = new Set();
  }

  /** `context.map(actions.Fire, Keys.MouseLeft, { triggers: [Triggers.Pressed()] })`. */
  map(action, key, options = {}) {
    const binding = action instanceof InputBinding ? action : new InputBinding(action, key, options);
    // One action may be bound to several keys; one key may drive several actions.
    this.bindings.push(binding);
    return binding;
  }

  /** Replaces every binding for a key — the rebinding screen's single operation. */
  remapKey(oldKey, newKey) {
    let changed = 0;
    for (const binding of this.bindings) if (binding.key === oldKey) { binding.key = newKey; changed++; }
    return changed;
  }

  /** Replaces every binding for an action (rebinding by intent instead of by key). */
  rebindAction(actionName, keys) {
    const target = actionName instanceof InputAction ? actionName.name : String(actionName);
    const list = Array.isArray(keys) ? keys : [keys];
    const kept = this.bindings.filter((binding) => binding.actionName !== target);
    const template = this.bindings.find((binding) => binding.actionName === target);
    this.bindings = kept;
    for (const key of list) this.bindings.push(new InputBinding(target, key, {
      modifiers: template?.modifiers ?? [], triggers: template?.triggers ?? [], axes: template?.axes,
    }));
    return list.length;
  }

  unbind(actionName, key = null) {
    const target = actionName instanceof InputAction ? actionName.name : String(actionName);
    const before = this.bindings.length;
    this.bindings = this.bindings.filter((binding) => !(binding.actionName === target && (key === null || binding.key === key)));
    return before - this.bindings.length;
  }

  get bindingsForAction() {
    const map = new Map();
    for (const binding of this.bindings) {
      if (!map.has(binding.actionName)) map.set(binding.actionName, []);
      map.get(binding.actionName).push(binding);
    }
    return map;
  }

  describe() {
    return { name: this.name, priority: this.priority, enabled: this.enabled, bindings: this.bindings.map((binding) => binding.describe()) };
  }
}

/**
 * The mapping system: holds contexts and actions, consumes raw key state, and produces action
 * values. One instance per local player.
 */
export class InputMappingSystem {
  constructor({ name = 'Input', stats = null, evaluateInterval = 0 } = {}) {
    this.name = name;
    this.stats = stats;
    this.evaluateInterval = evaluateInterval;
    /** @type {Map<string, InputAction>} */
    this.actions = new Map();
    /** @type {InputMappingContext[]} */
    this.contexts = [];
    /** @type {Map<string, number>} raw key values, fed by the platform layer */
    this.keyValues = new Map();
    this.previousKeyValues = new Map();
    this.elapsed = 0;
    this.evaluationCount = 0;
    this.lastEvaluateMs = 0;
    this.unmappedKeys = new Set();
    this.inputBlocked = false;
    this._actionStates = new Map();
    this._sorted = false;
  }

  static create(options) { return new InputMappingSystem(options); }

  // ------------------------------------------------------------------ registration
  /** Declares an action. Repeated calls with the same name return the existing action. */
  addAction(nameOrAction, options = {}) {
    const action = nameOrAction instanceof InputAction ? nameOrAction : new InputAction(nameOrAction, options);
    if (this.actions.has(action.name)) return this.actions.get(action.name);
    this.actions.set(action.name, action);
    this._actionStates.set(action.name, { heldSeconds: 0, firedCount: 0, sinceLastFire: 0, wasActive: false, bindings: [], oneShot: new Set() });
    return action;
  }

  getAction(name) { return this.actions.get(name instanceof InputAction ? name.name : String(name)) ?? null; }
  actionNames() { return [...this.actions.keys()]; }

  /** Adds (or re-prioritizes) a context. Higher priority is evaluated first and consumes first. */
  addContext(context, { priority = null } = {}) {
    if (priority !== null) context.priority = priority;
    if (!this.contexts.includes(context)) this.contexts.push(context);
    this._sorted = false;
    inputEvents.onContextChanged.broadcast(this.contexts, context, this);
    return context;
  }

  removeContext(context) {
    const index = this.contexts.indexOf(context);
    if (index < 0) return false;
    this.contexts.splice(index, 1);
    inputEvents.onContextChanged.broadcast(this.contexts, context, this);
    // Actions only mapped by the removed context must not stay stuck "held".
    this.recomputeActionValues();
    return true;
  }

  hasContext(context) { return this.contexts.includes(context); }
  contextNames() { return this._orderedContexts().map((context) => context.name); }

  _orderedContexts() {
    if (this._sorted) return this.contexts;
    this.contexts.sort((a, b) => b.priority - a.priority);
    this._sorted = true;
    return this.contexts;
  }

  /** Applies the same binding to every action — used by a rebinding UI to reload saved mappings. */
  applyBindings(contextName, mappings) {
    const context = this.contexts.find((entry) => entry.name === contextName);
    if (!context) return 0;
    context.bindings = mappings.map((mapping) => new InputBinding(mapping.action, mapping.key, {
      modifiers: (mapping.modifiers ?? []).map((name) => Modifiers[name]?.() ?? Modifiers.Scale()).filter(Boolean),
      disabled: mapping.disabled,
      comment: mapping.comment,
    }));
    return context.bindings.length;
  }

  /** Serializes bindings for a settings file or the network (rebinding is per player). */
  exportBindings(contextName = null) {
    return this.contexts
      .filter((context) => !contextName || context.name === contextName)
      .map((context) => ({
        name: context.name,
        priority: context.priority,
        bindings: context.bindings.map((binding) => ({
          action: binding.actionName, key: binding.key, disabled: binding.disabled,
          modifiers: binding.modifiers.map((modifier) => modifier.name),
          triggers: binding.triggers.map((trigger) => trigger.name.replace(/\(.*\)/, '')),
        })),
      }));
  }

  // ------------------------------------------------------------------ raw input
  /**
   * Feeds a raw key value. Buttons are 0/1, axes are -1..1, mouse deltas may exceed 1 and are
   * allowed to (they are per-frame movement, not a normalized axis).
   */
  setKeyValue(key, value, { accumulate = false } = {}) {
    const current = this.keyValues.get(key) ?? 0;
    this.keyValues.set(key, accumulate ? current + value : value);
    return this;
  }

  /** Feeds a batch — `input.setKeys({ Key.W: 1, Key.MouseX: 12 })`. */
  setKeys(values) {
    for (const [key, value] of Object.entries(values)) this.setKeyValue(key, value);
    return this;
  }

  getKeyValue(key) { return this.keyValues.get(key) ?? 0; }
  isKeyDown(key) { return (this.keyValues.get(key) ?? 0) > 0.5; }

  /** Clears per-frame accumulators (mouse deltas, wheel) — called at the end of `evaluate`. */
  clearTransientKeys() {
    for (const key of [...this.keyValues.keys()]) {
      if (key === Keys.MouseX || key === Keys.MouseY || key === Keys.MouseWheelUp || key === Keys.MouseWheelDown) this.keyValues.set(key, 0);
    }
    return this;
  }

  /** Blocks all input without unmapping it (cutscene, menu, respawn). */
  setBlocked(blocked) {
    this.inputBlocked = !!blocked;
    if (this.inputBlocked) this.clearActionValues();
    return this;
  }

  clearActionValues() {
    for (const action of this.actions.values()) {
      action.previous = action.value;
      action.value = defaultValueFor(action.valueType);
      action.triggered = false;
      action.started = false;
      action.completed = false;
      action.heldSeconds = 0;
    }
    return this;
  }

  // ------------------------------------------------------------------ evaluation
  /**
   * Reads raw keys through the context stack and produces action values + trigger flags for this
   * frame. Call once per frame, before gameplay systems read actions.
   */
  evaluate(deltaSeconds = 1 / 60) {
    const started = nowMs();
    this.elapsed += deltaSeconds;
    this.evaluationCount++;
    const contexts = this._orderedContexts();

    // 1. Which raw keys are actually claimed this frame — anything else is reported as unmapped.
    const claimed = new Set();
    for (const context of contexts) {
      if (!context.enabled) continue;
      for (const binding of context.bindings) if (!binding.disabled) claimed.add(binding.key);
    }
    for (const [key, value] of this.keyValues) {
      if (value === 0) this.unmappedKeys.delete(key);
      else if (!claimed.has(key)) this.unmappedKeys.add(key);
    }

    // 2. Accumulate values per action, highest context priority first.
    const accumulated = new Map();
    for (const context of contexts) {
      if (!context.enabled) continue;
      for (const binding of context.bindings) {
        if (binding.disabled) continue;
        const action = binding.action ?? this.actions.get(binding.actionName);
        if (!action) continue;
        let value = this.keyValues.get(binding.key) ?? 0;
        if (value === 0) continue;
        let accepted = true;
        for (const modifier of binding.modifiers) {
          value = modifier.apply(value, binding.axes, deltaSeconds);
          if (value === null) { accepted = false; break; }
        }
        if (!accepted) continue;
        const entry = accumulated.get(action.name) ?? { value: defaultValueFor(action.valueType), consumed: 0, bindings: [] };
        entry.value = combineInputValues(entry.value, shapeForAction(value, action.valueType, binding), action.valueType);
        entry.bindings.push(binding);
        accumulated.set(action.name, entry);
      }
    }

    // 3. Commit values, update hold timers and run triggers.
    for (const action of this.actions.values()) {
      const state = this._actionStates.get(action.name);
      const entry = accumulated.get(action.name);
      action.previous = action.value;
      const blocked = this.inputBlocked && action.ignoreWhileBlocked;
      action.value = blocked ? defaultValueFor(action.valueType) : (entry?.value ?? defaultValueFor(action.valueType));
      const active = isActive(action.value);
      action.started = active && !isActive(action.previous);
      action.completed = !active && isActive(action.previous);
      // How long the press lasted, captured before the live timer is reset on release — `Tap`
      // needs the finished press, not the current one.
      const pressDuration = action.completed ? action.heldSeconds : (active ? action.heldSeconds + deltaSeconds : 0);
      action.heldSeconds = active ? action.heldSeconds + deltaSeconds : 0;
      state.heldSeconds = action.heldSeconds;
      state.sinceLastFire += deltaSeconds;

      const justPressed = action.started && this._keyWentDown(entry);
      const justReleased = action.completed;
      // Release triggers must still be evaluated on the frame the key went up, when there is no
      // incoming binding value any more — so the last binding set is retained per action.
      if (entry?.bindings.length) state.bindings = entry.bindings;
      const bindings = entry?.bindings.length ? entry.bindings : (justReleased ? state.bindings : []);
      if (!active) state.oneShot.clear();
      let fired = false;
      for (const binding of bindings) {
        for (const trigger of binding.triggers) {
          if (trigger.oneShot && state.oneShot.has(`${binding.key}:${trigger.name}`)) continue;
          if (trigger.evaluate({
            value: action.value, deltaSeconds, heldSeconds: action.heldSeconds,
            pressDuration, justPressed, justReleased, elapsed: this.elapsed,
            firedCount: state.firedCount, sinceLastFire: state.sinceLastFire,
            otherKeys: Object.fromEntries(this.keyValues),
          })) {
            fired = true;
            if (trigger.oneShot) state.oneShot.add(`${binding.key}:${trigger.name}`);
            break;
          }
        }
        if (fired) break;
      }
      action.triggered = fired;
      if (fired) { state.firedCount++; state.sinceLastFire = 0; }
      if (!active) state.firedCount = 0;

      if (action.started) inputEvents.onActionStarted.broadcast(action, this);
      if (fired) inputEvents.onActionTriggered.broadcast(action, this);
      if (action.completed) inputEvents.onActionCompleted.broadcast(action, this);
    }

    for (const key of this.unmappedKeys) inputEvents.onUnmappedKey.broadcast(key, this);
    this.clearTransientKeys();
    this.lastEvaluateMs = nowMs() - started;
    this.stats?.timing('Input/Evaluate', this.lastEvaluateMs);
    this.stats?.gauge('Input/UnmappedKeys', this.unmappedKeys.size);
    return this;
  }

  _keyWentDown(entry) {
    if (!entry) return true;
    for (const binding of entry.bindings) {
      const current = this.keyValues.get(binding.key) ?? 0;
      const previous = this.previousKeyValues.get(binding.key) ?? 0;
      if (current > 0 && previous <= 0) return true;
    }
    return false;
  }

  /** Recomputes values without advancing time (used after a remap or context change). */
  recomputeActionValues() {
    for (const action of this.actions.values()) action.value = defaultValueFor(action.valueType);
    return this.evaluate(0);
  }

  // ------------------------------------------------------------------ readback
  getActionValue(nameOrAction) {
    const action = this.getAction(nameOrAction);
    return action ? action.value : 0;
  }

  /** Scalar readback for axis/bool actions (2D/3D actions return the larger magnitude). */
  getActionMagnitude(nameOrAction) { return toNumber(this.getActionValue(nameOrAction)); }
  getActionAxis(nameOrAction) {
    const value = this.getActionValue(nameOrAction);
    return typeof value === 'number' ? value : (value?.y ?? 0);
  }
  getActionVector(nameOrAction) {
    const value = this.getActionValue(nameOrAction);
    if (typeof value === 'number') return { x: value, y: 0, z: 0 };
    return { x: value?.x ?? 0, y: value?.y ?? 0, z: value?.z ?? 0 };
  }
  isActionActive(nameOrAction) { return isActive(this.getActionValue(nameOrAction)); }
  wasPressed(nameOrAction) { return !!this.getAction(nameOrAction)?.started; }
  wasReleased(nameOrAction) { return !!this.getAction(nameOrAction)?.completed; }
  /** True when a trigger fired this frame (as opposed to simply being held). */
  wasTriggered(nameOrAction) { return !!this.getAction(nameOrAction)?.triggered; }
  getHeldSeconds(nameOrAction) { return this.getAction(nameOrAction)?.heldSeconds ?? 0; }

  /** Snapshot of everything pressed — the network/replay form of an input frame. */
  snapshot({ actions = null } = {}) {
    const list = actions ?? this.actionNames();
    const out = {};
    for (const name of list) {
      const value = this.getActionValue(name);
      if (typeof value === 'number') out[name] = Math.round(value * 1000) / 1000;
      else out[name] = { x: round3(value?.x), y: round3(value?.y), z: round3(value?.z) };
    }
    return out;
  }

  /** Compact bitmask form for the wire: one bit per action, order given by `actions`. */
  encodeBits(actions) {
    let bits = 0;
    actions.forEach((name, index) => { if (index < 32 && isActive(this.getActionValue(name))) bits |= (1 << index); });
    return bits >>> 0;
  }

  /** Replays a recorded snapshot (headless verification, network prediction). */
  applySnapshot(snapshot) {
    for (const [name, value] of Object.entries(snapshot ?? {})) {
      const action = this.actions.get(name);
      if (action) action.value = value;
    }
    return this;
  }

  // ------------------------------------------------------------------ reporting
  describe() {
    return {
      name: this.name,
      elapsed: round3(this.elapsed),
      evaluations: this.evaluationCount,
      lastEvaluateMs: round3(this.lastEvaluateMs),
      blocked: this.inputBlocked,
      contexts: this._orderedContexts().map((context) => context.describe()),
      actions: [...this.actions.values()].map((action) => action.describe()),
      unmappedKeys: [...this.unmappedKeys],
      keys: [...this.keyValues.entries()].filter(([, value]) => value !== 0).map(([key, value]) => `${key}=${round3(value)}`),
    };
  }

  format() {
    const lines = [`  ${this.name} — ${this.contexts.length} contexts, ${this.actions.size} actions, ${this.evaluationCount} evaluations`];
    for (const context of this._orderedContexts()) {
      lines.push(`  [${context.priority}] ${context.name}${context.enabled ? '' : ' (off)'} — ${context.bindings.length} bindings`);
    }
    for (const action of this.actions.values()) {
      if (!isActive(action.value)) continue;
      const value = typeof action.value === 'object' ? `(${round3(action.value.x)}, ${round3(action.value.y)})` : round3(action.value);
      lines.push(`  ${action.name.padEnd(16)} ${action.valueType.padEnd(7)} ${String(value).padStart(10)}  held ${round3(action.heldSeconds)}s${action.triggered ? '  [triggered]' : ''}`);
    }
    return lines.join('\n');
  }

  /** Registers console commands so mappings can be inspected and rebound live. */
  installConsoleCommands(console_) {
    const input = this;
    console_.registerCommand({
      name: 'input', aliases: ['input.list'], category: 'Input', description: 'Live input state, contexts and bindings.',
      execute: () => input.format(),
    });
    console_.registerCommand({
      name: 'input.contexts', category: 'Input', description: 'Lists mapping contexts by priority.',
      execute: () => input.contextNames().join(' > ') || 'no contexts',
    });
    console_.registerCommand({
      name: 'input.bind', category: 'Input', description: 'Binds an action to a key in a context.',
      args: [{ name: 'context' }, { name: 'action' }, { name: 'key' }],
      execute: (args) => {
        const context = input.contexts.find((entry) => entry.name === args.context);
        if (!context) return `no context "${args.context}"`;
        context.map(input.addAction(args.action), args.key, { triggers: [Triggers.Pressed()] });
        return `${args.action} → ${args.key} in ${context.name}`;
      },
    });
    console_.registerCommand({
      name: 'input.press', category: 'Input', description: 'Simulates a key press (debugging, tests).',
      args: [{ name: 'key' }, { name: 'value', type: 'number', required: false, default: 1 }],
      execute: (args) => { input.setKeyValue(args.key, args.value); return `${args.key} = ${args.value}`; },
    });
    return console_;
  }
}

// ------------------------------------------------------------------ helpers

/** Merges two values for the same action from different bindings (keyboard + gamepad both work). */
function combineInputValues(current, incoming, valueType) {
  if (valueType === InputValueType.Bool) return Math.max(toNumber(current), toNumber(incoming)) > 0 ? 1 : 0;
  if (valueType === InputValueType.Axis1D) {
    const a = toNumber(current);
    const b = toNumber(incoming);
    return Math.abs(a) >= Math.abs(b) ? a : b;
  }
  const a = current ?? { x: 0, y: 0, z: 0 };
  const b = incoming ?? { x: 0, y: 0, z: 0 };
  return {
    x: Math.abs(a.x ?? 0) >= Math.abs(b.x ?? 0) ? (a.x ?? 0) : (b.x ?? 0),
    y: Math.abs(a.y ?? 0) >= Math.abs(b.y ?? 0) ? (a.y ?? 0) : (b.y ?? 0),
    z: Math.abs(a.z ?? 0) >= Math.abs(b.z ?? 0) ? (a.z ?? 0) : (b.z ?? 0),
  };
}

/** Coerces whatever a binding produced into the action's declared shape. */
function shapeForAction(value, valueType, binding) {
  switch (valueType) {
    case InputValueType.Bool:
      return isActive(value) ? 1 : 0;
    case InputValueType.Axis1D:
      return toNumber(value);
    case InputValueType.Axis2D: {
      if (typeof value === 'number') {
        const axis = binding?.axes?.[0] ?? 'y';
        return axis === 'x' ? { x: value, y: 0 } : { x: 0, y: value };
      }
      return { x: value.x ?? 0, y: value.y ?? 0 };
    }
    case InputValueType.Axis3D:
      if (typeof value === 'number') return { x: 0, y: value, z: 0 };
      return { x: value.x ?? 0, y: value.y ?? 0, z: value.z ?? 0 };
    default:
      return value;
  }
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Builds an ECS-free but conventional shooter mapping set: Move/Look/Jump/Fire/ADS/Reload/Weapons. */
export function createShooterActions() {
  return {
    Move: new InputAction('Move', { valueType: InputValueType.Axis2D, category: 'Movement', description: 'WASD / left stick' }),
    Look: new InputAction('Look', { valueType: InputValueType.Axis2D, category: 'Camera', description: 'Mouse / right stick' }),
    Jump: new InputAction('Jump', { category: 'Movement' }),
    Crouch: new InputAction('Crouch', { category: 'Movement', description: 'Hold to crouch' }),
    Sprint: new InputAction('Sprint', { category: 'Movement' }),
    Fire: new InputAction('Fire', { category: 'Combat', description: 'Primary fire (auto)' }),
    AimDownSights: new InputAction('AimDownSights', { category: 'Combat' }),
    Reload: new InputAction('Reload', { category: 'Combat' }),
    Melee: new InputAction('Melee', { category: 'Combat' }),
    ThrowGrenade: new InputAction('ThrowGrenade', { category: 'Combat', description: 'Hold to cook' }),
    NextWeapon: new InputAction('NextWeapon', { category: 'Combat' }),
    PrevWeapon: new InputAction('PrevWeapon', { category: 'Combat' }),
    Scoreboard: new InputAction('Scoreboard', { category: 'UI', description: 'Hold to show' }),
    Interact: new InputAction('Interact', { category: 'Gameplay' }),
    Console: new InputAction('Console', { category: 'UI' }),
  };
}

/** The default shooter mapping context (fully rebindable, and the shape a settings UI edits). */
export function createShooterContext(actions = null, { name = 'Player', priority = 0 } = {}) {
  const set = actions ?? createShooterActions();
  const context = new InputMappingContext(name, { priority, description: 'Default FPS controls' });
  const deadZone = Modifiers.DeadZone({ lower: 0.18 });
  context.map(set.Move, Keys.W, { axes: ['y'], modifiers: [deadZone] });
  context.map(set.Move, Keys.S, { axes: ['y'], modifiers: [Modifiers.Negate({ axes: 'y' }), deadZone] });
  context.map(set.Move, Keys.D, { axes: ['x'], modifiers: [deadZone] });
  context.map(set.Move, Keys.A, { axes: ['x'], modifiers: [Modifiers.Negate({ axes: 'x' }), deadZone] });
  context.map(set.Move, Keys.Gamepad_LeftX, { axes: ['x'], modifiers: [deadZone] });
  context.map(set.Move, Keys.Gamepad_LeftY, { axes: ['y'], modifiers: [deadZone] });
  context.map(set.Look, Keys.MouseX, { axes: ['x'] });
  context.map(set.Look, Keys.MouseY, { axes: ['y'], modifiers: [Modifiers.Negate({ axes: 'y' })] });
  context.map(set.Look, Keys.Gamepad_RightX, { axes: ['x'], modifiers: [deadZone, Modifiers.Curve({ exponent: 2 })] });
  context.map(set.Look, Keys.Gamepad_RightY, { axes: ['y'], modifiers: [deadZone, Modifiers.Curve({ exponent: 2 })] });
  context.map(set.Jump, Keys.SpaceBar, { triggers: [Triggers.Pressed()] });
  context.map(set.Jump, Keys.Gamepad_FaceButton_Bottom, { triggers: [Triggers.Pressed()] });
  context.map(set.Crouch, Keys.Ctrl, { triggers: [Triggers.Down()] });
  context.map(set.Sprint, Keys.Shift, { triggers: [Triggers.Down()] });
  context.map(set.Fire, Keys.MouseLeft, { triggers: [Triggers.Down()] });
  context.map(set.Fire, Keys.Gamepad_RightTrigger, { modifiers: [Modifiers.DeadZone({ lower: 0.35 })], triggers: [Triggers.Down()] });
  context.map(set.AimDownSights, Keys.MouseRight, { triggers: [Triggers.Down()] });
  context.map(set.AimDownSights, Keys.Gamepad_LeftTrigger, { modifiers: [Modifiers.DeadZone({ lower: 0.25 })], triggers: [Triggers.Down()] });
  context.map(set.Reload, Keys.R, { triggers: [Triggers.Pressed()] });
  context.map(set.Reload, Keys.Gamepad_FaceButton_Left, { triggers: [Triggers.Pressed()] });
  context.map(set.Melee, Keys.V, { triggers: [Triggers.Tap({ seconds: 0.2 })] });
  context.map(set.ThrowGrenade, Keys.G, { triggers: [Triggers.Hold({ seconds: 0.35 })] });
  context.map(set.NextWeapon, Keys.MouseWheelDown, { triggers: [Triggers.Pressed()] });
  context.map(set.PrevWeapon, Keys.MouseWheelUp, { triggers: [Triggers.Pressed()] });
  context.map(set.Scoreboard, Keys.Tab, { triggers: [Triggers.Down()] });
  context.map(set.Interact, Keys.E, { triggers: [Triggers.Pressed()] });
  context.map(set.Console, Keys.Escape, { triggers: [Triggers.Pressed()] });
  context.map(set.NextWeapon, Keys.Digit1, { triggers: [Triggers.Pressed()] });
  context.map(set.PrevWeapon, Keys.Digit2, { triggers: [Triggers.Pressed()] });
  return { actions: set, context };
}

export default InputMappingSystem;
