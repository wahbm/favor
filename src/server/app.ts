import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import argon2 from 'argon2';
import { z } from 'zod';
import { pool, q, transaction, type DB, type SQLValue } from './db.js';
import {
  credentialsSchema,
  nameSchema,
  personSchema,
  recordSchema,
  dateSchema,
  csvCell,
  type User,
  type Ledger,
  type RecordInput,
  type Entry,
  type Person,
  type Named,
} from '../shared/domain.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User;
    csrf: string;
  }
}
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const token = () => randomBytes(32).toString('hex');
function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}
const idSchema = z.string().uuid();
const params = (req: FastifyRequest) => req.params as { ledgerId: string; id: string };
const origin = () => new URL(process.env.APP_ORIGIN || 'http://localhost:5173').origin;
const isProduction = () => process.env.NODE_ENV === 'production';
const basePath = () => {
  const value = (process.env.BASE_PATH || '').replace(/\/$/, '');
  if (value && !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(value))
    throw new Error('BASE_PATH格式无效');
  return value;
};
const cookiePath = () => basePath() + '/';
async function createLedger(db: DB, userId: string, name: string, kind: Ledger['kind']) {
  const id = randomUUID();
  await q(db, 'INSERT INTO ledgers(id,name,kind,owner_id,personal_owner) VALUES(?,?,?,?,?)', [
    id,
    name,
    kind,
    userId,
    kind === 'personal' ? userId : null,
  ]);
  await q(db, 'INSERT INTO members(ledger_id,user_id) VALUES(?,?)', [id, userId]);
  for (const name of ['结婚', '小孩满月', '乔迁'])
    await q(db, 'INSERT INTO occasions(id,ledger_id,name) VALUES(?,?,?)', [randomUUID(), id, name]);
  return id;
}
async function access(db: DB, ledgerId: string, userId: string) {
  idSchema.parse(ledgerId);
  const [ledger] = await q<Ledger>(
    db,
    `SELECT l.id,l.name,l.kind,l.owner_id AS ownerId FROM ledgers l JOIN members m ON m.ledger_id=l.id WHERE l.id=? AND m.user_id=? AND m.active=1 AND (l.kind='family' OR l.owner_id=?) FOR UPDATE`,
    [ledgerId, userId, userId],
  );
  if (!ledger) fail(404, '账本不存在或无权访问');
  return ledger;
}
async function scoped<T>(req: FastifyRequest, fn: (db: DB, ledger: Ledger) => Promise<T>) {
  return transaction(async (db) => {
    const ledger = await access(db, params(req).ledgerId, req.user.id);
    return fn(db, ledger);
  });
}
async function validRecord(
  db: DB,
  ledger: Ledger,
  input: RecordInput,
  old?: RecordInput,
  historical = false,
) {
  if (
    ledger.kind === 'personal' &&
    (input.scope !== 'personal' || input.ownerId !== ledger.ownerId)
  )
    fail(400, '个人账本记录必须归属本人');
  if (input.scope === 'family' && input.ownerId !== null) fail(400, '家庭归属不能指定个人');
  if (input.scope === 'personal' && !input.ownerId) fail(400, '请选择归属成员');
  for (const [table, id] of [
    ['people', input.personId],
    ['occasions', input.occasionId],
    ['events', input.eventId],
  ] as const) {
    if (
      id &&
      !(await q(db, `SELECT id FROM ${table} WHERE ledger_id=? AND id=?`, [ledger.id, id])).length
    )
      fail(400, '人物、事由或事件不属于当前账本');
  }
  for (const field of ['ownerId', 'handlerId'] as const) {
    const id = input[field];
    if (!id) continue;
    const [member] = await q(db, 'SELECT active FROM members WHERE ledger_id=? AND user_id=?', [
      ledger.id,
      id,
    ]);
    if (!member || (!member.active && !historical && old?.[field] !== id))
      fail(400, '请选择当前账本有效成员');
  }
}
const fields = [
  'person_id',
  'occasion_id',
  'event_id',
  'direction',
  'date',
  'amount_cents',
  'scope',
  'owner_id',
  'handler_id',
  'note',
];
const values = (r: RecordInput) => [
  r.personId,
  r.occasionId,
  r.eventId,
  r.direction,
  r.date,
  r.amountCents,
  r.scope,
  r.ownerId,
  r.handlerId,
  r.note,
];
async function insertRecord(
  db: DB,
  ledgerId: string,
  r: RecordInput,
  userId: string,
  sourceId: string = randomUUID(),
) {
  const id = randomUUID();
  await q(
    db,
    `INSERT INTO records(id,source_id,ledger_id,${fields.join(',')},creator_id,updater_id) VALUES(${Array(15).fill('?').join(',')})`,
    [id, sourceId, ledgerId, ...values(r), userId, userId],
  );
  return id;
}
const entrySelect = `SELECT r.id,r.source_id AS sourceId,r.person_id AS personId,r.occasion_id AS occasionId,r.event_id AS eventId,r.direction,r.date,r.amount_cents AS amountCents,r.scope,r.owner_id AS ownerId,r.handler_id AS handlerId,r.note,r.version,r.created_at AS createdAt,r.updated_at AS updatedAt,p.name AS personName,p.note AS personNote,o.name AS occasionName,e.name AS eventName,own.username AS ownerName,h.username AS handlerName,c.username AS creatorName,u.username AS updaterName FROM records r JOIN people p ON p.id=r.person_id JOIN occasions o ON o.id=r.occasion_id LEFT JOIN events e ON e.id=r.event_id LEFT JOIN users own ON own.id=r.owner_id LEFT JOIN users h ON h.id=r.handler_id JOIN users c ON c.id=r.creator_id JOIN users u ON u.id=r.updater_id`;
const filterSchema = z.object({
  personId: idSchema.optional(),
  occasionId: idSchema.optional(),
  eventId: idSchema.optional(),
  direction: z.enum(['income', 'expense']).optional(),
  scope: z.enum(['family', 'personal']).optional(),
  ownerId: idSchema.optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});
