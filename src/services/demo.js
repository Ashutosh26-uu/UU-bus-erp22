/**
 * Dummy students for trying the system out (Admin → Students → Add demo students).
 * Every demo ID starts with "DEMO-" (e.g. DEMO-12-3 = bus 12, student 3) so demo data can never
 * collide with real student IDs and can be removed again in one click.
 */
import { all, get, batchChunks, now } from '../db.js';

const FIRST = ['Aditi', 'Rahul', 'Priya', 'Arjun', 'Sneha', 'Vikram', 'Neha', 'Karan', 'Pooja', 'Rohan', 'Ananya', 'Aman', 'Kavya', 'Yash', 'Ishita', 'Dev', 'Riya', 'Harsh', 'Tanvi', 'Mohit', 'Simran', 'Nikhil', 'Diya', 'Sahil', 'Mansi', 'Kabir', 'Meera', 'Tushar', 'Nandini', 'Parth'];
const LAST = ['Sharma', 'Verma', 'Negi', 'Rawat', 'Bisht', 'Gupta', 'Singh', 'Joshi', 'Thapa', 'Chauhan', 'Kandpal', 'Pant', 'Bhatt', 'Mehta', 'Kohli', 'Saini', 'Bhandari'];
const COURSES = [['B.Tech', ['CSE (AI & ML)', 'CSE', 'ECE', 'Mechanical', 'Civil']], ['BBA', ['Finance', 'Marketing', '']], ['BCA', ['', 'Data Science']], ['B.Sc', ['Agriculture', 'Forestry']], ['MBA', ['HR', 'Finance']], ['B.Pharm', ['']], ['LLB', ['']]];
const YEARS = ['1st', '2nd', '3rd', '4th'];
export const DEMO_PREFIX = 'DEMO-';

/** Adds `perBus` demo students to every active bus (spread over its stops). Safe to repeat. */
export async function addDemoStudents(perBus = 6) {
  const [buses, stops] = await Promise.all([
    all('SELECT id, number FROM buses WHERE active = 1 ORDER BY CAST(number AS INTEGER), number'),
    all('SELECT id, bus_id FROM stops ORDER BY bus_id, seq, id'),
  ]);
  if (!buses.length) return { inserted: 0, buses: 0, perBus };
  const t = now();
  const stmts = [];
  let n = 0;
  for (const b of buses) {
    const busStops = stops.filter((s) => s.bus_id === b.id);
    for (let k = 1; k <= perBus; k++, n++) {
      const [course, specs] = COURSES[n % COURSES.length];
      stmts.push([
        `INSERT OR IGNORE INTO students(uuid, name, course, year, specialization, bus_id, stop_id, phone, active, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, '', 1, ?, ?)`,
        `${DEMO_PREFIX}${b.number}-${k}`.toUpperCase(),
        `${FIRST[n % FIRST.length]} ${LAST[(n * 7) % LAST.length]}`,
        course, YEARS[n % YEARS.length], specs[n % specs.length],
        b.id, busStops.length ? busStops[(k - 1) % busStops.length].id : null, t, t,
      ]);
    }
  }
  const results = await batchChunks(stmts);
  return { inserted: results.reduce((s, r) => s + r.changes, 0), buses: buses.length, perBus };
}

/** Removes every demo student together with their boardings and phone links. */
export async function removeDemoStudents() {
  const like = `${DEMO_PREFIX}%`;
  const count = (await get('SELECT COUNT(*) AS c FROM students WHERE uuid LIKE ?', like)).c;
  if (!count) return { removed: 0 };
  await batchChunks([
    ['DELETE FROM checkins WHERE student_id IN (SELECT id FROM students WHERE uuid LIKE ?)', like],
    ['UPDATE devices SET student_id = NULL, bound_at = NULL WHERE student_id IN (SELECT id FROM students WHERE uuid LIKE ?)', like],
    ['UPDATE checkin_sessions SET student_id = NULL WHERE student_id IN (SELECT id FROM students WHERE uuid LIKE ?)', like],
    ['DELETE FROM students WHERE uuid LIKE ?', like],
  ]);
  return { removed: count };
}
