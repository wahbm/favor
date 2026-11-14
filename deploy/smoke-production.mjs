// Runs as the favor service user with its existing environment. Never logs credentials.
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
const origin = new URL(process.env.APP_ORIGIN).origin;
const username = 'verify_' + randomBytes(10).toString('hex');
const password = randomBytes(32).toString('base64url');
const server = 'http://127.0.0.1:' + (process.env.PORT || '3001');
let cookie = '',
  csrf = '',
  userId = '';
const db = await mysql.createConnection(process.env.DATABASE_URL);
async function request(path, method = 'GET', body) {
  const response = await fetch(server + '/api' + path, {
    method,
    headers: {
      origin,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      ...(cookie ? { cookie } : {}),
    },
    ...(method !== 'GET' ? { body: JSON.stringify(body || {}) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const setCookie = response.headers.getSetCookie()[0];
  if (setCookie) cookie = setCookie.split(';')[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
  if (data.csrf) csrf = data.csrf;
  return data;
}
try {
  const auth = await request('/auth/register', 'POST', { username, password });
  userId = auth.user.id;
  const ledgers = await request('/ledgers');
  assert.equal(ledgers.length, 1);
  assert.equal(ledgers[0].kind, 'personal');
  const path = '/ledgers/' + ledgers[0].id;
  const meta = await request(path + '/meta');
  const person = await request(path + '/people', 'POST', {
    name: '部署验收（临时）',
    relationship: '自动测试',
    note: '运行结束后清理',
  });
  const record = await request(path + '/records', 'POST', {
    personId: person.id,
    occasionId: meta.occasions[0].id,
    direction: 'expense',
    date: '2018-01-01',
    amountCents: 1,
    scope: 'personal',
    ownerId: userId,
    handlerId: userId,
    note: '自动部署验收临时数据',
  });
  await request('/auth/logout', 'POST');
  await request('/auth/login', 'POST', { username, password });
  const result = await request(path + '/records');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, record.id);
  assert.equal(result.summary.expense, 1);
  const backup = await request(path + '/export.json');
  assert.equal(backup.format, 'favor');
  assert.equal(backup.records.length, 1);
  console.log('PRODUCTION_SMOKE_OK registration login persistent_record exact_amount export');
} finally {
  // Match only this cryptographically random, script-created user. Do not touch other accounts.
  await db.beginTransaction();
  try {
    const [users] = await db.execute('SELECT id FROM users WHERE username=? FOR UPDATE', [
      username,
    ]);
    if (users.length) {
      const id = users[0].id;
      if (userId && id !== userId) throw new Error('Unexpected acceptance account identity');
      const [ledgers] = await db.execute('SELECT id FROM ledgers WHERE owner_id=? FOR UPDATE', [
        id,
      ]);
      for (const ledger of ledgers) {
        for (const table of [
          'records',
          'imported_records',
          'invites',
          'people',
          'occasions',
          'events',
          'members',
        ]) {
          await db.execute(`DELETE FROM ${table} WHERE ledger_id=?`, [ledger.id]);
        }
        await db.execute('DELETE FROM ledgers WHERE id=?', [ledger.id]);
      }
      await db.execute('DELETE FROM sessions WHERE user_id=?', [id]);
      await db.execute('DELETE FROM users WHERE id=? AND username=?', [id, username]);
    }
    await db.commit();
    console.log('PRODUCTION_SMOKE_CLEANED temporary acceptance data only');
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    await db.end();
  }
}
