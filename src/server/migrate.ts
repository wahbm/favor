import { migrate, pool } from './db.js';
try {
  await migrate();
  console.log('数据库结构已就绪（v1）');
} finally {
  await pool.end();
}
