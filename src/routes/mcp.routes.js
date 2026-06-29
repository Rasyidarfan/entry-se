/**
 * MCP (Model Context Protocol) HTTP server for SE2026 data.
 *
 * Transport: Streamable HTTP  — POST /mcp  (initialize + tool calls)
 *            SSE stream       — GET  /mcp  (server-sent events for streaming)
 *
 * Authentication: Bearer token via the same JWT mechanism as the REST API,
 * OR an MCP_API_KEY env var for machine-to-machine access.
 *
 * Tools exposed:
 *   list_assignments   — paginated assignment listing with filters
 *   get_assignment     — single assignment + latest submission summary
 *   get_submission     — full answers object for an assignment
 *   list_chunks        — raw submission chunks for an assignment
 *   get_statistics     — aggregate counts by status / type / region
 *   run_sql            — admin-only read-only SQL (SELECT only)
 */

import { query, queryOne } from '../db.js';
import config from '../config.js';
import jwt from 'jsonwebtoken';

// ── Auth ──────────────────────────────────────────────────────────────────────

function verifyMcpAuth(req) {
  // Option 1: static API key (server-to-server)
  const apiKey = config.mcpApiKey;
  if (apiKey) {
    const provided = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    if (provided === apiKey) return { role: 'admin', via: 'api_key' };
  }
  // Option 2: user JWT (same as REST API)
  const raw = req.headers.authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : null;
  if (!token) throw { status: 401, message: 'Auth required: Bearer JWT or X-Api-Key header.' };
  try {
    const claims = jwt.verify(token, config.auth.jwtSecret);
    if (claims.kind !== 'user') throw new Error('respondent token not allowed');
    return { role: claims.role, sub: claims.sub, via: 'jwt' };
  } catch {
    throw { status: 401, message: 'Invalid or expired token.' };
  }
}

