import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteStore } from './store.ts';
import { createApi } from './http.ts';
import { worldProfileReader } from './world-profile.ts';

mkdirSync('.data', { recursive: true, mode: 0o700 });
const development = process.env.NODE_ENV !== 'production'
  && (process.env.NODE_ENV === 'development' || process.argv.includes('--dev'));
const council = process.env.BANK_COUNCIL_IDS?.split(',').map(id => id.trim()).filter(Boolean);
const store = new SqliteStore(join('.data', 'terra.sqlite'), Date.now, development ? 20 : 1, council);
const server = createApi(store, process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173',
  process.env.WORLD_PROFILE_API_ORIGIN ? worldProfileReader(process.env.WORLD_PROFILE_API_ORIGIN) : undefined);
const port = Number(process.env.PORT ?? 3001);
server.listen(port, '127.0.0.1', () => console.log(`Featheral API listening on http://127.0.0.1:${port}; server clock ${development ? '20x (development)' : '1x (production)'}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { server.closeAllConnections(); server.close(() => { store.close(); process.exit(0); }); });
}
