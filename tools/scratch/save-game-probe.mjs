#!/usr/bin/env node
/** Scratch probe for SaveGame: atomicity, recovery, migrations, autosave cadence and rotation. */
import { SaveSystem, SaveStorage, SaveGame, saveEvents, checksumOf, reviveSavedValue } from '../../engine/src/core/SaveGame.js';
import { TimerManager } from '../../engine/src/core/TimerManager.js';
import { Console } from '../../engine/src/core/Console.js';

const storage = SaveStorage.memory();
const timers = new TimerManager();
const saves = new SaveSystem({ storage, timerManager: timers, version: 3, prefix: 'probe', backupSlots: 1 });

saves.registerSection('progress', { level: 'u8', score: 'u32', unlocked: 'array:string' });
saves.migrate(1, (save) => { save.patch('progress', { coins: (save.get('progress')?.coins ?? 1) * 10 }); });
saves.migrate(2, (save) => { save.patch('progress', { level: 1, progress: { level: 1 } }); });

const written = saves.write('profile', new SaveGame({
  slot: 'profile', version: 3,
  sections: { progress: { level: 4, score: 12900, unlocked: ['rifle', 'smg'] } },
  metadata: { player: 'Raven', map: 'arena' },
}));
console.log('write:', written?.describe());
console.log('read:', saves.read('profile')?.get('progress'));
console.log('revive:', reviveSavedValue({ a: { __type: 'Map', entries: [['x', 1]] }, b: { __type: 'Set', values: [1, 2] } }));
console.log('checksum stable:', checksumOf('abc') === checksumOf('abc'));

// Corrupt the primary and confirm the backup recovers.
const key = saves.keyFor('profile');
const tampered = JSON.parse(storage.read(key));
tampered.payload = tampered.payload.replace('rifle', 'pistol');
storage.write(key, JSON.stringify(tampered));
const recovered = saves.read('profile');
console.log('recovery:', recovered?.get('progress'), 'corruptCount:', saves.corruptCount);

console.log('format():', typeof saves.format === 'function' ? saves.format().split('\n')[0] : `BROKEN (${typeof saves.format})`);
const console_ = new Console();
saves.installConsoleCommands(console_);
console.log('console save:', console_.exec('save', { silent: true }));

// Autosave cadence: 5 s interval over 16 s should fire exactly three times.
let autosaves = 0;
const onAuto = () => { autosaves++; };
saveEvents.onAutosave.add(onAuto);
timers.clearAll();
const auto = saves.enableAutosave({
  slot: 'auto', intervalSeconds: 5, keep: 3,
  collect: () => ({
    progress: {
      level: 4, score: Math.round(timers.time * 100), unlocked: ['rifle'],
      tick: Math.round(timers.time * 60), map: 'arena',
    },
  }),
});
console.log('autosave handle:', !!auto);
for (let i = 0; i < 16 * 60; i++) timers.advance(1 / 60);
console.log('autosaves in 16s:', autosaves, 'timer fires:', timers.getFiredCount(auto));
const allKeys = storage.keys().filter((k) => k.startsWith('probe.save.')).sort();
const keys = allKeys.filter((k) => !saves.isInternalKey(k));
console.log('keys:', keys, 'internal:', allKeys.filter((k) => saves.isInternalKey(k)));
for (const k of keys) {
  const slot = k.slice('probe.save.'.length);
  const read = saves.read(slot);
  console.log('  ', slot, '->', read ? `slot=${read.slot} tick=${read.get('progress')?.tick}` : `NULL (${saves.lastError?.message})`);
}
console.log('list():', saves.list().map((r) => `${r.slot}:${r.exists}`));
console.log('describe():', saves.describe());
