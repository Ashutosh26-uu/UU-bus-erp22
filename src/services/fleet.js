/**
 * The college fleet: 19 buses, each with its own stops, its own portal (/bus/<number>) and its
 * own incharge account (incharge<number>). Names, routes and stops are starting values; admins can
 * edit everything in the console. Used by the admin "Create the 19-bus fleet" button and the seed
 * scripts, against the local SQLite file or Turso.
 */
import { all, batch, now } from '../db.js';
import { hashPassword, generatePassword } from '../security.js';

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
 * Creates any missing bus, stop and incharge account in one atomic batch. Existing rows are left
 * untouched (safe to run again). Returns the new incharges with their temporary passwords (shown
 * once; each must be changed at first sign-in) and the ids of every fleet bus and its stops.
 */
export async function seedFleet() {
  const t = now();
  const [busRows, stopRows, userRows] = await Promise.all([
    all('SELECT number FROM buses'),
    all('SELECT b.number, s.name FROM stops s JOIN buses b ON b.id = s.bus_id'),
    all('SELECT username FROM users'),
  ]);
  const buses = new Set(busRows.map((b) => b.number.toLowerCase()));
  const stops = new Set(stopRows.map((s) => `${s.number.toLowerCase()}|${s.name.toLowerCase()}`));
  const users = new Set(userRows.map((u) => u.username.toLowerCase()));
  const created = { buses: 0, stops: 0, incharges: [], ids: {} };
  const stmts = [];
  for (const b of FLEET) {
    if (!buses.has(b.number.toLowerCase())) {
      stmts.push(['INSERT OR IGNORE INTO buses(number, name, route, active, created_at) VALUES(?, ?, ?, 1, ?)', b.number, b.name, b.route, t]);
      created.buses++;
    }
    b.stops.forEach((name, i) => {
      if (stops.has(`${b.number.toLowerCase()}|${name.toLowerCase()}`)) return;
      stmts.push(['INSERT OR IGNORE INTO stops(bus_id, name, seq) SELECT id, ?, ? FROM buses WHERE number = ?', name, i + 1, b.number]);
      created.stops++;
    });
    const username = `incharge${b.number}`;
    if (!users.has(username)) {
      const password = generatePassword(12);
      stmts.push([
        `INSERT OR IGNORE INTO users(username, name, role, password_hash, bus_id, active, must_change_password, created_at, updated_at)
         SELECT ?, ?, 'incharge', ?, id, 1, 0, ?, ? FROM buses WHERE number = ?`,
        username, `Bus ${b.number} Admin`, hashPassword(password), t, t, b.number,
      ]);
      created.incharges.push({ username, password, bus: b.number });
    }
  }
  await batch(stmts);

  const idRows = await all('SELECT b.id AS bus_id, b.number, s.id AS stop_id FROM buses b LEFT JOIN stops s ON s.bus_id = b.id ORDER BY b.id, s.seq');
  for (const b of FLEET) {
    const mine = idRows.filter((r) => r.number.toLowerCase() === b.number.toLowerCase());
    created.ids[b.number] = { id: mine[0]?.bus_id ?? null, stopIds: mine.filter((r) => r.stop_id != null).map((r) => r.stop_id) };
  }
  return created;
}
