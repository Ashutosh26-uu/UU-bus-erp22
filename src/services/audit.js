import { run, now } from '../db.js';
import { clientIp } from '../http.js';

/**
 * Append an immutable audit entry.
 * @param {import('express').Request|null} req  request (actor is taken from req.user unless actor is given)
 */
export async function audit(req, action, entity = null, entityId = null, details = '', actor = null) {
  const who = actor || req?.user || null;
  await run(
    'INSERT INTO audit_log(actor_id,actor_name,action,entity,entity_id,details,ip,created_at) VALUES(?,?,?,?,?,?,?,?)',
    who?.id ?? null,
    who?.name ?? who?.username ?? null,
    action,
    entity,
    entityId == null ? null : String(entityId),
    typeof details === 'string' ? details : JSON.stringify(details),
    req ? clientIp(req) : null,
    now(),
  );
}