function filters(req: FastifyRequest) {
  const f = filterSchema.parse(req.query);
  if (f.from && f.to && f.from > f.to) fail(400, '开始日期不能晚于结束日期');
  let sql = ' WHERE r.ledger_id=?';
  const args: SQLValue[] = [params(req).ledgerId];
  for (const [key, col] of Object.entries({
    personId: 'person_id',
    occasionId: 'occasion_id',
    eventId: 'event_id',
    direction: 'direction',
    scope: 'scope',
    ownerId: 'owner_id',
    from: 'date >=',
    to: 'date <=',
  })) {
    const v = f[key as keyof typeof f];
    if (v) {
      sql += ` AND r.${col}${key === 'from' || key === 'to' ? '' : ' ='} ?`;
      args.push(v);
    }
  }
  return { sql, args };
}
const portableRecord = z.object({
  sourceId: idSchema,
  person: personSchema.extend({ id: idSchema }),
  occasion: nameSchema,
  event: nameSchema.nullable(),
  direction: z.enum(['income', 'expense']),
  date: dateSchema,
  amountCents: z.number().int().positive().max(99999999999),
  scope: z.enum(['family', 'personal']),
  owner: z.string().max(32).nullable(),
  handler: z.string().max(32).nullable(),
  note: z.string().max(2000),
});
const backupSchema = z.object({
  format: z.literal('favor'),
  version: z.literal(1),
  records: z.array(portableRecord).max(10000),
});
async function importData(db: DB, ledger: Ledger, userId: string, body: unknown, commit: boolean) {
  const data = backupSchema.parse(body);
  const seen = new Set<string>();
  const personIdentities = new Map<string, string>();
  for (const row of data.records) {
    const fingerprint = JSON.stringify(row.person);
    const previous = personIdentities.get(row.person.id);
    if (previous && previous !== fingerprint) fail(400, '同一人物标识在备份中包含冲突资料');
    personIdentities.set(row.person.id, fingerprint);
  }
  let added = 0,
    skipped = 0;
  const members = await q<{ id: string; username: string }>(
    db,
    'SELECT u.id,u.username FROM members m JOIN users u ON u.id=m.user_id WHERE m.ledger_id=?',
    [ledger.id],
  );
  const memberId = (username: string | null) => {
    if (!username) return null;
    const member = members.find((m) => m.username === username);
    if (!member)
      fail(400, `导入涉及不属于账本的成员：${username}。请先邀请该成员，或调整备份中的归属。`);
    return member.id;
  };
  // Preview runs the same writes and validation as commit, then rolls back using a savepoint.
  await q(db, 'SAVEPOINT import_preview');
  for (const row of data.records) {
    if (seen.has(row.sourceId)) fail(400, '备份中存在重复记录标识');
    seen.add(row.sourceId);
    if (
      (
        await q(
          db,
          'SELECT id FROM records WHERE ledger_id=? AND source_id=? UNION ALL SELECT source_id FROM imported_records WHERE ledger_id=? AND source_id=?',
          [ledger.id, row.sourceId, ledger.id, row.sourceId],
        )
      ).length
    ) {
      skipped++;
      continue;
    }
    const ownerId = ledger.kind === 'personal' ? ledger.ownerId : memberId(row.owner);
    const handlerId = ledger.kind === 'personal' ? userId : memberId(row.handler);
    if (ledger.kind === 'personal' && row.scope !== 'personal')
      fail(400, '家庭归属记录不能导入个人账本');
    let [person] = await q<Person>(db, 'SELECT id FROM people WHERE ledger_id=? AND source_id=?', [
      ledger.id,
      row.person.id,
    ]);
    // Portable identity preserves distinct people, even with identical names and notes.
    if (!person) {
      person = { ...row.person, id: randomUUID() };
      await q(
        db,
        'INSERT INTO people(id,source_id,ledger_id,name,relationship,note) VALUES(?,?,?,?,?,?)',
        [
          person.id,
          row.person.id,
          ledger.id,
          row.person.name,
          row.person.relationship,
          row.person.note,
        ],
      );
    }
    async function named(table: 'occasions' | 'events', name: string | null) {
      if (!name) return null;
      const [found] = await q<Named>(db, `SELECT id FROM ${table} WHERE ledger_id=? AND name=?`, [
        ledger.id,
        name,
      ]);
      if (found) return found.id;
      const id = randomUUID();
      await q(db, `INSERT INTO ${table}(id,ledger_id,name) VALUES(?,?,?)`, [id, ledger.id, name]);
      return id;
    }
    const input = recordSchema.parse({
      ...row,
      personId: person.id,
      occasionId: await named('occasions', row.occasion),
      eventId: await named('events', row.event),
      ownerId,
      handlerId,
    });
    await validRecord(db, ledger, input, undefined, true);
    await insertRecord(db, ledger.id, input, userId, row.sourceId);
    await q(db, 'INSERT INTO imported_records(ledger_id,source_id) VALUES(?,?)', [
      ledger.id,
      row.sourceId,
    ]);
    added++;
  }
  if (!commit) await q(db, 'ROLLBACK TO SAVEPOINT import_preview');
  return { added, skipped, total: data.records.length };
}

