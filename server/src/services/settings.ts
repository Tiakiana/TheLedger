import { writeAudit } from './audit.js';
import type { Actor, Ctx } from './context.js';

export function getSetting(ctx: Ctx, key: string): string | null {
  return ctx.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
}

export function getApprovalRequired(ctx: Ctx): boolean {
  return getSetting(ctx, 'approval_required') === 'true';
}

/** Server-wide switch for mandatory recipient approval. Applies to donations whose cancellation window ends after the change. */
export function setApprovalRequired(ctx: Ctx, actor: Actor, value: boolean): void {
  ctx.tx(() => {
    const before = getApprovalRequired(ctx);
    if (before === value) return;
    ctx.db.run(
      "INSERT INTO settings (key, value) VALUES ('approval_required', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      value ? 'true' : 'false',
    );
    writeAudit(ctx, {
      category: 'gm',
      action: 'gm.settings.approval',
      actor,
      summary: `Recipient approval ${value ? 'enabled' : 'disabled'}`,
      details: { before, after: value },
    });
    ctx.emit((s) => s.changed([], { gm: true, catalog: true }));
  });
}
