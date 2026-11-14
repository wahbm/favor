import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import type { Ledger, Meta, Entry } from '../src/shared/domain.js';
const testUrl = process.env.TEST_DATABASE_URL;
test('MariaDB + Fastify 完整业务与权限集成', { skip: !testUrl }, async (t) => {
  if (!testUrl || !/^favor_test(?:_|$)/.test(new URL(testUrl).pathname.slice(1)))
    throw new Error('测试仅允许数据库名 favor_test 或 favor_test_*');
  process.env.DATABASE_URL = testUrl;
  process.env.APP_ORIGIN = 'http://localhost:5173';
  process.env.NODE_ENV = 'test';
  const { migrate, pool, transaction, q } = await import('../src/server/db.js');
  const { buildApp } = await import('../src/server/app.js');
  try {
    await migrate();
  } catch (e) {
    await pool.end();
    throw e;
  }
  const app: FastifyInstance = await buildApp();
  let clients = 0;
  class Client {
    cookie = '';
    csrf = '';
    id = '';
    username = '';
    ip = `127.0.0.${++clients}`;
    async request(
      path: string,
      method: HTTPMethods = 'GET',
      body?: unknown,
      extra: Record<string, string> = {},
    ) {
      const r = await app.inject({
        method,
        url: '/api' + path,
        remoteAddress: this.ip,
        headers: {
          origin: 'http://localhost:5173',
          ...(this.cookie ? { cookie: this.cookie } : {}),
          'content-type': 'application/json',
          'x-csrf-token': this.csrf,
          ...extra,
        },
        ...(method !== 'GET' ? { payload: JSON.stringify(body ?? {}) } : {}),
      });
      return r;
    }
    async ok<T = Record<string, unknown>>(
      path: string,
      method: HTTPMethods = 'GET',
      body?: unknown,
    ): Promise<T> {
      const r = await this.request(path, method, body);
      assert.equal(r.statusCode, 200, r.body);
      return r.json() as T;
    }
    async register(name: string) {
      this.username = name;
      const r = await this.request('/auth/register', 'POST', {
        username: name,
        password: 'correct-horse-battery',
      });
      assert.equal(r.statusCode, 200, r.body);
      this.cookie = String(r.headers['set-cookie']).split(';')[0];
      this.csrf = r.json().csrf;
      this.id = r.json().user.id;
    }
  }
  try {
    await t.test('生产页面、静态资源与刷新路由可用，不暴露项目根文件', async () => {
      const homepage = await app.inject({ method: 'GET', url: '/' });
      assert.equal(homepage.statusCode, 200, '完整集成测试前请运行 npm run build');
      assert.match(homepage.headers['content-type'] || '', /text\/html/);
      const script = homepage.body.match(/src="([^"]+\.js)"/);
      assert(script);
      const asset = await app.inject({
        method: 'GET',
        url: '/assets/' + script[1].split('/assets/')[1],
      });
      assert.equal(asset.statusCode, 200);
      assert.match(asset.headers['content-type'] || '', /javascript/);
      const deep = await app.inject({ method: 'GET', url: '/records' });
      assert.equal(deep.statusCode, 200);
      assert.match(deep.body, /<html/);
      for (const url of ['/package.json', '/%2e%2e/package.json', '/.env']) {
        const result = await app.inject({ method: 'GET', url });
        assert(!result.body.includes('"dependencies"'));
        assert(!result.body.includes('DATABASE_URL='));
      }
    });
    await t.test('数据库会话使用UTC，不受主机默认时区影响', async () => {
      const [row] = await transaction((db) =>
        q(db, 'SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS delta'),
      );
      assert.equal(row.delta, 0);
    });
    const tag = randomUUID().slice(0, 8);
    const alice = new Client(),
      bob = new Client(),
      eve = new Client();
    await alice.register('a_' + tag);
    await bob.register('b_' + tag);
    await eve.register('e_' + tag);
    const personal = (await alice.ok<Ledger[]>('/ledgers'))[0];
    let familyId = '';
    let personalBob = (await bob.ok<Ledger[]>('/ledgers'))[0];
    await t.test('注册自动且仅创建一个个人账本，其他人不能访问', async () => {
      assert.equal(personal.kind, 'personal');
      assert.equal((await alice.ok<Ledger[]>('/ledgers')).length, 1);
      assert.equal((await bob.request(`/ledgers/${personal.id}/meta`)).statusCode, 404);
      const result = await alice.ok<{ id: string }>('/ledgers', 'POST', { name: '家庭 🏠' });
      familyId = result.id;
      const list = await alice.ok<Ledger[]>('/ledgers');
      assert.equal(list.filter((l) => l.kind === 'personal').length, 1);
      assert.equal(list.find((l) => l.id === familyId)?.kind, 'family');
    });
    const path = `/ledgers/${familyId}`;
    let invitation = '';
    await t.test('邀请加入家庭，创建者受保护，邀请可撤销且非成员无权读写', async () => {
      assert.equal((await eve.request(path + '/records')).statusCode, 404);
      const invitationData = await alice.ok<{ url: string; id: string }>(path + '/invites', 'POST');
      invitation = new URL(invitationData.url).searchParams.get('invite')!;
      await bob.ok('/invites/accept', 'POST', { token: invitation });
      assert.equal((await bob.ok<Ledger[]>('/ledgers')).length, 2);
      assert.equal((await bob.request(path + '/invites', 'POST')).statusCode, 403);
      assert.equal((await alice.request(path + '/members/' + alice.id, 'DELETE')).statusCode, 400);
      await alice.ok(path + '/invites/' + invitationData.id, 'DELETE');
      assert.equal(
        (await eve.request('/invites/accept', 'POST', { token: invitation })).statusCode,
        400,
      );
    });
    await t.test('子路径部署的Cookie和邀请链接保持在应用目录中', async () => {
      process.env.BASE_PATH = '/mosshqq/favor';
      try {
        const response = await alice.request('/auth/login', 'POST', {
          username: alice.username,
          password: 'correct-horse-battery',
        });
        assert.equal(response.statusCode, 200);
        assert.match(String(response.headers['set-cookie']), /Path=\/mosshqq\/favor\//);
        const invite = await alice.ok<{ url: string }>(path + '/invites', 'POST');
        assert.equal(new URL(invite.url).pathname, '/mosshqq/favor/');
      } finally {
        delete process.env.BASE_PATH;
      }
    });
    await t.test('过期邀请不能加入，个人账本数据库唯一约束生效', async () => {
      const expired = await alice.ok<{ url: string; id: string }>(path + '/invites', 'POST');
      await transaction((db) =>
        q(db, 'UPDATE invites SET expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY) WHERE id=?', [
          expired.id,
        ]),
      );
      assert.equal(
        (
          await eve.request('/invites/accept', 'POST', {
            token: new URL(expired.url).searchParams.get('invite'),
          })
        ).statusCode,
        400,
      );
      await assert.rejects(
        () =>
          transaction((db) =>
            q(
              db,
              "INSERT INTO ledgers(id,name,kind,owner_id,personal_owner) VALUES(?,?,'personal',?,?)",
              [randomUUID(), '重复个人账本', alice.id, alice.id],
            ),
          ),
        /Duplicate entry/,
      );
    });
    let meta = await alice.ok<Meta>(path + '/meta');
    const person = await alice.ok<{ id: string }>(path + '/people', 'POST', {
      name: '翰林',
      relationship: '同学',
      note: '高中同学',
    });
    const event = await alice.ok<{ id: string }>(path + '/events', 'POST', { name: '我的婚礼' });
    let recordId = '';
    const base = {
      personId: person.id,
      occasionId: meta.occasions.find((o) => o.name === '结婚')!.id,
      eventId: event.id,
      direction: 'expense',
      date: '2018-01-01',
      amountCents: 100001,
      scope: 'family',
      ownerId: null,
      handlerId: alice.id,
      note: '夫妻共同送礼',
    };
    await t.test('家庭记录与个人归属记录同账本共享，不写入个人账本', async () => {
      recordId = (await alice.ok<{ id: string }>(path + '/records', 'POST', base)).id;
      await bob.ok(path + '/records', 'POST', {
        ...base,
        scope: 'personal',
        ownerId: bob.id,
        direction: 'income',
        amountCents: 100000,
      });
      const r = await bob.ok<{
        records: Entry[];
        summary: { income: number; expense: number; count: number };
      }>(path + '/records');
      assert.equal(r.summary.count, 2);
      assert.equal(r.summary.expense, 100001);
      assert.equal(r.summary.income, 100000);
      assert.equal(
        (await bob.ok<{ records: Entry[] }>(`/ledgers/${personalBob.id}/records`)).records.length,
        0,
      );
      const filtered = await alice.ok<{ summary: { count: number; income: number } }>(
        path + '/records?ownerId=' + bob.id + '&scope=personal',
      );
      assert.equal(filtered.summary.count, 1);
      assert.equal(filtered.summary.income, 100000);
    });
    await t.test('服务端拒绝未来日期、非法金额和错误归属', async () => {
      for (const input of [
        { date: '2999-01-01' },
        { date: '2023-02-29' },
        { amountCents: 0 },
        { amountCents: 1.1 },
        { amountCents: -100 },
        { scope: 'personal', ownerId: null },
        { scope: 'personal', ownerId: eve.id },
        { handlerId: eve.id },
        { ownerId: bob.id },
      ])
        assert.equal(
          (await alice.request(path + '/records', 'POST', { ...base, ...input })).statusCode,
          400,
          JSON.stringify(input),
        );
    });
    await t.test('跨账本关联和记录ID越权均被拒绝', async () => {
      const otherMeta = await alice.ok<Meta>(`/ledgers/${personal.id}/meta`);
      assert.equal(
        (
          await alice.request(path + '/records', 'POST', {
            ...base,
            occasionId: otherMeta.occasions[0].id,
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (await eve.request(path + '/records/' + recordId, 'PUT', { ...base, version: 1 }))
          .statusCode,
        404,
      );
      assert.equal(
        (
          await bob.request(`/ledgers/${personalBob.id}/records/${recordId}`, 'PUT', {
            ...base,
            version: 1,
          })
        ).statusCode,
        404,
      );
      assert.equal((await bob.request(`/ledgers/${personal.id}/export.json`)).statusCode, 404);
    });
    await t.test('共同维护支持版本冲突检查且保存创建与修改人', async () => {
      await bob.ok(path + '/records/' + recordId, 'PUT', { ...base, version: 1, note: '家人更新' });
      assert.equal(
        (await alice.request(path + '/records/' + recordId, 'PUT', { ...base, version: 1 }))
          .statusCode,
        409,
      );
      const r = (await alice.ok<{ records: Entry[] }>(path + '/records')).records.find(
        (r) => r.id === recordId,
      )!;
      assert.equal(r.creatorName, alice.username);
      assert.equal(r.updaterName, bob.username);
      assert.equal(r.version, 2);
    });
    await t.test('人物允许同名，自定义事由可再次选择，事件与日期筛选正确', async () => {
      await alice.ok(path + '/people', 'POST', {
        name: '翰林',
        relationship: '同事',
        note: '工作同事',
      });
      await alice.ok(path + '/occasions', 'POST', { name: '升学' });
      meta = await alice.ok<Meta>(path + '/meta');
      assert.equal(meta.people.filter((p) => p.name === '翰林').length, 2);
      assert(meta.occasions.some((o) => o.name === '升学'));
      assert.equal(
        (
          await alice.ok<{ records: Entry[] }>(
            path + '/records?eventId=' + event.id + '&from=2018-01-01&to=2018-01-01',
          )
        ).records.length,
        2,
      );
    });
    await t.test('CSRF来源与安全令牌验证、未登录访问被拒绝', async () => {
      assert.equal(
        (
          await alice.request(path + '/records', 'POST', base, {
            origin: 'https://attacker.example',
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (await alice.request(path + '/records', 'POST', base, { 'x-csrf-token': 'bad' }))
          .statusCode,
        403,
      );
      assert.equal((await new Client().request('/ledgers')).statusCode, 401);
    });
    let backup: Record<string, unknown>;
    await t.test('JSON导出无权限或密码，导入预览不写入、提交原子且重复跳过', async () => {
      backup = await alice.ok(path + '/export.json');
      assert.equal(backup.version, 1);
      assert(!JSON.stringify(backup).includes('password'));
      assert(!JSON.stringify(backup).includes('members'));
      const targetId = (await alice.ok<{ id: string }>('/ledgers', 'POST', { name: '恢复账本' }))
        .id;
      const target = `/ledgers/${targetId}`;
      const link = await alice.ok<{ url: string }>(target + '/invites', 'POST');
      await bob.ok('/invites/accept', 'POST', {
        token: new URL(link.url).searchParams.get('invite'),
      });
      const p = await alice.ok<{ added: number }>(target + '/import/preview', 'POST', backup);
      assert.equal(p.added, 2);
      assert.equal((await alice.ok<{ records: Entry[] }>(target + '/records')).records.length, 0);
      assert.equal((await alice.ok<Meta>(target + '/meta')).people.length, 0);
      assert.equal(
        (await alice.ok<{ added: number }>(target + '/import/commit', 'POST', backup)).added,
        2,
      );
      assert.equal(
        (await alice.ok<{ skipped: number }>(target + '/import/commit', 'POST', backup)).skipped,
        2,
      );
      const exportedAgain = await alice.ok<{ records: { sourceId: string }[] }>(
        target + '/export.json',
      );
      const original = backup as { records: { sourceId: string }[] };
      assert.deepEqual(
        exportedAgain.records.map((r) => r.sourceId).sort(),
        original.records.map((r) => r.sourceId).sort(),
      );
    });
    await t.test('导入整体失败不保留人物或半批记录，禁止导入跨家庭未知成员', async () => {
      const targetId = (
        await alice.ok<{ id: string }>('/ledgers', 'POST', { name: '导入失败测试' })
      ).id;
      const target = `/ledgers/${targetId}`;
      const rows = (backup as { records: unknown[] }).records;
      assert.equal(
        (await alice.request(target + '/import/commit', 'POST', { ...backup, records: rows }))
          .statusCode,
        400,
      );
      assert.equal((await alice.ok<{ records: Entry[] }>(target + '/records')).records.length, 0);
      assert.equal((await alice.ok<Meta>(target + '/meta')).people.length, 0);
    });
    await t.test('导入保留两个完全同名人物的独立身份，拒绝身份资料冲突与不支持版本', async () => {
      const target = (await alice.ok<{ id: string }>('/ledgers', 'POST', { name: '同名恢复' })).id;
      const row = {
        sourceId: randomUUID(),
        person: { id: randomUUID(), name: '同名人物', relationship: '同学', note: '' },
        occasion: '结婚',
        event: null,
        direction: 'expense',
        date: '2018-01-01',
        amountCents: 10000,
        scope: 'family',
        owner: null,
        handler: alice.username,
        note: '',
      };
      const other = { ...row, sourceId: randomUUID(), person: { ...row.person, id: randomUUID() } };
      const data = { format: 'favor', version: 1, records: [row, other] };
      assert.equal(
        (await alice.ok<{ added: number }>(`/ledgers/${target}/import/commit`, 'POST', data)).added,
        2,
      );
      assert.equal((await alice.ok<Meta>(`/ledgers/${target}/meta`)).people.length, 2);
      assert.equal(
        (await alice.request(`/ledgers/${target}/import/preview`, 'POST', { ...data, version: 2 }))
          .statusCode,
        400,
      );
      assert.equal(
        (
          await alice.request(`/ledgers/${target}/import/commit`, 'POST', {
            ...data,
            records: [row, { ...other, person: { ...row.person, name: '冲突资料' } }],
          })
        ).statusCode,
        400,
      );
    });
    await t.test('CSV跟随筛选且内容包含中文与金额精度', async () => {
      const r = await alice.request(path + '/export.csv?scope=family');
      assert.equal(r.statusCode, 200);
      assert(r.body.includes('1000.01'));
      assert(r.body.includes('翰林'));
      assert(!r.body.includes('1000.00'));
    });
    await t.test('成员移除后立即失权且历史归属保留，其他家庭仍可访问', async () => {
      await alice.ok(path + '/members/' + bob.id, 'DELETE');
      assert.equal((await bob.request(path + '/records')).statusCode, 404);
      assert.equal((await bob.request(path + '/records', 'POST', base)).statusCode, 404);
      assert.equal((await bob.request(path + '/export.json')).statusCode, 404);
      const m = await alice.ok<Meta>(path + '/meta');
      assert.equal(m.members.find((m) => m.id === bob.id)?.active, 0);
      assert.equal(
        (await alice.ok<{ records: Entry[] }>(path + '/records?ownerId=' + bob.id)).records.length,
        1,
      );
      assert.equal((await bob.request(`/ledgers/${personalBob.id}/records`)).statusCode, 200);
      const historical = (await alice.ok<{ records: Entry[] }>(path + '/records?ownerId=' + bob.id))
        .records[0];
      await alice.ok(path + '/records/' + historical.id, 'PUT', {
        ...historical,
        note: '保留已退出成员归属',
      });
      assert.equal(
        (
          await alice.request(path + '/records', 'POST', {
            ...base,
            scope: 'personal',
            ownerId: bob.id,
          })
        ).statusCode,
        400,
      );
    });
    await t.test('个人账本拒绝家庭归属，允许本人归属与有效日期', async () => {
      const p = `/ledgers/${personal.id}`;
      const person = await alice.ok<{ id: string }>(p + '/people', 'POST', { name: '朋友' });
      const meta = await alice.ok<Meta>(p + '/meta');
      const r = { ...base, personId: person.id, occasionId: meta.occasions[0].id, eventId: null };
      assert.equal((await alice.request(p + '/records', 'POST', r)).statusCode, 400);
      await alice.ok(p + '/records', 'POST', { ...r, scope: 'personal', ownerId: alice.id });
    });
    await t.test('删除记录要求版本，导入备份不会复活已删除记录', async () => {
      assert.equal(
        (await alice.request(path + '/records/' + recordId, 'DELETE', { version: 1 })).statusCode,
        409,
      );
      await alice.ok(path + '/records/' + recordId, 'DELETE', { version: 2 });
      assert.equal(
        (
          await alice.ok<{ added: number; skipped: number }>(
            path + '/import/commit',
            'POST',
            backup,
          )
        ).added,
        0,
      );
    });
    await t.test('跨账本资料仅供本人复用，选用后才向目标家庭共享，记录保持隔离', async () => {
      const privatePath = `/ledgers/${personal.id}`;
      const sourcePerson = await alice.ok<{ id: string }>(privatePath + '/people', 'POST', {
        name: '共享联系人',
        relationship: '同学',
        note: '这是已选择的资料',
      });
      const hiddenPerson = await alice.ok<{ id: string }>(privatePath + '/people', 'POST', {
        name: '未选中的私人联系人',
        note: '不得自动对家人展示',
      });
      const sourceOccasion = await alice.ok<{ id: string }>(privatePath + '/occasions', 'POST', {
        name: '个人自定义庆祝',
      });
      const sourceEvent = await alice.ok<{ id: string }>(privatePath + '/events', 'POST', {
        name: '个人的婚礼',
      });
      const target = (
        await alice.ok<{ id: string }>('/ledgers', 'POST', { name: '复用资料的家庭' })
      ).id;
      const targetPath = `/ledgers/${target}`;
      const invite = await alice.ok<{ url: string }>(targetPath + '/invites', 'POST');
      await bob.ok('/invites/accept', 'POST', {
        token: new URL(invite.url).searchParams.get('invite'),
      });
      const before = await alice.ok<Meta>(targetPath + '/meta');
      assert(before.reusable?.people.some((p) => p.id === sourcePerson.id));
      assert(before.reusable?.people.some((p) => p.id === hiddenPerson.id));
      assert(before.reusable?.occasions.some((p) => p.id === sourceOccasion.id));
      assert(before.reusable?.events.some((p) => p.id === sourceEvent.id));
      const bobBefore = await bob.ok<Meta>(targetPath + '/meta');
      assert(
        !bobBefore.reusable?.people.some(
          (p) => p.id === sourcePerson.id || p.id === hiddenPerson.id,
        ),
      );
      assert(!bobBefore.reusable?.occasions.some((p) => p.id === sourceOccasion.id));
      assert(!bobBefore.reusable?.events.some((p) => p.id === sourceEvent.id));
      assert.equal(bobBefore.people.length, 0);
      const input = {
        ...base,
        personId: sourcePerson.id,
        occasionId: sourceOccasion.id,
        eventId: sourceEvent.id,
        reuse: { person: true, occasion: true, event: true },
      };
      // Even when metadata has already been copied inside the transaction, a failed record
      // validation must roll back every copy so family members learn nothing from the attempt.
      assert.equal(
        (
          await alice.request(targetPath + '/records', 'POST', {
            ...input,
            scope: 'personal',
            ownerId: eve.id,
          })
        ).statusCode,
        400,
      );
      const afterFailure = await bob.ok<Meta>(targetPath + '/meta');
      assert.equal(afterFailure.people.length, 0);
      assert.equal(afterFailure.events.length, 0);
      assert.equal(afterFailure.occasions.length, 3);
      const personalCount = (await alice.ok<{ records: Entry[] }>(privatePath + '/records')).records
        .length;
      await alice.ok(targetPath + '/records', 'POST', input);
      const shared = await bob.ok<Meta>(targetPath + '/meta');
      assert.equal(shared.people.length, 1);
      assert.equal(shared.people[0].name, '共享联系人');
      assert.notEqual(shared.people[0].id, sourcePerson.id);
      assert(shared.occasions.some((o) => o.name === '个人自定义庆祝'));
      assert(shared.events.some((o) => o.name === '个人的婚礼'));
      assert(!JSON.stringify(shared).includes('不得自动对家人展示'));
      assert.equal(
        (await alice.ok<{ records: Entry[] }>(privatePath + '/records')).records.length,
        personalCount,
      );
      const [record] = (await bob.ok<{ records: Entry[] }>(targetPath + '/records')).records;
      assert.equal(record.personId, shared.people[0].id);
      assert.equal(
        record.occasionId,
        shared.occasions.find((o) => o.name === '个人自定义庆祝')!.id,
      );
      assert.equal(record.eventId, shared.events[0].id);
      await alice.ok(privatePath + '/people/' + sourcePerson.id, 'PUT', {
        name: '共享联系人',
        relationship: '同学',
        note: '仅个人新增的私密说明',
      });
      await alice.ok(targetPath + '/records', 'POST', input);
      const copiedAgain = await bob.ok<Meta>(targetPath + '/meta');
      assert.equal(copiedAgain.people.length, 1);
      assert.equal(copiedAgain.events.length, 1);
      assert.equal(copiedAgain.occasions.length, 4);
      assert.equal(copiedAgain.people[0].note, '这是已选择的资料');
      assert(!JSON.stringify(copiedAgain).includes('仅个人新增的私密说明'));
      assert.equal((await bob.request(targetPath + '/records', 'POST', input)).statusCode, 404);
      const aliceAfter = await alice.ok<Meta>(targetPath + '/meta');
      assert(!aliceAfter.reusable?.people.some((p) => p.id === sourcePerson.id));
      assert(aliceAfter.reusable?.people.some((p) => p.id === hiddenPerson.id));
      const eveLedger = (await eve.ok<Ledger[]>('/ledgers')).find((l) => l.kind === 'personal')!;
      const forbidden = await eve.ok<{ id: string }>(`/ledgers/${eveLedger.id}/people`, 'POST', {
        name: '其他账号的私密人物',
      });
      assert.equal(
        (await alice.request(targetPath + '/records', 'POST', { ...input, personId: forbidden.id }))
          .statusCode,
        404,
      );
    });
    await t.test('退出来源家庭后立即失去该家庭资料的复用权限', async () => {
      const source = (await alice.ok<{ id: string }>('/ledgers', 'POST', { name: '来源家庭' })).id;
      const sourcePath = `/ledgers/${source}`;
      const person = await alice.ok<{ id: string }>(sourcePath + '/people', 'POST', {
        name: '退出后不可复用的人物',
      });
      const invite = await alice.ok<{ url: string }>(sourcePath + '/invites', 'POST');
      await bob.ok('/invites/accept', 'POST', {
        token: new URL(invite.url).searchParams.get('invite'),
      });
      const target = `/ledgers/${personalBob.id}`;
      assert(
        (await bob.ok<Meta>(target + '/meta')).reusable?.people.some((p) => p.id === person.id),
      );
      await alice.ok(sourcePath + '/members/' + bob.id, 'DELETE');
      const after = await bob.ok<Meta>(target + '/meta');
      assert(!after.reusable?.people.some((p) => p.id === person.id));
      assert.equal(
        (
          await bob.request(target + '/records', 'POST', {
            ...base,
            personId: person.id,
            occasionId: after.occasions[0].id,
            eventId: null,
            scope: 'personal',
            ownerId: bob.id,
            handlerId: bob.id,
            reuse: { person: true },
          })
        ).statusCode,
        404,
      );
      assert.equal((await bob.ok<Meta>(target + '/meta')).people.length, after.people.length);
    });
    await t.test('修改密码撤销旧会话，登录限流生效', async () => {
      const oldCookie = alice.cookie;
      const r = await alice.request('/auth/password', 'POST', {
        currentPassword: 'correct-horse-battery',
        password: 'new-correct-password',
      });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(
        (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: oldCookie } }))
          .statusCode,
        401,
      );
      const attacker = new Client();
      for (let i = 0; i < 10; i++)
        assert.equal(
          (
            await attacker.request('/auth/login', 'POST', {
              username: alice.username,
              password: 'wrong-password',
            })
          ).statusCode,
          401,
        );
      assert.equal(
        (
          await attacker.request('/auth/login', 'POST', {
            username: alice.username,
            password: 'wrong-password',
          })
        ).statusCode,
        429,
      );
    });
  } finally {
    await app.close();
    await pool.end();
  }
});