export async function buildApp() {
  basePath();
  const app = Fastify({
    logger:
      process.env.NODE_ENV === 'test'
        ? false
        : {
            serializers: {
              req: (req: { method: string; url: string; ip: string }) => ({
                method: req.method,
                url: req.url.split('?')[0],
                ip: req.ip,
              }),
            },
          },
    bodyLimit: 8 * 1024 * 1024,
    trustProxy: '127.0.0.1',
  });
  await app.register(cookie);
  await app.register(helmet, {
    hsts: isProduction() ? undefined : false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: isProduction() ? [] : null,
      },
    },
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  app.decorateRequest('user');
  app.decorateRequest('csrf', '');
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({ message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；') });
    const e = error as Error & { statusCode?: number; code?: string };
    if (e.code === 'ER_DUP_ENTRY')
      return reply.code(409).send({ message: '名称或记录已存在，请刷新后重试' });
    if (e.statusCode && e.statusCode < 500)
      return reply.code(e.statusCode).send({ message: e.message });
    req.log.error(error);
    return reply.code(500).send({ message: '服务暂时不可用，请稍后再试' });
  });
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers.origin !== origin()) fail(403, '请求来源不合法，请从本站操作');
      if (!req.headers['content-type']?.startsWith('application/json')) fail(415, '请使用JSON提交');
    }
    if (
      req.url.split('?')[0] === '/api/health' ||
      ['/api/auth/login', '/api/auth/register'].includes(req.url)
    )
      return;
    const session = req.cookies.favor_session;
    if (!session) fail(401, '请先登录');
    const [row] = await transaction((db) =>
      q<User & { csrf: string }>(
        db,
        'SELECT u.id,u.username,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP()',
        [hash(session)],
      ),
    );
    if (!row) fail(401, '登录已过期，请重新登录');
    req.user = { id: row.id, username: row.username };
    req.csrf = row.csrf;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const csrf = req.headers['x-csrf-token'];
      if (
        typeof csrf !== 'string' ||
        Buffer.byteLength(csrf) !== Buffer.byteLength(row.csrf) ||
        !timingSafeEqual(Buffer.from(csrf), Buffer.from(row.csrf))
      )
        fail(403, '安全凭证失效，请刷新页面');
    }
  });
  async function session(db: DB, userId: string, reply: FastifyReply) {
    const raw = token(),
      csrf = token();
    await q(db, 'DELETE FROM sessions WHERE expires_at<=UTC_TIMESTAMP()');
    await q(
      db,
      'INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 14 DAY))',
      [hash(raw), userId, csrf],
    );
    reply.setCookie('favor_session', raw, {
      httpOnly: true,
      secure: isProduction(),
      sameSite: 'lax',
      path: cookiePath(),
      maxAge: 14 * 86400,
    });
    return csrf;
  }
  app.get('/api/health', async () => {
    await transaction((db) => q(db, 'SELECT 1'));
    return { ok: true };
  });
  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const body = credentialsSchema.parse(req.body);
      const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
      return transaction(async (db) => {
        const id = randomUUID();
        await q(db, 'INSERT INTO users(id,username,password_hash) VALUES(?,?,?)', [
          id,
          body.username,
          passwordHash,
        ]);
        await createLedger(db, id, '我的人情账本', 'personal');
        const csrf = await session(db, id, reply);
        return { user: { id, username: body.username }, csrf };
      });
    },
  );
  const dummyHash = await argon2.hash(token(), { type: argon2.argon2id });
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const body = credentialsSchema.parse(req.body);
      const [user] = await transaction((db) =>
        q<User & { password_hash: string }>(
          db,
          'SELECT id,username,password_hash FROM users WHERE username=?',
          [body.username],
        ),
      );
      const valid = await argon2.verify(user?.password_hash || dummyHash, body.password);
      if (!user || !valid) fail(401, '用户名或密码不正确');
      const csrf = await transaction((db) => session(db, user.id, reply));
      return { user: { id: user.id, username: user.username }, csrf };
    },
  );
  app.get('/api/auth/me', async (req) => ({ user: req.user, csrf: req.csrf }));
  app.post('/api/auth/logout', async (req, reply) => {
    await transaction((db) =>
      q(db, 'DELETE FROM sessions WHERE token_hash=?', [hash(req.cookies.favor_session!)]),
    );
    reply.clearCookie('favor_session', { path: cookiePath() });
    return { ok: true };
  });
  app.post(
    '/api/auth/password',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const body = z
        .object({
          currentPassword: z.string().max(128),
          password: credentialsSchema.shape.password,
        })
        .parse(req.body);
      return transaction(async (db) => {
        const [user] = await q(db, 'SELECT password_hash FROM users WHERE id=? FOR UPDATE', [
          req.user.id,
        ]);
        if (!(await argon2.verify(user.password_hash, body.currentPassword)))
          fail(400, '当前密码不正确');
        await q(db, 'UPDATE users SET password_hash=? WHERE id=?', [
          await argon2.hash(body.password, { type: argon2.argon2id }),
          req.user.id,
        ]);
        await q(db, 'DELETE FROM sessions WHERE user_id=?', [req.user.id]);
        return { csrf: await session(db, req.user.id, reply) };
      });
    },
  );
  app.get('/api/ledgers', (req) =>
    transaction((db) =>
      q<Ledger>(
        db,
        `SELECT l.id,l.name,l.kind,l.owner_id AS ownerId FROM ledgers l JOIN members m ON m.ledger_id=l.id WHERE m.user_id=? AND m.active=1 AND (l.kind='family' OR l.owner_id=?) ORDER BY l.kind DESC,l.name`,
        [req.user.id, req.user.id],
      ),
    ),
  );
  app.post('/api/ledgers', (req) =>
    transaction(async (db) => ({
      id: await createLedger(
        db,
        req.user.id,
        z.object({ name: nameSchema }).parse(req.body).name,
        'family',
      ),
    })),
  );
  app.get('/api/ledgers/:ledgerId/meta', (req) =>
    scoped(req, async (db, l) => ({
      people: await q<Person>(
        db,
        'SELECT id,name,relationship,note FROM people WHERE ledger_id=? ORDER BY name',
        [l.id],
      ),
      occasions: await q<Named>(
        db,
        'SELECT id,name FROM occasions WHERE ledger_id=? ORDER BY name',
        [l.id],
      ),
      events: await q<Named>(db, 'SELECT id,name FROM events WHERE ledger_id=? ORDER BY name', [
        l.id,
      ]),
      members: await q(
        db,
        'SELECT u.id,u.username,m.active FROM members m JOIN users u ON u.id=m.user_id WHERE m.ledger_id=? ORDER BY m.active DESC,u.username',
        [l.id],
      ),
    })),
  );
  app.post('/api/ledgers/:ledgerId/people', (req) =>
    scoped(req, async (db, l) => {
      const p = personSchema.parse(req.body),
        id = randomUUID();
      await q(
        db,
        'INSERT INTO people(id,source_id,ledger_id,name,relationship,note) VALUES(?,?,?,?,?,?)',
        [id, id, l.id, p.name, p.relationship, p.note],
      );
      return { id, ...p };
    }),
  );
  app.put('/api/ledgers/:ledgerId/people/:id', (req) =>
    scoped(req, async (db, l) => {
      const p = personSchema.parse(req.body);
      const [found] = await q(db, 'SELECT id FROM people WHERE ledger_id=? AND id=?', [
        l.id,
        params(req).id,
      ]);
      if (!found) fail(404, '人物不存在');
      await q(db, 'UPDATE people SET name=?,relationship=?,note=? WHERE ledger_id=? AND id=?', [
        p.name,
        p.relationship,
        p.note,
        l.id,
        params(req).id,
      ]);
      return { ok: true };
    }),
  );
  for (const table of ['occasions', 'events'] as const)
    app.post(`/api/ledgers/:ledgerId/${table}`, (req) =>
      scoped(req, async (db, l) => {
        const { name } = z.object({ name: nameSchema }).parse(req.body),
          id = randomUUID();
        await q(db, `INSERT INTO ${table}(id,ledger_id,name) VALUES(?,?,?)`, [id, l.id, name]);
        return { id, name };
      }),
    );
  app.get('/api/ledgers/:ledgerId/records', (req) =>
    scoped(req, async (db) => {
      const f = filters(req);
      const records = await q<Entry>(
        db,
        entrySelect + f.sql + ' ORDER BY r.date DESC,r.created_at DESC,r.id',
        f.args,
      );
      const summary = records.reduce(
        (s, r) => {
          s[r.direction] += Number(r.amountCents);
          s.count++;
          return s;
        },
        { income: 0, expense: 0, count: 0 },
      );
      return { records, summary };
    }),
  );
  app.post('/api/ledgers/:ledgerId/records', (req) =>
    scoped(req, async (db, l) => {
      const r = recordSchema.parse(req.body);
      await validRecord(db, l, r);
      return { id: await insertRecord(db, l.id, r, req.user.id) };
    }),
  );
  app.put('/api/ledgers/:ledgerId/records/:id', (req) =>
    scoped(req, async (db, l) => {
      const r = recordSchema.extend({ version: z.number().int().positive() }).parse(req.body);
      const [old] = await q<Entry>(db, entrySelect + ' WHERE r.ledger_id=? AND r.id=?', [
        l.id,
        params(req).id,
      ]);
      if (!old) fail(404, '记录不存在');
      if (old.version !== r.version) fail(409, '记录已被其他成员修改，请关闭窗口并刷新后重试');
      await validRecord(db, l, r, old);
      await q(
        db,
        `UPDATE records SET ${fields.map((f) => f + '=?').join(',')},updater_id=?,updated_at=UTC_TIMESTAMP(),version=version+1 WHERE ledger_id=? AND id=?`,
        [...values(r), req.user.id, l.id, old.id],
      );
      return { ok: true };
    }),
  );
  app.delete('/api/ledgers/:ledgerId/records/:id', (req) =>
    scoped(req, async (db, l) => {
      const { version } = z.object({ version: z.number().int().positive() }).parse(req.body);
      const [old] = await q(
        db,
        'SELECT id,source_id,version FROM records WHERE ledger_id=? AND id=?',
        [l.id, params(req).id],
      );
      if (!old) fail(404, '记录不存在');
      if (old.version !== version) fail(409, '记录已被修改，请刷新后重试');
      await q(db, 'INSERT IGNORE INTO imported_records(ledger_id,source_id) VALUES(?,?)', [
        l.id,
        old.source_id,
      ]);
      await q(db, 'DELETE FROM records WHERE ledger_id=? AND id=?', [l.id, old.id]);
      return { ok: true };
    }),
  );
  app.get('/api/ledgers/:ledgerId/invites', (req) =>
    scoped(req, async (db, l) => {
      if (l.kind !== 'family' || l.ownerId !== req.user.id) fail(403, '仅创建者可管理邀请');
      return q(
        db,
        'SELECT id,expires_at AS expiresAt,revoked FROM invites WHERE ledger_id=? ORDER BY created_at DESC',
        [l.id],
      );
    }),
  );
  app.post('/api/ledgers/:ledgerId/invites', (req) =>
    scoped(req, async (db, l) => {
      if (l.kind !== 'family' || l.ownerId !== req.user.id) fail(403, '仅创建者可创建邀请');
      const raw = token(),
        id = randomUUID();
      await q(
        db,
        'INSERT INTO invites(id,ledger_id,token_hash,expires_at) VALUES(?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 7 DAY))',
        [id, l.id, hash(raw)],
      );
      return { id, url: `${origin()}${basePath()}/?invite=${raw}` };
    }),
  );
  app.delete('/api/ledgers/:ledgerId/invites/:id', (req) =>
    scoped(req, async (db, l) => {
      if (l.ownerId !== req.user.id) fail(403, '仅创建者可撤销邀请');
      await q(db, 'UPDATE invites SET revoked=1 WHERE ledger_id=? AND id=?', [
        l.id,
        params(req).id,
      ]);
      return { ok: true };
    }),
  );
  app.post('/api/invites/accept', (req) =>
    transaction(async (db) => {
      const { token: raw } = z
        .object({ token: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(req.body);
      const [invite] = await q(
        db,
        "SELECT i.ledger_id FROM invites i JOIN ledgers l ON l.id=i.ledger_id WHERE i.token_hash=? AND i.revoked=0 AND i.expires_at>UTC_TIMESTAMP() AND l.kind='family' FOR UPDATE",
        [hash(raw)],
      );
      if (!invite) fail(400, '邀请已过期或已撤销');
      await q(
        db,
        'INSERT INTO members(ledger_id,user_id) VALUES(?,?) ON DUPLICATE KEY UPDATE active=1',
        [invite.ledger_id, req.user.id],
      );
      return { id: invite.ledger_id };
    }),
  );
  app.delete('/api/ledgers/:ledgerId/members/:id', (req) =>
    scoped(req, async (db, l) => {
      if (l.kind !== 'family') fail(400, '个人账本不能移除成员');
      const id = params(req).id;
      if (id === l.ownerId) fail(400, '不能移除账本创建者');
      if (req.user.id !== l.ownerId && id !== req.user.id) fail(403, '仅创建者可移除其他成员');
      await q(db, 'UPDATE members SET active=0 WHERE ledger_id=? AND user_id=?', [l.id, id]);
      return { ok: true };
    }),
  );
  app.get('/api/ledgers/:ledgerId/export.json', (req) =>
    scoped(req, async (db, l) => {
      const records = await q<Entry & { sourceId: string }>(
        db,
        entrySelect + ' WHERE r.ledger_id=? ORDER BY r.date,r.id',
        [l.id],
      );
      const people = await q<Person & { sourceId: string }>(
        db,
        'SELECT id,source_id AS sourceId,name,relationship,note FROM people WHERE ledger_id=?',
        [l.id],
      );
      return {
        format: 'favor',
        version: 1,
        exportedAt: new Date().toISOString(),
        records: records.map((r) => ({
          sourceId: r.sourceId,
          person: (() => {
            const p = people.find((p) => p.id === r.personId)!;
            return { id: p.sourceId, name: p.name, relationship: p.relationship, note: p.note };
          })(),
          occasion: r.occasionName,
          event: r.eventName,
          direction: r.direction,
          date: r.date,
          amountCents: Number(r.amountCents),
          scope: r.scope,
          owner: r.ownerName,
          handler: r.handlerName,
          note: r.note,
        })),
      };
    }),
  );
  app.get('/api/ledgers/:ledgerId/export.csv', async (req, reply) => {
    const csv = await scoped(req, async (db) => {
      const f = filters(req);
      const records = await q<Entry>(db, entrySelect + f.sql + ' ORDER BY r.date DESC', f.args);
      return (
        '\uFEFF' +
        [
          [
            '日期',
            '人物',
            '人物说明',
            '事由',
            '具体事件',
            '方向',
            '金额（元）',
            '归属维度',
            '归属人',
            '经手人',
            '备注',
          ],
          ...records.map((r) => [
            r.date,
            r.personName,
            r.personNote,
            r.occasionName,
            r.eventName,
            r.direction === 'income' ? '收入' : '支出',
            (r.amountCents / 100).toFixed(2),
            r.scope === 'family' ? '家庭' : '个人',
            r.ownerName,
            r.handlerName,
            r.note,
          ]),
        ]
          .map((row) => row.map(csvCell).join(','))
          .join('\r\n')
      );
    });
    return reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="favor.csv"')
      .send(csv);
  });
  app.post('/api/ledgers/:ledgerId/import/preview', (req) =>
    scoped(req, (db, l) => importData(db, l, req.user.id, req.body, false)),
  );
  app.post('/api/ledgers/:ledgerId/import/commit', (req) =>
    scoped(req, (db, l) => importData(db, l, req.user.id, req.body, true)),
  );
  if (existsSync(resolve('dist/client/index.html'))) {
    await app.register(staticFiles, { root: resolve('dist/client'), wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ message: '接口不存在' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
