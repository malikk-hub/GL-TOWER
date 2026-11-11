// Loads the plant library (254 entries) and the 8 default towers into an empty database.
// Usage: npm run seed            (existing rows are kept; use --reset to replace towers)
const path = require('path');
const db = require('./db');

async function main() {
  const reset = process.argv.includes('--reset');
  const plants = require(path.join(__dirname, '..', '..', 'db', 'seed', 'plants.json'));
  const towers = require(path.join(__dirname, '..', '..', 'db', 'seed', 'towers.json'));

  for (const p of plants) await db.upsertPlant(p);
  console.log(`plants: ${plants.length} upserted`);

  if (reset) await db.pool.query('DELETE FROM towers');
  let created = 0;
  for (const t of towers) {
    if (await db.towerExists(t.id)) continue;
    await db.createTower({ ...t, substrate: 'hydroponic' });
    created++;
  }
  console.log(`towers: ${created} created (${towers.length - created} already present)`);
  await db.pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
