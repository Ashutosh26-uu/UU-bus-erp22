/**
 * Real setup: creates the 19-bus fleet (buses, stops, one incharge account per bus) without any
 * demo students. Usage: npm run seed:buses
 * For Turso / Vercel: set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (in .env or the shell) first.
 */
import { migrate, bootstrapAdmin, closeDb, dbKind } from '../src/db.js';
import { seedFleet, printFleetSummary } from './fleet.js';

console.log(`Database: ${dbKind()}`);
await migrate();
const boot = await bootstrapAdmin({ writeFile: true });
const created = await seedFleet();
printFleetSummary(created, boot);
console.log('\nNext: import students from Admin > Students > Import CSV (bus column = bus number 1-19).\n');
await closeDb();
