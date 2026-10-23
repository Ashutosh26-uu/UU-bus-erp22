/**
 * The college fleet: 19 buses, each with its own stops, its own portal (/bus/<number>) and its
 * own incharge account (incharge<number>). Used by seed-buses.js and seed-demo.js.
 * Names, routes and stops are starting values; admins can edit everything in the console.
 */
import fs from 'node:fs';
import path from 'node:path';
import { get, run, now, tx } from '../src/db.js';
import { config } from '../src/config.js';
import { hashPassword, generatePassword } from '../src/security.js';

export const FLEET = [
  { number: '1', name: 'Rajpur Line', route: 'Rajpur Road → Survey Chowk → Clock Tower → Campus', stops: ['Rajpur Road', 'Sahastradhara Crossing', 'Survey Chowk', 'Clock Tower', 'Prem Nagar'] },
  { number: '2', name: 'Haridwar Line', route: 'Haridwar Bypass → Doiwala → Campus', stops: ['Haridwar Bypass', 'Raiwala', 'Doiwala', 'Jolly Grant', 'Kuanwala'] },
  { number: '3', name: 'City Loop', route: 'ISBT → Ballupur → GMS Road → Campus', stops: ['ISBT', 'Ballupur Chowk', 'Vasant Vihar', 'GMS Road'] },
  { number: '4', name: 'Rishikesh Line', route: 'Rishikesh → Raiwala → Doiwala → Campus', stops: ['Rishikesh', 'Shyampur', 'Raiwala', 'Lal Tappar', 'Doiwala'] },
  { number: '5', name: 'Mussoorie Road', route: 'Library Chowk → Jakhan → Dilaram → Campus', stops: ['Library Chowk', 'Jakhan', 'Canal Road', 'Dilaram Chowk'] },
  { number: '6', name: 'Selaqui Line', route: 'Selaqui → Sudhowala → Prem Nagar → Campus', stops: ['Selaqui', 'Sudhowala', 'Nanda Ki Chowki', 'Prem Nagar'] },
  { number: '7', name: 'Herbertpur Line', route: 'Herbertpur → Vikasnagar → Selaqui → Campus', stops: ['Herbertpur', 'Vikasnagar', 'Sahaspur', 'Selaqui'] },
  { number: '8', name: 'Clement Town', route: 'Clement Town → Subhash Nagar → ISBT → Campus', stops: ['Clement Town', 'Subhash Nagar', 'Mohabewala', 'ISBT'] },
  { number: '9', name: 'Raipur Line', route: 'Raipur → Nehru Colony → Rispana → Campus', stops: ['Raipur', 'Ladpur', 'Nehru Colony', 'Rispana Pul'] },
  { number: '10', name: 'Sahastradhara', route: 'Sahastradhara → IT Park → Campus', stops: ['Sahastradhara', 'IT Park', 'Kulhan', 'Nalapani'] },
  { number: '11', name: 'Patel Nagar', route: 'Patel Nagar → Saharanpur Chowk → Campus', stops: ['Patel Nagar', 'Lal Pul', 'Saharanpur Chowk', 'Railway Station'] },
  { number: '12', name: 'Rajpur Express', route: 'Rajpur Road → Pacific Mall → Jakhan → Campus', stops: ['Rajpur Road', 'Pacific Mall', 'Kishanpur', 'Jakhan', 'Dilaram Chowk'] },
  { number: '13', name: 'Haridwar Express', route: 'Haridwar → Bahadarabad → Doiwala → Campus', stops: ['Haridwar', 'Bahadarabad', 'Roorkee Road', 'Doiwala'] },
  { number: '14', name: 'Prem Nagar Line', route: 'Prem Nagar → Ballupur → Panditwari → Campus', stops: ['Prem Nagar', 'Nanda Ki Chowki', 'Ballupur', 'Panditwari'] },
  { number: '15', name: 'Mohkampur Line', route: 'Mohkampur → Harrawala → Kuanwala → Campus', stops: ['Mohkampur', 'Miyawala', 'Harrawala', 'Kuanwala'] },
  { number: '16', name: 'Dharampur Line', route: 'Dharampur → EC Road → Race Course → Campus', stops: ['Dharampur', 'Araghar', 'EC Road', 'Race Course'] },
  { number: '17', name: 'Dehrakhas Line', route: 'Dehrakhas → Kargi Chowk → Majra → Campus', stops: ['Dehrakhas', 'Kargi Chowk', 'Banjarawala', 'Majra'] },
  { number: '18', name: 'Roorkee Line', route: 'Roorkee → Bhagwanpur → Biharigarh → Campus', stops: ['Roorkee', 'Bhagwanpur', 'Chhutmalpur', 'Biharigarh'] },
  { number: '19', name: 'Vikasnagar Express', route: 'Vikasnagar → Sahaspur → Sudhowala → Campus', stops: ['Vikasnagar', 'Sahaspur', 'Sudhowala', 'Nanda Ki Chowki'] },
];

/**
 * Creates any missing bus, stop and incharge account. Existing rows are left untouched, so it is
 * safe to run again. New incharge passwords are written to data/incharge-accounts.txt and must be
 * changed at first sign-in.
 */
export function seedFleet() {
  const t = now();
  const created = { buses: 0, stops: 0, incharges: [], file: null };
  tx(() => {
    for (const b of FLEET) {
      let bus = get('SELECT id FROM buses WHERE number = ?', b.number);
      if (!bus) {
        bus = { id: run('INSERT INTO buses(number,name,route,active,created_at) VALUES(?,?,?,1,?)', b.number, b.name, b.route, t).lastInsertRowid };
        created.buses++;
      }
      b.id = bus.id;
      b.stopIds = [];
      b.stops.forEach((name, i) => {
        let s = get('SELECT id FROM stops WHERE bus_id = ? AND name = ?', bus.id, name);
        if (!s) {
          s = { id: run('INSERT INTO stops(bus_id,name,seq) VALUES(?,?,?)', bus.id, name, i + 1).lastInsertRowid };
          created.stops++;
        }
        b.stopIds.push(s.id);
      });
      const username = `incharge${b.number}`;
      if (!get('SELECT id FROM users WHERE username = ?', username)) {
        const password = generatePassword(12);
        run(
          'INSERT INTO users(username,name,role,password_hash,bus_id,active,must_change_password,created_at,updated_at) VALUES(?,?,?,?,?,1,1,?,?)',
          username, `Incharge Bus ${b.number}`, 'incharge', hashPassword(password), bus.id, t, t,
        );
        created.incharges.push({ username, password, bus: b.number });
      }
    }
  });
  if (created.incharges.length) {
    created.file = path.join(config.dataDir, 'incharge-accounts.txt');
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
  if (boot) console.log(`\nAdmin created: admin / ${boot.password}   (must change at first login; saved to ${boot.file})`);
  if (created.incharges.length) {
    console.log('\nIncharge accounts (temporary passwords, forced change at first sign-in):');
    for (const u of created.incharges) console.log(`  bus ${u.bus.padStart(2)}   ${u.username.padEnd(11)} ${u.password}   portal: /bus/${u.bus}`);
    console.log(`\nSaved to ${created.file}`);
  } else {
    console.log('\nAll incharge accounts already existed (passwords unchanged).');
  }
}
