// Entry point: Express app serving the static frontend (app/public) + REST API
// (§2). MCP server (§8) is deferred and intentionally not mounted yet.

import express from './tiny-express.js';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import config from './config.js';
import { errorHandler } from './middleware/errors.js';
import { getForm } from './services/validation.service.js';
import apiRoutes from './routes/core.routes.js';
import { handleMcp } from './routes/mcp.routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const app = express();
app.use(express.json({ limit: '5mb' }));

app.use((req, res, next) => {
  if (config.env === 'production') {
    const proto = req.get('x-forwarded-proto') || req.protocol;
    if (proto !== 'https') {
      return res.redirect(`https://${req.get('host')}${req.url}`);
    }
  }
  next();
});

// ── API ──────────────────────────────────────────────────────────────────────
app.use('/api', apiRoutes);

// Parsed FormGear template (blocks/fields/validation) — used by the renderer.
app.get('/api/form', (_req, res, next) => {
  try {
    res.json(getForm());
  } catch (err) {
    next(err);
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, env: config.env }));

// ── MCP server (Model Context Protocol) ──────────────────────────────────────
app.get('/mcp', handleMcp);
app.post('/mcp', handleMcp);

// ── Static frontend ──────────────────────────────────────────────────────────
// Landing → Data screen (auth gate handled client-side; redirects to login).
app.get('/', (_req, res) => res.redirect('/data/'));
app.get('/data', (req, res) => {
  if (req.path === '/data' || req.path === '/data/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    createReadStream(join(PUBLIC_DIR, 'data.html')).pipe(res);
  } else {
    res.redirect('/data/');
  }
});
// Clean URL for the respondent page: force a versioned URL so stale SW/HTML
// caches do not keep serving older respondent gate behaviour.
app.get('/respondent', (req, res) => {
  const url = new URL(req.url, `http://${req.get('host') || 'localhost'}`);
  if (url.searchParams.get('v') !== '10') {
    url.searchParams.set('v', '10');
    return res.redirect(`${url.pathname}${url.search}`);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  createReadStream(join(PUBLIC_DIR, 'respondent.html')).pipe(res);
});
app.use(express.static(PUBLIC_DIR));

// Error handler last.
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`SE2026 Entry → http://localhost:${config.port}  (env: ${config.env})`);
});
