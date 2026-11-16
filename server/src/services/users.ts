import { DUMMY_HASH, generatePassword, hashPassword, hashToken, newSessionToken, verifyPassword } from '../auth.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import type { PlayerAdminDTO, SessionUser } from '../shared/types.js';
import * as v from '../validate.js';
import { writeAudit } from './audit.js';
import { newId, type Actor, type Ctx } from './context.js';
import { requireRole } from './inventory.js';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  is_gm: number;
  disabled: number;
  created_at: number;
  updated_at: number;
}

function requireUser(ctx: Ctx, id: string): UserRow {
  const u = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw notFound('That player does not exist.');
  return u;
}

export function sessionUser(ctx: Ctx, userId: string): SessionUser | null {
  const r = ctx.db.get<{ id: string; username: string; is_gm: number; disabled: number; role_id: string | null; role_name: string | null }>(
    `SELECT u.id, u.username, u.is_gm, u.disabled, r.id AS role_id, r.name AS role_name
       FROM users u LEFT JOIN role_assignments a ON a.user_id = u.id LEFT JOIN roles r ON r.id = a.role_id
      WHERE u.id = ?`,
    userId,
  );
  if (!r || r.disabled) return null;
  return { id: r.id, username: r.username, isGm: r.is_gm === 1, roleId: r.role_id, roleName: r.role_name };
}

export const actorOf = (u: SessionUser): Actor => ({ userId: u.id, username: u.username, isGm: u.isGm });

/** Creates the initial GM account on first start. Returns the generated password if one was generated. */
export function ensureGm(ctx: Ctx): { username: string; password: string | null; created: boolean } {
  const existing = ctx.db.get<{ username: string }>('SELECT username FROM users WHERE is_gm = 1 LIMIT 1');
  if (existing) return { username: existing.username, password: null, created: false };
  const username = v.username(ctx.config.gmUsername);
  const password = ctx.config.gmPassword ?? generatePassword(14);
  ctx.tx(() => {
    const now = ctx.now();
    ctx.db.run('INSERT INTO users (id, username, password_hash, is_gm, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)', newId(), username, hashPassword(password), now, now);
    writeAudit(ctx, { category: 'system', action: 'system.gm-created', actor: null, summary: `Initial GM account "${username}" created` });
  });
  return { username, password: ctx.config.gmPassword ? null : password, created: true };
}

export function login(ctx: Ctx, usernameInput: unknown, passwordInput: unknown): { token: string; user: SessionUser } {
  if (typeof usernameInput !== 'string' || typeof passwordInput !== 'string' || !usernameInput.trim() || !passwordInput) {
    throw badRequest('Enter your username and password.');
  }
  const u = ctx.db.get<UserRow>('SELECT * FROM users WHERE username = ?', usernameInput.trim());
  const ok = verifyPassword(passwordInput, u?.password_hash ?? DUMMY_HASH) && !!u;
  if (!u || !ok) {
    ctx.tx(() =>
      writeAudit(ctx, {
        category: 'auth',
        action: 'auth.login-failed',
        actor: u ? { userId: u.id, username: u.username, isGm: u.is_gm === 1 } : null,
        summary: `Failed login for "${usernameInput.trim().slice(0, 40)}"`,
      }),
    );
    throw unauthorized('Incorrect username or password.');
  }
  if (u.disabled) throw forbidden('This account has been disabled by the GM.');
  const token = newSessionToken();
  const now = ctx.now();
  ctx.tx(() => {
    ctx.db.run('DELETE FROM sessions WHERE expires_at <= ?', now);
    ctx.db.run(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      hashToken(token),
      u.id,
      now,
      now + ctx.config.sessionTtlHours * 3_600_000,
    );
    writeAudit(ctx, { category: 'auth', action: 'auth.login', actor: { userId: u.id, username: u.username, isGm: u.is_gm === 1 }, summary: `${u.username} logged in` });
  });
  return { token, user: sessionUser(ctx, u.id)! };
}

export function userFromToken(ctx: Ctx, token: string | undefined): SessionUser | null {
  if (!token) return null;
  const s = ctx.db.get<{ user_id: string; expires_at: number; created_at: number }>('SELECT user_id, expires_at, created_at FROM sessions WHERE token_hash = ?', hashToken(token));
  if (!s) return null;
  const now = ctx.now();
  if (s.expires_at <= now) return null;
  // Sliding expiry: extend active sessions once half their lifetime has passed.
  const ttl = ctx.config.sessionTtlHours * 3_600_000;
  if (s.expires_at - now < ttl / 2) ctx.db.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', now + ttl, hashToken(token));
  return sessionUser(ctx, s.user_id);
}

