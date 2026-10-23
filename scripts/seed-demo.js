/**
 * Seeds demo data: 3 buses with stops, 2 incharges, ~45 students.
 * Usage: npm run seed:demo
 * Safe to re-run: existing buses/users/students are kept and updated.
 */
import { migrate, bootstrapAdmin, get, run, now, tx, closeDb } from '../src/db.js';
import { hashPassword } from '../src/security.js';

migrate();
const boot = bootstrapAdmin();

const BUSES = [
  { number: '12', name: 'Rajpur Express', route: 'Rajpur Road → Clock Tower → Campus', stops: ['Rajpur Road', 'Sahastradhara Crossing', 'Survey Chowk', 'Clock Tower', 'Prem Nagar'] },
  { number: '7', name: 'Haridwar Line', route: 'Haridwar → Doiwala → Campus', stops: ['Haridwar Bypass', 'Raiwala', 'Doiwala', 'Jolly Grant', 'Kuanwala'] },
  { number: '21', name: 'City Loop', route: 'ISBT → Ballupur → Campus', stops: ['ISBT', 'Ballupur Chowk', 'Vasant Vihar', 'GMS Road'] },
];
const INCHARGES = [
  { username: 'incharge12', name: 'Ramesh Negi', bus: '12', password: 'Incharge12pass' },
  { username: 'incharge7', name: 'Sunita Rawat', bus: '7', password: 'Incharge7pass' },
];
const FIRST = ['Aditi', 'Rahul', 'Priya', 'Arjun', 'Sneha', 'Vikram', 'Neha', 'Karan', 'Pooja', 'Rohan', 'Ananya', 'Aman', 'Kavya', 'Yash', 'Ishita', 'Dev', 'Riya', 'Harsh', 'Tanvi', 'Mohit', 'Simran', 'Nikhil', 'Diya', 'Sahil', 'Mansi'];
const LAST = ['Sharma', 'Verma', 'Negi', 'Rawat', 'Bisht', 'Gupta', 'Singh', 'Joshi', 'Thapa', 'Chauhan', 'Kandpal', 'Pant', 'Bhatt', 'Mehta', 'Kohli'];
const COURSES = [['B.Tech', ['CSE (AI & ML)', 'CSE', 'ECE', 'Mechanical', 'Civil']], ['BBA', ['Finance', 'Marketing', '']], ['BCA', ['', 'Data Science']], ['B.Sc', ['Agriculture', 'Forestry']], ['MBA', ['HR', 'Finance']]];
const YEARS = ['1st', '2nd', '3rd', '4th'];

const t = now();
const summary = { buses: 0, stops: 0, users: 0, students: 0 };
tx(() => {
  for (const b of BUSES) {
    let bus = get('SELECT id FROM buses WHERE number = ?', b.number);
    if (!bus) { bus = { id: run('INSERT INTO buses(number,name,route,active,created_at) VALUES(?,?,?,1,?)', b.number, b.name, b.route, t).lastInsertRowid }; summary.buses++; }
    b.id = bus.id;
    b.stopIds = [];
    b.stops.forEach((name, i) => {
      let s = get('SELECT id FROM stops WHERE bus_id = ? AND name = ?', bus.id, name);
      if (!s) { s = { id: run('INSERT INTO stops(bus_id,name,seq) VALUES(?,?,?)', bus.id, name, i + 1).lastInsertRowid }; summary.stops++; }
      b.stopIds.push(s.id);
    });
  }
  for (const u of INCHARGES) {
    const bus = BUSES.find((b) => b.number === u.bus);
    if (!get('SELECT id FROM users WHERE username = ?', u.username)) {
      run('INSERT INTO users(username,name,role,password_hash,bus_id,active,must_change_password,created_at,updated_at) VALUES(?,?,?,?,?,1,0,?,?)', u.username, u.name, 'incharge', hashPassword(u.password), bus.id, t, t);
      summary.users++;
    }
  }
  let n = 0;
  for (const b of BUSES) {
    const count = b.number === '12' ? 18 : b.number === '7' ? 15 : 12;
    for (let i = 0; i < count; i++, n++) {
      const uuid = `UU2023${['CS', 'BB', 'BC', 'AG', 'MB'][n % 5]}${String(100 + n).padStart(4, '0')}`;
      if (get('SELECT id FROM students WHERE uuid = ?', uuid)) continue;
      const name = `${FIRST[n % FIRST.length]} ${LAST[(n * 7) % LAST.length]}`;
      const [course, specs] = COURSES[n % COURSES.length];
      const spec = specs[n % specs.length];
      const year = YEARS[n % YEARS.length];
      const stopId = b.stopIds[n % b.stopIds.length];
      run('INSERT INTO students(uuid,name,course,year,specialization,bus_id,stop_id,phone,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)', uuid, name, course, year, spec, b.id, stopId, `98${String(10000000 + n * 7919).slice(0, 8)}`, t, t);
      summary.students++;
    }
  }
});

console.log('\nDemo data ready:', summary);
console.log('\nSign-in accounts');
if (boot) console.log(`  admin       / ${boot.password}   (must change at first login)`);
else console.log('  admin       / (existing password; run "npm run reset-admin" if lost)');
for (const u of INCHARGES) console.log(`  ${u.username.padEnd(11)} / ${u.password}   (bus ${u.bus})`);
console.log('\nSample student IDs: UU2023CS0100, UU2023BB0101, UU2023BC0102 ... (see Admin > Students)\n');
closeDb();
