'use strict';

/**
 * Vercel serverless function: mints a short-lived Ably token scoped to ONE
 * room's channel. The Ably API key lives only here (server-side, from an env
 * var) — it is never sent to the browser. A token for room A cannot touch
 * room B, so demo sessions stay isolated.
 */

const Ably = require('ably');

function normRoom(raw) {
  const cleaned = String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  return cleaned || 'DEMO';
}

module.exports = async (req, res) => {
  const key = process.env.ABLY_API_KEY;
  if (!key) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'ABLY_API_KEY not configured' }));
    return;
  }

  const room = normRoom(req.query ? req.query.room : undefined);

  try {
    const rest = new Ably.Rest(key);
    const tokenRequest = await rest.auth.createTokenRequest({
      capability: JSON.stringify({ ['room:' + room]: ['publish', 'subscribe', 'presence'] }),
      ttl: 60 * 60 * 1000, // 1 hour; the client re-auths automatically
    });

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(tokenRequest));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'token_error' }));
  }
};
