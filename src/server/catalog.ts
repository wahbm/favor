import { randomUUID } from 'node:crypto';
import { q, type DB } from './db.js';
import type { Person, Named, RecordInput, ReusableCatalog } from '../shared/domain.js';
type Table = 'people' | 'occasions' | 'events';
const sourceAccess = `JOIN ledgers l ON l.id=item.ledger_id JOIN members m ON m.ledger_id=l.id WHERE m.user_id=? AND m.active=1 AND (l.kind='family' OR l.owner_id=?)`;
const unavailable = () =>
  Object.assign(new Error('无法复用该资料，请刷新账本后重试'), { statusCode: 404 });

// These suggestions belong to the requesting user, never to the target household as a whole.
export async function reusableCatalog(
  db: DB,
  ledgerId: string,
  userId: string,
): Promise<ReusableCatalog> {
  async function list<T extends Person | Named>(table: Table) {
    const person = table === 'people';
    const rows = await q<T & { sourceLedgerName: string; reuseKey: string }>(
      db,
      `SELECT item.id,item.name,${person ? 'item.relationship,item.note,' : ''}l.name AS sourceLedgerName,${person ? 'item.source_id' : 'LOWER(item.name)'} AS reuseKey FROM ${table} item ${sourceAccess} AND l.id<>? AND NOT EXISTS (SELECT 1 FROM ${table} local WHERE local.ledger_id=? AND ${person ? 'local.source_id=item.source_id' : 'local.name=item.name'}) ORDER BY (l.kind='personal') DESC,l.name,item.name,item.id`,
      [userId, userId, ledgerId, ledgerId],
    );
    const seen = new Set<string>();
    return rows
      .filter((row) => {
        if (seen.has(row.reuseKey)) return false;
        seen.add(row.reuseKey);
        return true;
      })
      .map(({ reuseKey: _key, ...row }) => row);
  }
  return {
    people: await list<Person>('people'),
    occasions: await list<Named>('occasions'),
    events: await list<Named>('events'),
  };
}

// Copies a snapshot only when saving the record. The caller's transaction includes validation
// and record insertion, so failed saves cannot publish private metadata to another ledger.
export async function reuseRecordCatalog(
  db: DB,
  ledgerId: string,
  userId: string,
  input: RecordInput,
): Promise<RecordInput> {
  async function copy(table: Table, sourceId: string | null): Promise<string> {
    if (!sourceId) throw unavailable();
    const [source] = await q<Person & { ledger_id: string; source_id: string }>(
      db,
      `SELECT item.* FROM ${table} item ${sourceAccess} AND item.id=? FOR UPDATE`,
      [userId, userId, sourceId],
    );
    if (!source) throw unavailable();
    if (source.ledger_id === ledgerId) return source.id;
    const [existing] = await q<Named>(
      db,
      `SELECT id FROM ${table} WHERE ledger_id=? AND ${table === 'people' ? 'source_id' : 'name'}=?`,
      [ledgerId, table === 'people' ? source.source_id : source.name],
    );
    if (existing) return existing.id;
    const id = randomUUID();
    if (table === 'people')
      await q(
        db,
        'INSERT INTO people(id,source_id,ledger_id,name,relationship,note) VALUES(?,?,?,?,?,?)',
        [id, source.source_id, ledgerId, source.name, source.relationship, source.note],
      );
    else
      await q(db, `INSERT INTO ${table}(id,ledger_id,name) VALUES(?,?,?)`, [
        id,
        ledgerId,
        source.name,
      ]);
    return id;
  }
  return {
    ...input,
    personId: input.reuse?.person ? await copy('people', input.personId) : input.personId,
    occasionId: input.reuse?.occasion
      ? await copy('occasions', input.occasionId)
      : input.occasionId,
    eventId: input.reuse?.event ? await copy('events', input.eventId) : input.eventId,
    reuse: undefined,
  };
}
