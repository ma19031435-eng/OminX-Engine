#!/usr/bin/env node
/** Scratch probe for typed data tables: schema validation, CSV/JSON I/O, lazy sources, console. */
import {
  DataRegistry, DataTable, parseCsv, validateField, coerceField,
} from '../../engine/src/core/index.js';
import { Console } from '../../engine/src/core/Console.js';

const WEAPONS = {
  name: 'string', damage: 'u8', rpm: 'u16', spread: 'f32', tags: 'array:string',
};
const registry = new DataRegistry({ name: 'GameData' });
const table = registry.define('Weapons', WEAPONS, { keyField: 'id' });
table.add('rifle', { name: 'Rifle, Mk2', damage: 24, rpm: 600, spread: 0.02, tags: ['primary', 'hitscan'] });
table.add('pistol', { name: 'Pistol', damage: 18, rpm: 300, spread: 0.05, tags: ['sidearm'] });
table.add('shotgun', { name: 'Shotgun', damage: 72, rpm: 90, spread: 0.16, tags: ['primary'] });
console.log('rejected u8 overflow:', table.add('broken', { name: 'Broken', damage: 999, rpm: 1, spread: 0, tags: [] }));
console.log('rows:', table.count, 'validate:', registry.validate());
console.log('query damage>60:', table.query({ where: (row) => row.damage > 60, sort: { field: 'damage', descending: true } }).map((row) => row.id));

const csv = table.toCsv();
console.log('csv:\n' + csv);
const fromCsv = new DataRegistry();
console.log('fromCsv:', fromCsv.loadFromText('Weapons', csv, { format: 'csv', schema: WEAPONS, keyField: 'id' }));
console.log('quoted name restored:', fromCsv.lookup('Weapons', 'rifle').name);
console.log('tags restored:', fromCsv.lookup('Weapons', 'rifle').tags);

const exported = registry.exportAll();
const fromJson = new DataRegistry();
console.log('importAll:', fromJson.importAll(exported), 'row:', fromJson.lookup('Weapons', 'shotgun'));
console.log('diff:', table.clone('Snapshot').diff(fromJson.get('Weapons')));

let loads = 0;
const lazy = new DataRegistry();
lazy.registerSource('Weapons', {
  format: 'csv', schema: WEAPONS, keyField: 'id',
  loader: async () => { loads++; return csv; },
});
console.log('loadAll:', (await lazy.loadAll()).map((entry) => `${entry.name}:${entry.table.count} rows`), 'loader calls:', loads);

console.log('parseCsv quotes:', parseCsv('a,b\n"x,y","he said ""hi"""\n'));
console.log('schema u8:', validateField('u8', 24), validateField('u8', 999), 'coerce:', coerceField('bool', 'yes'));

const console_ = new Console();
registry.installConsoleCommands(console_);
console.log('console data.validate:', console_.exec('data.validate', { silent: true }).output);
console.log('console data.query:', console_.exec('data.query Weapons damage=72', { silent: true }).output);
console.log(registry.format());
console.log(table instanceof DataTable ? 'DataTable export OK' : 'DataTable export MISSING');
