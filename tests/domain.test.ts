import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amountToCents, dateSchema, today, csvCell } from '../src/shared/domain.js';
test('金额精确到分并拒绝科学计数、负数、零及超限金额', () => {
  assert.equal(amountToCents('1000.01'), 100001);
  assert.equal(amountToCents('0.1'), 10);
  assert.equal(amountToCents('999999999.99'), 99999999999);
  for (const value of ['0', '-1', '1e3', '1.001', '1000000000', 'NaN'])
    assert.throws(() => amountToCents(value));
});
test('日期按北京时间，仅接受1900年以来真实的历史日期和今天', () => {
  assert.equal(dateSchema.parse(today()), today());
  assert.equal(dateSchema.parse('2018-02-28'), '2018-02-28');
  for (const value of ['2023-02-29', '2024-02-30', '2999-01-01', '1899-12-31', '2024-1-01'])
    assert.equal(dateSchema.safeParse(value).success, false);
});
test('CSV 转义引号、换行和公式注入', () => {
  assert.equal(csvCell('a"b\nc'), '"a""b\nc"');
  assert.equal(csvCell('=1+1'), '"\'=1+1"');
  assert.equal(csvCell(' @SUM(A1)'), '"\' @SUM(A1)"');
});
test('北京时间午夜边界正确', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-14T15:59:59Z') });
  assert.equal(today(), '2026-11-14');
  t.mock.timers.tick(1000);
  assert.equal(today(), '2026-11-15');
});
