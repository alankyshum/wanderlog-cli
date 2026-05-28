import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';

import { BrowserUnavailableError } from '../src/errors.mjs';
import { captureCookieViaBrowser, isSignedInUrl, parseTimeout } from '../src/browser.mjs';

const LOGIN_URL = 'https://wanderlog.com/login';

test('captureCookieViaBrowser detects sign-in and returns connect.sid cookie', async t => {
  const server = await createCdpServer({
    onCommand(command, sendEvent) {
      if (command.method === 'Page.getFrameTree') {
        queueMicrotask(() => sendEvent('Page.frameNavigated', {
          frame: { id: 'root', url: 'https://wanderlog.com/discover' },
        }));
        return { frameTree: { frame: { id: 'root', url: LOGIN_URL } } };
      }
      if (command.method === 'Network.getCookies') {
        return {
          cookies: [{
            name: 'connect.sid',
            value: 'SIGNED_COOKIE',
            domain: '.wanderlog.com',
            path: '/',
            expires: 1802649600,
            httpOnly: true,
            secure: true,
          }],
        };
      }
      return {};
    },
  });
  t.after(() => server.close());

  const result = await captureCookieViaBrowser({
    chromePath: '/fake/chrome',
    port: server.port,
    timeout: '2s',
    settleMs: 0,
    spawn: fakeSpawn,
  });

  assert.equal(result.cookieValue, 'SIGNED_COOKIE');
  assert.deepEqual(result.cookie, {
    name: 'connect.sid',
    value: 'SIGNED_COOKIE',
    domain: '.wanderlog.com',
    path: '/',
    expires: 1802649600,
    httpOnly: true,
    secure: true,
    sameSite: undefined,
  });
});

test('captureCookieViaBrowser treats current non-login top frame as signed in', async t => {
  const server = await createCdpServer({
    onCommand(command) {
      if (command.method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'root', url: 'https://wanderlog.com/' } } };
      }
      if (command.method === 'Network.getCookies') {
        return { cookies: [{ name: 'connect.sid', value: 'ALREADY_IN', domain: '.wanderlog.com', path: '/' }] };
      }
      return {};
    },
  });
  t.after(() => server.close());

  const result = await captureCookieViaBrowser({
    chromePath: '/fake/chrome',
    port: server.port,
    timeout: '2s',
    settleMs: 0,
    spawn: fakeSpawn,
  });

  assert.equal(result.cookieValue, 'ALREADY_IN');
});

test('captureCookieViaBrowser detects sign-in via polling and stops polling after resolution', async t => {
  let getCookiesCalls = 0;
  let getFrameTreeCalls = 0;
  const server = await createCdpServer({
    onCommand(command) {
      if (command.method === 'Network.getCookies') {
        getCookiesCalls += 1;
        const signedIn = getCookiesCalls >= 2;
        return {
          cookies: signedIn ? [{ name: 'connect.sid', value: 's:abc', domain: '.wanderlog.com', path: '/' }] : [],
        };
      }
      if (command.method === 'Page.getFrameTree') {
        getFrameTreeCalls += 1;
        const signedIn = getFrameTreeCalls >= 2;
        return { frameTree: { frame: { id: 'root', url: signedIn ? 'https://wanderlog.com/' : LOGIN_URL } } };
      }
      return {};
    },
  });
  t.after(() => server.close());

  const result = await captureCookieViaBrowser({
    chromePath: '/fake/chrome',
    port: server.port,
    timeout: '2s',
    settleMs: 30,
    pollIntervalMs: 5,
    spawn: fakeSpawn,
  });

  assert.equal(result.cookieValue, 's:abc');
  assert.equal(getFrameTreeCalls, 2);
  assert.equal(getCookiesCalls, 3);
});