export function logout(ctx: Ctx, token: string | undefined): void {
  if (token) ctx.db.run('DELETE FROM sessions WHERE token_hash = ?', hashToken(token));
}

function revokeSessions(ctx: Ctx, userId: string): void {
  ctx.db.run('DELETE FROM sessions WHERE user_id = ?', userId);
  ctx.emit((s) => s.userRevoked(userId));
}

export function changeOwnPassword(ctx: Ctx, actor: Actor, current: unknown, next: unknown, keepToken?: string): void {
  const pw = v.password(next);
  ctx.tx(() => {
    const u = requireUser(ctx, actor.userId);
    if (typeof current !== 'string' || !verifyPassword(current, u.password_hash)) throw badRequest('Your current password is incorrect.');
    ctx.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(pw), ctx.now(), u.id);
    // Sign out other devices but keep this session.
    ctx.db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', u.id, keepToken ? hashToken(keepToken) : '');
    writeAudit(ctx, { category: 'auth', action: 'auth.password-changed', actor, summary: `${u.username} changed their password` });
  });
}

// ---------- GM: player management ----------

function toAdminDTO(r: UserRow & { role_id: string | null; role_name: string | null }): PlayerAdminDTO {
  return { id: r.id, username: r.username, isGm: r.is_gm === 1, disabled: r.disabled === 1, roleId: r.role_id, roleName: r.role_name, createdAt: r.created_at };
}

export function listPlayers(ctx: Ctx, q?: string): PlayerAdminDTO[] {
  const like = q ? `%${q.replace(/[%_\\]/g, '\\$&')}%` : null;
  return ctx.db
    .all<UserRow & { role_id: string | null; role_name: string | null }>(
      `SELECT u.*, r.id AS role_id, r.name AS role_name
         FROM users u LEFT JOIN role_assignments a ON a.user_id = u.id LEFT JOIN roles r ON r.id = a.role_id
        ${like ? "WHERE u.username LIKE ? ESCAPE '\\'" : ''}
        ORDER BY u.is_gm DESC, u.username COLLATE NOCASE`,
      ...(like ? [like] : []),
    )
    .map(toAdminDTO);
}

function getPlayerDTO(ctx: Ctx, id: string): PlayerAdminDTO {
  return listPlayers(ctx).find((p) => p.id === id)!;
}

export function createPlayer(ctx: Ctx, actor: Actor, input: { username?: unknown; password?: unknown; roleId?: unknown }): PlayerAdminDTO {
  const username = v.username(input.username);
  const password = v.password(input.password);
  const roleId = input.roleId ? v.id(input.roleId, 'Role') : null;
  const id = newId();
  ctx.tx(() => {
    if (ctx.db.get('SELECT 1 FROM users WHERE username = ?', username)) throw conflict(`The username "${username}" is already taken.`);
    const now = ctx.now();
    ctx.db.run('INSERT INTO users (id, username, password_hash, is_gm, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)', id, username, hashPassword(password), now, now);
    writeAudit(ctx, { category: 'gm', action: 'gm.player.created', actor, summary: `Created player account "${username}"`, details: { userId: id } });
    if (roleId) assignInTx(ctx, actor, id, roleId);
    ctx.emit((s) => s.changed([], { gm: true }));
  });
  return getPlayerDTO(ctx, id);
}

export function updatePlayer(ctx: Ctx, actor: Actor, id: string, input: { username?: unknown; disabled?: unknown }): PlayerAdminDTO {
  ctx.tx(() => {
    const u = requireUser(ctx, id);
    if (input.username !== undefined) {
      const username = v.username(input.username);
      if (username !== u.username) {
        const clash = ctx.db.get<{ id: string }>('SELECT id FROM users WHERE username = ?', username);
        if (clash && clash.id !== id) throw conflict(`The username "${username}" is already taken.`);
        ctx.db.run('UPDATE users SET username = ?, updated_at = ? WHERE id = ?', username, ctx.now(), id);
        writeAudit(ctx, { category: 'gm', action: 'gm.player.renamed', actor, summary: `Renamed player "${u.username}" to "${username}"`, details: { userId: id } });
        ctx.emit((s) => s.userChanged(id));
      }
    }
    if (input.disabled !== undefined) {
      const disabled = v.bool(input.disabled, 'Disabled');
      if (u.is_gm && disabled) throw badRequest('The GM account cannot be disabled.');
      if (disabled !== (u.disabled === 1)) {
        ctx.db.run('UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?', disabled, ctx.now(), id);
        if (disabled) revokeSessions(ctx, id);
        writeAudit(ctx, {
          category: 'gm',
          action: disabled ? 'gm.player.disabled' : 'gm.player.enabled',
          actor,
          summary: `${disabled ? 'Disabled' : 'Re-enabled'} player "${u.username}"`,
          details: { userId: id },
        });
      }
    }
    ctx.emit((s) => s.changed([], { gm: true }));
  });
  return getPlayerDTO(ctx, id);
}

