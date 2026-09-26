// Tiny in-memory GET cache for anonymous-safe public endpoints.
// Keyed on full URL, short TTL. Only caches 200 JSON responses.
const store = new Map(); // key -> { body, expires }

function cacheGet(ttlSeconds) {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    const key = req.originalUrl;
    const hit = store.get(key);
    if (hit && hit.expires > Date.now()) {
      res.set('X-Cache', 'HIT');
      res.set('Cache-Control', `public, max-age=${ttlSeconds}`);
      return res.type('application/json').send(hit.body);
    }
    const origSend = res.send.bind(res);
    res.send = (body) => {
      if (res.statusCode === 200 && typeof body === 'string') {
        if (store.size > 500) store.clear();
        store.set(key, { body, expires: Date.now() + ttlSeconds * 1000 });
        res.set('X-Cache', 'MISS');
        res.set('Cache-Control', `public, max-age=${ttlSeconds}`);
      }
      return origSend(body);
    };
    next();
  };
}

module.exports = { cacheGet };
