import type { Plugin } from 'vite';
import fs from 'fs';
import path from 'path';

const STORE_DIR = path.resolve(__dirname, '.tmp_dev_store');
const API_PREFIX = '/api/dev-store/';

function sanitizeKey(raw: string): string {
  const decoded = decodeURIComponent(raw);
  return decoded.replace(/[^a-zA-Z0-9\-_]/g, '_');
}

function ensureStoreDir() {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

export default function devStorePlugin(): Plugin {
  return {
    name: 'dev-store',
    apply: 'serve',
    configureServer(server) {
      ensureStoreDir();

      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(API_PREFIX)) return next();

        const rawKey = req.url.slice(API_PREFIX.length);
        if (!rawKey) return next();

        const key = sanitizeKey(rawKey);
        const filePath = path.join(STORE_DIR, `${key}.json`);

        if (req.method === 'GET') {
          if (!fs.existsSync(filePath)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'not found' }));
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(fs.readFileSync(filePath, 'utf-8'));
          return;
        }

        if (req.method === 'PUT') {
          let body = '';
          req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          req.on('end', () => {
            ensureStoreDir();
            fs.writeFileSync(filePath, body, 'utf-8');
            res.statusCode = 204;
            res.end();
          });
          return;
        }

        next();
      });
    },
  };
}
