// Daily per-account quota in D1 (binding "DB"), like ChatGPT's "you've reached your limit" cut-off.
// Limits reset at 00:00 Asia/Bangkok. Owner accounts are exempt. Without DB the quota is not enforced
// (the in-memory burst guard in index.js still applies).

import { historyEnabled, userKey } from './chat-store.js';

export const DEFAULT_LIMITS = { chat: 50, image: 10, site: 2000 };
const LIMIT_ENV = { chat: 'CHAT_DAILY_LIMIT', image: 'IMAGE_DAILY_LIMIT', site: 'SITE_DAILY_LIMIT' };
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function dailyLimit(env, kind) {
  const value = Number(env && env[LIMIT_ENV[kind]]);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_LIMITS[kind];
}

export function quotaDay(now = Date.now()) {
  return new Date(now + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

export function nextReset(now = Date.now()) {
  return (Math.floor((now + BANGKOK_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - BANGKOK_OFFSET_MS;
}

// Atomically adds units unless that would pass the limit. Returns the new total, or null when refused.
async function tryAdd(env, scope, day, units, limit) {
  if (units > limit) return null;
  const row = await env.DB
    .prepare('INSERT INTO usage_counters (scope, day, units) VALUES (?, ?, ?) ON CONFLICT (scope, day) DO UPDATE SET units = usage_counters.units + excluded.units WHERE usage_counters.units + excluded.units <= ? RETURNING units')
    .bind(scope, day, units, limit)
    .first();
  return row ? Number(row.units) : null;
}

async function subtract(env, scope, day, units) {
  await env.DB.prepare('UPDATE usage_counters SET units = MAX(0, units - ?) WHERE scope = ? AND day = ?').bind(units, scope, day).run();
}

async function used(env, scope, day) {
  const row = await env.DB.prepare('SELECT units FROM usage_counters WHERE scope = ? AND day = ?').bind(scope, day).first();
  return row ? Number(row.units) : 0;
}

// Reserves `units` of today's `kind` quota for `identity` (a session or SDK key: provider + id).
// Result: { enforced: false } when not applicable, { ok: false, reason: 'account'|'site', ... } when refused,
// or { ok: true, limit, remaining, resetAt, refund } — call refund() if the request then fails.
export async function takeQuota(env, identity, kind, units, { exempt = false, now = Date.now() } = {}) {
  if (!identity || exempt || !historyEnabled(env)) return { enforced: false, ok: true, refund: async () => {} };
  const day = quotaDay(now);
  const resetAt = nextReset(now);
  const limit = dailyLimit(env, kind);
  const scope = kind + ':' + userKey(identity);
  try {
    const total = await tryAdd(env, scope, day, units, limit);
    if (total === null) return { enforced: true, ok: false, reason: 'account', limit, remaining: Math.max(0, limit - await used(env, scope, day)), resetAt };
    const siteTotal = await tryAdd(env, 'site', day, units, dailyLimit(env, 'site'));
    if (siteTotal === null) {
      await subtract(env, scope, day, units);
      return { enforced: true, ok: false, reason: 'site', limit, remaining: Math.max(0, limit - total + units), resetAt };
    }
    let refunded = false;
    const refund = async () => {
      if (refunded) return;
      refunded = true;
      await Promise.all([subtract(env, scope, day, units), subtract(env, 'site', day, units)]).catch(() => {});
    };
    return { enforced: true, ok: true, limit, remaining: limit - total, resetAt, refund };
  } catch (_) {
    // Storage trouble must not take chat down; the in-memory burst guard still limits abuse.
    return { enforced: false, ok: true, refund: async () => {} };
  }
}

export function quotaHeaders(quota) {
  if (!quota || !quota.enforced) return {};
  return {
    'x-lsuperagen-quota-limit': String(quota.limit),
    'x-lsuperagen-quota-remaining': String(quota.remaining),
    'x-lsuperagen-quota-reset': new Date(quota.resetAt).toISOString()
  };
}

export function quotaMessage(quota, noun) {
  return quota.reason === 'site'
    ? 'ระบบถูกใช้งานครบโควตารวมของวันนี้แล้ว ใช้ได้อีกครั้งหลัง 00:00 น. (เวลาไทย)'
    : 'คุณใช้' + noun + 'ครบ ' + quota.limit + ' ครั้งของวันนี้แล้ว ใช้ได้อีกครั้งหลัง 00:00 น. (เวลาไทย)';
}
