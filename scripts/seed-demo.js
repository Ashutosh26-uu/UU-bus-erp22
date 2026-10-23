/**
 * Demo data: the full 19-bus fleet (buses, stops, incharge accounts) plus ~6 demo students per bus.
 * Usage: npm run seed:demo
 * Safe to re-run: existing buses, users and students are kept.
 */
import { migrate, bootstrapAdmin, get, run, now, tx, closeDb } from '../src/db.js';
import { seedFleet, printFleetSummary, FLEET } from './fleet.js';

migrate();
const boot = bootstrapAdmin();
const created = seedFleet();

const FIRST = ['Aditi', 'Rahul', 'Priya', 'Arjun', 'Sneha', 'Vikram', 'Neha', 'Karan', 'Pooja', 'Rohan', 'Ananya', 'Aman', 'Kavya', 'Yash', 'Ishita', 'Dev', 'Riya', 'Harsh', 'Tanvi', 'Mohit', 'Simran', 'Nikhil', 'Diya', 'Sahil', 'Mansi', 'Kabir', 'Meera', 'Tushar', 'Nandini', 'Parth'];
const LAST = ['Sharma', 'Verma', 'Negi', 'Rawat', 'Bisht', 'Gupta', 'Singh', 'Joshi', 'Thapa', 'Chauhan', 'Kandpal', 'Pant', 'Bhatt', 'Mehta', 'Kohli', 'Saini', 'Bhandari'];
const COURSES = [['B.Tech', ['CSE (AI & ML)', 'CSE', 'ECE', 'Mechanical', 'Civil']], ['BBA', ['Finance', 'Marketing', '']], ['BCA', ['', 'Data Science']], ['B.Sc', ['Agriculture', 'Forestry']], ['MBA', ['HR', 'Finance']], ['B.Pharm', ['']], ['LLB', ['']]];
const YEARS = ['1st', '2nd', '3rd', '4th'];
const PER_BUS = 6;

const t = now();
let students = 0;
tx(() => {
  let n = 0;
  for (const b of FLEET) {
    for (let i = 0; i < PER_BUS; i++, n++) {
      const uuid = `UU2023${['CS', 'BB', 'BC', 'AG', 'MB'][n % 5]}${String(100 + n).padStart(4, '0')}`;
      if (get('SELECT id FROM students WHERE uuid = ?', uuid)) continue;
      const name = `${FIRST[n % FIRST.length]} ${LAST[(n * 7) % LAST.length]}`;
      const [course, specs] = COURSES[n % COURSES.length];
      run(
        'INSERT INTO students(uuid,name,course,year,specialization,bus_id,stop_id,phone,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)',
        uuid, name, course, YEARS[n % YEARS.length], specs[n % specs.length], b.id, b.stopIds[n % b.stopIds.length], `98${String(10000000 + n * 7919).slice(0, 8)}`, t, t,
      );
      students++;
    }
  }
});

printFleetSummary(created, boot);
console.log(`\nDemo students: ${students} new (about ${PER_BUS} per bus, IDs like UU2023CS0100). See Admin > Students.\n`);
closeDb();
