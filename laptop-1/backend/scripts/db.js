// Database setup commands.
//
//   npm run db:init        create/refresh all indexes
//   npm run db:seed        demo station, 4 chargers, 5 vehicle profiles (isDemo)
//   npm run db:import-csv  import Data/ev_charging_patterns.csv as historical sessions
//   npm run db:setup       all three
import '../src/loadEnv.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { loadConfig } from '../src/config.js';
import { importCsv } from '../src/db/importCsv.js';
import { seedDemo } from '../src/db/seed.js';
import * as models from '../src/models/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CSV = process.env.CHARGING_CSV || path.resolve(here, '../../../Data/ev_charging_patterns.csv');
const steps = process.argv.slice(2);

const config = loadConfig();
await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
console.log(`connected to ${mongoose.connection.host}/${mongoose.connection.name}`);

try {
  if (steps.includes('init')) {
    for (const [name, Model] of Object.entries(models)) {
      if (!Model?.syncIndexes) continue;
      await Model.syncIndexes();
      const idx = await Model.collection.indexes();
      console.log(`  ${Model.collection.collectionName.padEnd(18)} ${idx.map((i) => i.name).join(', ')}`);
    }
  }
  if (steps.includes('seed')) {
    console.log('seeded', await seedDemo(config.stationId));
  }
  if (steps.includes('import-csv')) {
    console.log(`importing ${CSV}`);
    console.log('imported', await importCsv(CSV));
  }
} finally {
  await mongoose.disconnect();
}
