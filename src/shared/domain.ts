import { z } from 'zod';
export function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      v >= '1900-01-01' &&
      !Number.isNaN(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v &&
      v <= today(),
    '请选择1900年以来且不晚于今天的有效日期',
  );
export const nameSchema = z.string().trim().min(1).max(80);
export const personSchema = z.object({
  name: nameSchema,
  relationship: z.string().trim().max(80).default(''),
  note: z.string().trim().max(300).default(''),
});
export const recordSchema = z.object({
  personId: z.string().uuid(),
  occasionId: z.string().uuid(),
  eventId: z.string().uuid().nullable().default(null),
  direction: z.enum(['income', 'expense']),
  date: dateSchema,
  amountCents: z.number().int().positive().max(99999999999),
  scope: z.enum(['family', 'personal']),
  ownerId: z.string().uuid().nullable().default(null),
  handlerId: z.string().uuid().nullable().default(null),
  note: z.string().trim().max(2000).default(''),
  reuse: z
    .object({
      person: z.boolean().default(false),
      occasion: z.boolean().default(false),
      event: z.boolean().default(false),
    })
    .optional(),
});
export type RecordInput = z.infer<typeof recordSchema>;
export type User = { id: string; username: string };
export type Ledger = { id: string; name: string; kind: 'personal' | 'family'; ownerId: string };
export type Member = User & { active: number };
export type Person = { id: string; name: string; relationship: string; note: string };
export type Named = { id: string; name: string };
export type Entry = RecordInput & {
  id: string;
  personName: string;
  personNote: string;
  occasionName: string;
  eventName: string | null;
  ownerName: string | null;
  handlerName: string | null;
  creatorName: string;
  updaterName: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};
export type Reusable<T> = T & { sourceLedgerName: string };
export type ReusableCatalog = {
  people: Reusable<Person>[];
  occasions: Reusable<Named>[];
  events: Reusable<Named>[];
};
export type Meta = {
  people: Person[];
  occasions: Named[];
  events: Named[];
  members: Member[];
  reusable?: ReusableCatalog;
};
export type Summary = { income: number; expense: number; count: number };
export const credentialsSchema = z.object({
  username: z
    .string()
    .trim()
    .regex(/^[\p{L}\p{N}_-]{2,32}$/u, '用户名为2–32位汉字、字母、数字、下划线或横线'),
  password: z.string().min(10, '密码至少10位').max(128),
});
export function amountToCents(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('金额须为正数，最多两位小数');
  const [whole, decimal = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 99999999999)
    throw new Error('金额超出范围');
  return cents;
}
export function csvCell(v: unknown) {
  let text = String(v ?? '');
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
