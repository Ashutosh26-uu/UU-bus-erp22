/**
 * Script helpers around src/services/fleet.js: seed the 19-bus fleet and save the new incharge
 * passwords to data/incharge-accounts.txt (data/turso-incharge-accounts.txt for Turso).
 */
import fs from 'node:fs';
import { credentialsFile } from '../src/config.js';
import { FLEET, seedFleet as seedFleetCore } from '../src/services/fleet.js';

export { FLEET };

export async function seedFleet() {
  const created = await seedFleetCore();
  created.file = null;
  if (created.incharges.length) {
    created.file = credentialsFile('incharge-accounts.txt');
    const lines = [
      `# UU Bus ERP incharge accounts created ${new Date().toISOString()}`,
      '# Temporary passwords: each incharge must change theirs at first sign-in. Delete this file once distributed.',
      ...created.incharges.map((u) => `bus ${u.bus.padStart(2)}   ${u.username.padEnd(11)} ${u.password}   portal: /bus/${u.bus}`),
      '',
    ];
    fs.appendFileSync(created.file, lines.join('\n') + '\n', { mode: 0o600 });
  }
  return created;
}

export function printFleetSummary(created, boot) {
  console.log(`\nFleet: ${FLEET.length} buses defined · ${created.buses} new bus(es), ${created.stops} new stop(s), ${created.incharges.length} new incharge account(s)`);
  if (boot && !boot.missing) console.log(`\nAdmin created: admin / ${boot.password}   (must change at first login${boot.file ? `; saved to ${boot.file}` : ''})`);
  if (created.incharges.length) {
    console.log('\nIncharge accounts (temporary passwords, forced change at first sign-in):');
    for (const u of created.incharges) console.log(`  bus ${u.bus.padStart(2)}   ${u.username.padEnd(11)} ${u.password}   portal: /bus/${u.bus}`);
    console.log(`\nSaved to ${created.file}`);
  } else {
    console.log('\nAll incharge accounts already existed (passwords unchanged).');
  }
}
