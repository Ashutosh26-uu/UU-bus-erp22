/**
 * Real setup: creates the 19-bus fleet (buses, stops, one incharge account per bus) without any
 * demo students. Usage: npm run seed:buses
 */
import { migrate, bootstrapAdmin, closeDb } from '../src/db.js';
import { seedFleet, printFleetSummary } from './fleet.js';

migrate();
const boot = bootstrapAdmin();
const created = seedFleet();
printFleetSummary(created, boot);
console.log('\nNext: import students from Admin > Students > Import CSV (bus column = bus number 1-19).\n');
closeDb();