test('captureCookieViaBrowser detects sign-in via navigatedWithinDocument event', async t => {
  const server = await createCdpServer({
    onCommand(command, sendEvent) {
      if (command.method === 'Page.getFrameTree') {
        queueMicrotask(() => sendEvent('Page.navigatedWithinDocument', {
          frameId: 'root',
          url: 'https://wanderlog.com/trips',
        }));
        return { frameTree: { frame: { id: 'root', url: LOGIN_URL } } };
      }
      if (command.method === 'Network.getCookies') {
        return { cookies: [{ name: 'connect.sid', value: 'WITHIN_DOC', domain: '.wanderlog.com', path: '/' }] };
      }
      return {};
    },
  });
  t.after(() => server.close());

  const result = await captureCookieViaBrowser({
    chromePath: '/fake/chrome',
    port: server.port,
    timeout: '2s',
    settleMs: 0,
    spawn: fakeSpawn,
  });

  assert.equal(result.cookieValue, 'WITHIN_DOC');
});

test('captureCookieViaBrowser times out when no signed-in navigation occurs', async t => {
  const server = await createCdpServer({
    onCommand(command) {
      if (command.method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'root', url: LOGIN_URL } } };
      }
      return {};
    },
  });
  t.after(() => server.close());

  await assert.rejects(
    () => captureCookieViaBrowser({
      chromePath: '/fake/chrome',
      port: server.port,
      timeout: 30,
      settleMs: 0,
      spawn: fakeSpawn,
    }),
    err => {
      assert.ok(err instanceof BrowserUnavailableError);
      assert.match(err.message, /Sign-in not completed/);
      return true;
    },
  );
});

test('parseTimeout accepts milliseconds, seconds, and minutes', () => {
  assert.equal(parseTimeout(undefined, 123), 123);
  assert.equal(parseTimeout('300000'), 300000);
  assert.equal(parseTimeout('30s'), 30000);
  assert.equal(parseTimeout('10m'), 600000);
});

test('isSignedInUrl rejects login paths after stripping query and hash', () => {
  assert.equal(isSignedInUrl('https://wanderlog.com/', 'https://wanderlog.com'), true);
  assert.equal(isSignedInUrl('https://wanderlog.com/trips?login=false#login', 'https://wanderlog.com'), true);
  assert.equal(isSignedInUrl('https://wanderlog.com/login', 'https://wanderlog.com'), false);
  assert.equal(isSignedInUrl('https://wanderlog.com/login?redirect=/', 'https://wanderlog.com'), false);
  assert.equal(isSignedInUrl('https://wanderlog.com/login#email', 'https://wanderlog.com'), false);
  assert.equal(isSignedInUrl('https://wanderlog.com/login/email?redirect=/', 'https://wanderlog.com'), false);
  assert.equal(isSignedInUrl('https://example.com/', 'https://wanderlog.com'), false);
});

async function createCdpServer({ onCommand }) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{
        type: 'page',
        url: LOGIN_URL,
        webSocketDebuggerUrl: `ws://localhost:${server.address().port}/devtools/page/1`,
      }]));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const accept = crypto
      .createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));

    let buffer = Buffer.alloc(0);
    const sendJson = payload => socket.write(encodeWebSocketText(JSON.stringify(payload)));
    const sendEvent = (method, params) => sendJson({ method, params });

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const decoded = decodeWebSocketText(buffer);
        if (!decoded) break;
        buffer = buffer.subarray(decoded.bytesRead);
        let command;
        try {
          command = JSON.parse(decoded.text);
        } catch {
          continue;
        }
        if (command.method === undefined) continue;
        const result = onCommand(command, sendEvent) || {};
        sendJson({ id: command.id, result });
        if (command.method === 'Browser.close') socket.end();
      }
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    }),
  };
}

function fakeSpawn() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = signal => {
    child.signalCode = signal;
    child.emit('exit', null, signal);
    return true;
  };
  setTimeout(() => {
    child.exitCode = 0;
    child.emit('exit', 0, null);
  }, 5);
  return child;
}

function decodeWebSocketText(buffer) {
  if (buffer.length < 2) return null;
  const second = buffer[1];
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  const maskBytes = masked ? 4 : 0;
  if (buffer.length < offset + maskBytes + length) return null;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  offset += maskBytes;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  }
  return { text: payload.toString('utf8'), bytesRead: offset + length };
}

function encodeWebSocketText(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}