// ── Tool definitions (JSON Schema) ───────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_assignments',
    description: 'List assignments (rumah tangga/bangunan/usaha) with optional filters. Returns paginated results.',
    inputSchema: {
      type: 'object',
      properties: {
        page:         { type: 'integer', default: 1, description: 'Page number (1-based)' },
        limit:        { type: 'integer', default: 25, description: 'Rows per page (max 100)' },
        status:       { type: 'string', enum: ['open','progress','done','clean','error'], description: 'Filter by assignment status' },
        prelist_type: { type: 'string', enum: ['keluarga','usaha'], description: 'Filter by type' },
        q:            { type: 'string', description: 'Search in nama, kode_identitas, alamat_prelist' },
        prov:         { type: 'string', description: 'Filter by province code' },
        kab:          { type: 'string', description: 'Filter by kab/kota code' },
        kec:          { type: 'string', description: 'Filter by kecamatan code' },
        desa:         { type: 'string', description: 'Filter by desa code' },
      },
    },
  },
  {
    name: 'get_assignment',
    description: 'Get a single assignment by ID, including its latest submission status and summary.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Assignment UUID' },
      },
    },
  },
  {
    name: 'get_submission',
    description: 'Get the full answers object for an assignment submission.',
    inputSchema: {
      type: 'object',
      required: ['assignment_id'],
      properties: {
        assignment_id: { type: 'string', description: 'Assignment UUID' },
      },
    },
  },
  {
    name: 'list_chunks',
    description: 'List raw submission chunks for an assignment. Each chunk contains answers for one questionnaire block.',
    inputSchema: {
      type: 'object',
      required: ['assignment_id'],
      properties: {
        assignment_id: { type: 'string', description: 'Assignment UUID' },
        block_id:      { type: 'string', description: 'Filter by block ID (e.g. "SE2026 - L BLOK I")' },
      },
    },
  },
  {
    name: 'get_statistics',
    description: 'Get aggregate statistics: counts by status, prelist_type, and optionally by region.',
    inputSchema: {
      type: 'object',
      properties: {
        group_by: { type: 'string', enum: ['status','prelist_type','prov_code','kab_code'], default: 'status' },
        prov:     { type: 'string', description: 'Narrow stats to this province code' },
        kab:      { type: 'string', description: 'Narrow stats to this kab code' },
      },
    },
  },
  {
    name: 'run_sql',
    description: 'Run a read-only SQL SELECT query against the SE2026 database. Admin only. Useful for ad-hoc analysis.',
    inputSchema: {
      type: 'object',
      required: ['sql'],
      properties: {
        sql:    { type: 'string', description: 'SQL SELECT statement' },
        params: { type: 'array', items: {}, description: 'Positional bind parameters' },
      },
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function toolListAssignments(args) {
  const page  = Math.max(1, parseInt(args.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(args.limit, 10) || 25));
  const offset = (page - 1) * limit;

  const conditions = [];
  const params = [];

  if (args.status)       { conditions.push('a.status = ?');        params.push(args.status); }
  if (args.prelist_type) { conditions.push('a.prelist_type = ?');   params.push(args.prelist_type); }
  if (args.prov)         { conditions.push('a.prov_code = ?');      params.push(args.prov); }
  if (args.kab)          { conditions.push('a.kab_code = ?');       params.push(args.kab); }
  if (args.kec)          { conditions.push('a.kec_code = ?');       params.push(args.kec); }
  if (args.desa)         { conditions.push('a.desa_code = ?');      params.push(args.desa); }
  if (args.q) {
    const like = `%${args.q}%`;
    conditions.push('(a.nama LIKE ? OR a.kode_identitas LIKE ? OR a.alamat_prelist LIKE ?)');
    params.push(like, like, like);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rows, countRow] = await Promise.all([
    query(
      `SELECT a.id, a.kode_identitas, a.nama, a.alamat_prelist,
              a.nomor_urut_bangunan, a.idsbr, a.nib, a.email,
              a.prelist_type, a.status, a.mode,
              a.prov_code, a.kab_code, a.kec_code, a.desa_code,
              a.created_at, a.updated_at,
              s.status AS submission_status, s.updated_at AS submission_updated_at
         FROM assignments a
         LEFT JOIN submissions s ON s.assignment_id = a.id
         ${where}
         ORDER BY a.updated_at DESC
         LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    ),
    queryOne(
      `SELECT COUNT(*) AS total FROM assignments a ${where}`,
      params
    ),
  ]);

  return {
    data: rows,
    total: countRow?.total ?? 0,
    page,
    limit,
    pages: Math.max(1, Math.ceil((countRow?.total ?? 0) / limit)),
  };
}

async function toolGetAssignment(args) {
  const row = await queryOne(
    `SELECT a.*, s.status AS submission_status, s.summary, s.updated_at AS submission_updated_at
       FROM assignments a
       LEFT JOIN submissions s ON s.assignment_id = a.id
      WHERE a.id = ?`,
    [args.id]
  );
  if (!row) throw { status: 404, message: `Assignment '${args.id}' not found.` };

  return {
    ...row,
    summary: row.summary ? JSON.parse(row.summary) : null,
  };
}

async function toolGetSubmission(args) {
  const row = await queryOne(
    'SELECT * FROM submissions WHERE assignment_id = ?',
    [args.assignment_id]
  );
  if (!row) throw { status: 404, message: `No submission for assignment '${args.assignment_id}'.` };

  return {
    ...row,
    answers: row.answers ? JSON.parse(row.answers) : {},
    summary: row.summary ? JSON.parse(row.summary) : {},
  };
}

async function toolListChunks(args) {
  const conditions = ['assignment_id = ?'];
  const params = [args.assignment_id];
  if (args.block_id) { conditions.push('block_id = ?'); params.push(args.block_id); }

  const rows = await query(
    `SELECT id, block_id, sequence_number, action, questionnaire_type,
            is_final_submission, created_at,
            payload
       FROM submission_chunks
      WHERE ${conditions.join(' AND ')}
      ORDER BY block_id, sequence_number`,
    params
  );

  return rows.map(r => ({
    ...r,
    payload: r.payload ? JSON.parse(r.payload) : {},
  }));
}

async function toolGetStatistics(args) {
  const groupBy = ['status', 'prelist_type', 'prov_code', 'kab_code'].includes(args.group_by)
    ? args.group_by : 'status';

  const conditions = [];
  const params = [];
  if (args.prov) { conditions.push('prov_code = ?'); params.push(args.prov); }
  if (args.kab)  { conditions.push('kab_code = ?');  params.push(args.kab); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await query(
    `SELECT ${groupBy} AS group_key, COUNT(*) AS count
       FROM assignments ${where}
      GROUP BY ${groupBy}
      ORDER BY count DESC`,
    params
  );

  const total = rows.reduce((s, r) => s + (Number(r.count) || 0), 0);

  return { group_by: groupBy, total, rows };
}

async function toolRunSql(args, caller) {
  if (caller.role !== 'admin') throw { status: 403, message: 'run_sql is admin-only.' };

  const sql = (args.sql || '').trim();
  if (!/^SELECT\b/i.test(sql)) throw { status: 400, message: 'Only SELECT statements are allowed.' };

  // Block dangerous keywords
  const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|ATTACH|DETACH|PRAGMA)\b/i;
  if (forbidden.test(sql)) throw { status: 400, message: 'Statement contains forbidden keywords.' };

  const rows = await query(sql, args.params || []);
  return { rows, count: rows.length };
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

async function callTool(name, args, caller) {
  switch (name) {
    case 'list_assignments': return toolListAssignments(args);
    case 'get_assignment':   return toolGetAssignment(args);
    case 'get_submission':   return toolGetSubmission(args);
    case 'list_chunks':      return toolListChunks(args);
    case 'get_statistics':   return toolGetStatistics(args);
    case 'run_sql':          return toolRunSql(args, caller);
    default: throw { status: 404, message: `Unknown tool: ${name}` };
  }
}

// ── MCP protocol helpers ──────────────────────────────────────────────────────

function mcpOk(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function mcpError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

// ── Route handler (mounted at /mcp) ──────────────────────────────────────────

export function handleMcp(req, res) {
  // SSE stream endpoint (GET /mcp) — minimal keep-alive for clients that open it
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.statusCode = 200;
    res.write('event: open\ndata: {}\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => clearInterval(ping));
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // Auth
  let caller;
  try {
    caller = verifyMcpAuth(req);
  } catch (err) {
    res.statusCode = err.status || 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(mcpError(null, -32001, err.message)));
    return;
  }

  const body = req.body || {};
  const { jsonrpc, id, method, params } = body;

  if (jsonrpc !== '2.0') {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(mcpError(id, -32600, 'Invalid JSON-RPC version')));
    return;
  }

  res.setHeader('Content-Type', 'application/json');

  // ── initialize ──
  if (method === 'initialize') {
    res.end(JSON.stringify(mcpOk(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'se2026-mcp', version: '1.0.0' },
    })));
    return;
  }

  // ── notifications/initialized (no response needed) ──
  if (method === 'notifications/initialized') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // ── tools/list ──
  if (method === 'tools/list') {
    res.end(JSON.stringify(mcpOk(id, { tools: TOOLS })));
    return;
  }

  // ── tools/call ──
  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments ?? {};

    callTool(toolName, toolArgs, caller)
      .then(result => {
        res.end(JSON.stringify(mcpOk(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        })));
      })
      .catch(err => {
        const status = err.status || 500;
        res.statusCode = status >= 500 ? 200 : 200; // MCP errors always 200 HTTP
        res.end(JSON.stringify(mcpOk(id, {
          content: [{ type: 'text', text: err.message || 'Internal error' }],
          isError: true,
        })));
      });
    return;
  }

  // ── unknown method ──
  res.end(JSON.stringify(mcpError(id, -32601, `Method not found: ${method}`)));
}
