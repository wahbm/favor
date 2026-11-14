import { buildApp } from './app.js';
import { pool } from './db.js';
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.APP_ORIGIN?.startsWith('https://') || !process.env.DATABASE_URL)
)
  throw new Error('生产环境须配置HTTPS APP_ORIGIN和DATABASE_URL');
const app = await buildApp();
await app.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 3000) });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