export function resetPassword(ctx: Ctx, actor: Actor, id: string, passwordInput: unknown): void {
  const password = v.password(passwordInput);
  ctx.tx(() => {
    const u = requireUser(ctx, id);
    ctx.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(password), ctx.now(), id);
    if (id !== actor.userId) revokeSessions(ctx, id);
    writeAudit(ctx, { category: 'gm', action: 'gm.player.password-reset', actor, summary: `Issued a new password for "${u.username}"`, details: { userId: id } });
  });
}

function assignInTx(ctx: Ctx, actor: Actor, userId: string, roleId: string | null): void {
  const u = requireUser(ctx, userId);
  if (u.is_gm) throw badRequest('The GM account cannot be assigned to a role.');
  const before = ctx.db.get<{ role_id: string; name: string }>('SELECT a.role_id, r.name FROM role_assignments a JOIN roles r ON r.id = a.role_id WHERE a.user_id = ?', userId);
  if ((before?.role_id ?? null) === roleId) return;
  if (roleId === null) {
    ctx.db.run('DELETE FROM role_assignments WHERE user_id = ?', userId);
    writeAudit(ctx, {
      category: 'gm',
      action: 'gm.player.unassigned',
      actor,
      role: before ? { id: before.role_id, name: before.name } : null,
      summary: `Unassigned "${u.username}" from ${before?.name ?? 'their role'}`,
      details: { userId },
    });
  } else {
    const role = requireRole(ctx, roleId);
    // user_id is the primary key: a player can only ever hold one role.
    ctx.db.run(
      'INSERT INTO role_assignments (user_id, role_id, assigned_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET role_id = excluded.role_id, assigned_at = excluded.assigned_at',
      userId,
      roleId,
      ctx.now(),
    );
    writeAudit(ctx, {
      category: 'gm',
      action: 'gm.player.assigned',
      actor,
      role: { id: role.id, name: role.name },
      counterparty: before ? { id: before.role_id, name: before.name } : null,
      summary: `Assigned "${u.username}" to ${role.name}${before ? ` (previously ${before.name})` : ''}`,
      details: { userId },
    });
  }
  const touched = [before?.role_id, roleId].filter((x): x is string => !!x);
  ctx.emit((s) => {
    s.userChanged(userId);
    s.changed(touched, { gm: true });
  });
}

export function assignRole(ctx: Ctx, actor: Actor, userId: string, roleId: string | null): PlayerAdminDTO {
  ctx.tx(() => assignInTx(ctx, actor, userId, roleId));
  return getPlayerDTO(ctx, userId);
}

export function deletePlayer(ctx: Ctx, actor: Actor, id: string): void {
  ctx.tx(() => {
    const u = requireUser(ctx, id);
    if (u.is_gm) throw badRequest('The GM account cannot be deleted.');
    const role = ctx.db.get<{ id: string; name: string }>('SELECT r.id, r.name FROM role_assignments a JOIN roles r ON r.id = a.role_id WHERE a.user_id = ?', id);
    revokeSessions(ctx, id);
    ctx.db.run('DELETE FROM users WHERE id = ?', id);
    writeAudit(ctx, {
      category: 'gm',
      action: 'gm.player.deleted',
      actor,
      role: role ?? null,
      summary: `Deleted player account "${u.username}"`,
      details: { userId: id },
    });
    ctx.emit((s) => s.changed(role ? [role.id] : [], { gm: true }));
  });
}

export function setGmPassword(ctx: Ctx, username: string | null, password: string): string {
  const pw = v.password(password);
  return ctx.tx(() => {
    const gm = username
      ? ctx.db.get<UserRow>('SELECT * FROM users WHERE username = ? AND is_gm = 1', username)
      : ctx.db.get<UserRow>('SELECT * FROM users WHERE is_gm = 1 ORDER BY created_at LIMIT 1');
    if (!gm) throw notFound('No GM account found.');
    ctx.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(pw), ctx.now(), gm.id);
    ctx.db.run('DELETE FROM sessions WHERE user_id = ?', gm.id);
    writeAudit(ctx, { category: 'system', action: 'system.gm-password-reset', actor: null, summary: `GM password for "${gm.username}" reset from the command line` });
    return gm.username;
  });
}
