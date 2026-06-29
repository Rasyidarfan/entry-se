import fs from 'node:fs';
import { extname, join, normalize } from 'node:path';
import http from 'node:http';
import { URL } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function withSlash(path) {
  if (!path) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

function compilePath(path) {
  const keys = [];
  const source = withSlash(path)
    .replace(/\/+$/, '')
    .replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
  return {
    keys,
    regex: new RegExp(`^${source || '/'}$`),
  };
}

function decorate(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  req.path = url.pathname;
  req.query = Object.fromEntries(url.searchParams.entries());
  req.get = (name) => req.headers[String(name).toLowerCase()];
  req.protocol = req.socket.encrypted ? 'https' : 'http';
  req.params = req.params || {};

  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  };
  res.send = (body) => {
    if (typeof body === 'object' && !Buffer.isBuffer(body)) return res.json(body);
    res.end(body);
  };
  res.redirect = (location) => {
    res.statusCode = res.statusCode >= 300 && res.statusCode < 400 ? res.statusCode : 302;
    res.setHeader('Location', location);
    res.end();
  };
}

function matchPrefix(prefix, path) {
  const p = withSlash(prefix).replace(/\/+$/, '') || '/';
  if (p === '/') return true;
  return path === p || path.startsWith(`${p}/`);
}

function runHandlers(handlers, req, res, out, err) {
  let index = 0;
  const next = (nextErr) => {
    const handler = handlers[index++];
    if (!handler) return out(nextErr);
    try {
      if (nextErr) {
        if (handler.length === 4) return handler(nextErr, req, res, next);
        return next(nextErr);
      }
      if (handler.length === 4) return next();
      return handler(req, res, next);
    } catch (caught) {
      next(caught);
    }
  };
  next(err);
}

function createApp(isRouter = false) {
  const stack = [];

  const app = (req, res, out = (() => {}), incomingErr = null) => {
    decorate(req, res);
    let idx = 0;

    const done = (err) => {
      if (typeof out === 'function') return out(err);
      if (err) {
        res.statusCode = err.status || 500;
        res.end(err.message || 'Internal Server Error');
        return;
      }
      if (!res.writableEnded) {
        res.statusCode = 404;
        res.end('Not Found');
      }
    };

    const next = (err) => {
      const layer = stack[idx++];
      if (!layer) return done(err);

      if (layer.type === 'error') {
        if (!err) return next();
        try {
          return layer.handler(err, req, res, next);
        } catch (caught) {
          return next(caught);
        }
      }

      if (err) return next(err);

      if (layer.type === 'middleware') {
        if (!matchPrefix(layer.path, req.path)) return next();
        const originalUrl = req.url;
        if (layer.path && layer.path !== '/') {
          req.url = req.url.slice(layer.path.length) || '/';
          if (!req.url.startsWith('/')) req.url = `/${req.url}`;
          decorate(req, res);
        }
        try {
          return layer.handler(req, res, (mwErr) => {
            req.url = originalUrl;
            decorate(req, res);
            next(mwErr);
          });
        } catch (caught) {
          req.url = originalUrl;
          decorate(req, res);
          return next(caught);
        }
      }

      if (layer.type === 'route') {
        if (req.method !== layer.method) return next();
        const match = layer.regex.exec(req.path.replace(/\/+$/, '') || '/');
        if (!match) return next();
        req.params = {};
        layer.keys.forEach((key, i) => { req.params[key] = decodeURIComponent(match[i + 1]); });
        return runHandlers(layer.handlers, req, res, next);
      }

      return next();
    };

    next(incomingErr);
  };

  app.__isRouter = isRouter;
  app.use = (path, handler) => {
    if (typeof path === 'function') {
      handler = path;
      path = '/';
    }
    if (handler.length === 4) stack.push({ type: 'error', handler });
    else stack.push({ type: 'middleware', path: withSlash(path), handler });
    return app;
  };

  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    app[method.toLowerCase()] = (path, ...handlers) => {
      const compiled = compilePath(path);
      stack.push({
        type: 'route',
        method,
        path: withSlash(path),
        regex: compiled.regex,
        keys: compiled.keys,
        handlers,
      });
      return app;
    };
  }

  app.listen = (port, cb) => {
    const server = http.createServer((req, res) => app(req, res));
    return server.listen(port, cb);
  };

  return app;
}

function json() {
  return (req, _res, next) => {
    if (req.body !== undefined) return next();
    if (req.method === 'GET' || req.method === 'HEAD') {
      req.body = {};
      return next();
    }
    const type = req.headers['content-type'] || '';
    if (!type.includes('application/json')) {
      req.body = {};
      return next();
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        req.body = raw ? JSON.parse(raw) : {};
        next();
      } catch (err) {
        err.status = 400;
        err.code = 'BAD_JSON';
        next(err);
      }
    });
    req.on('error', next);
  };
}

function staticMiddleware(rootDir) {
  return (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) return next();
    let filePath = decodeURIComponent(req.path);
    if (filePath === '/') filePath = '/index.html';
    const abs = normalize(join(rootDir, filePath));
    if (!abs.startsWith(normalize(rootDir))) return next();
    fs.stat(abs, (err, stat) => {
      if (err || !stat.isFile()) return next();
      res.setHeader('Content-Type', MIME[extname(abs)] || 'application/octet-stream');
      fs.createReadStream(abs).pipe(res);
    });
  };
}

function express() {
  return createApp(false);
}

express.Router = () => createApp(true);
express.json = json;
express.static = staticMiddleware;

export default express;
