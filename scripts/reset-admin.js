/**
 * Resets the password of the "admin" user (creating it if missing) and prints the new one.
 * Usage: npm run reset-admin            -> random password
 *        ADMIN_PASSWORD=... npm run reset-admin
 */
import { migrate, get, run, now, closeDb } from '../src/db.js';
import { hashPassword, generatePassword } from '../src/security.js';

migrate();
const password = process.env.ADMIN_PASSWORD || generatePassword(16);
const t = now();
const u = get('SELECT id FROM users WHERE username = ?', 'admin');
if (u) {
  run('UPDATE users SET password_hash = ?, role = ?, active = 1, must_change_password = 1, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', hashPassword(password), 'admin', t, u.id);
  run('DELETE FROM sessions WHERE user_id = ?', u.id);
} else {
  run('INSERT INTO users(username,name,role,password_hash,active,must_change_password,created_at,updated_at) VALUES(?,?,?,?,1,1,?,?)', 'admin', 'Administrator', 'admin', hashPassword(password), t, t);
}
console.log(`\nadmin password reset.\n  username: admin\n  password: ${password}\n(you must change it at first login)\n`);
closeDb();
