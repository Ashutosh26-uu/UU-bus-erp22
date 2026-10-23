/**
 * Resets the password of the "admin" user (creating it if missing) and prints the new one.
 * Usage: npm run reset-admin            -> random password
 *        ADMIN_PASSWORD=... npm run reset-admin
 * For Turso / Vercel: set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN first.
 */
import { migrate, get, batch, run, now, closeDb, dbKind } from '../src/db.js';
import { hashPassword, generatePassword } from '../src/security.js';

console.log(`Database: ${dbKind()}`);
await migrate();
const password = process.env.ADMIN_PASSWORD || generatePassword(16);
const t = now();
const u = await get('SELECT id FROM users WHERE username = ?', 'admin');
if (u) {
  await batch([
    ['UPDATE users SET password_hash = ?, role = ?, active = 1, must_change_password = 1, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', hashPassword(password), 'admin', t, u.id],
    ['DELETE FROM sessions WHERE user_id = ?', u.id],
  ]);
} else {
  await run('INSERT INTO users(username,name,role,password_hash,active,must_change_password,created_at,updated_at) VALUES(?,?,?,?,1,1,?,?)', 'admin', 'Administrator', 'admin', hashPassword(password), t, t);
}
console.log(`\nadmin password reset.\n  username: admin\n  password: ${password}\n(you must change it at first login)\n`);
await closeDb();
