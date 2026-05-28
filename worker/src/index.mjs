import {
  handleAddSubscription,
  handleDeleteSubscription,
  handleListSubscriptions,
  handlePatchSubscription,
  handlePreviewIcs,
  handlePublicIcs,
  handleRefresh,
  jsonResponse,
} from './handlers.mjs';

export default {
  async fetch(request, env, ctx) {
    void ctx;
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const method = request.method.toUpperCase();

    if ((path === '/wanderlog' && method === 'GET') || (path === '/wanderlog.ics' && (method === 'GET' || method === 'HEAD'))) {
      return handlePublicIcs(request, env);
    }

    if (path === '/wanderlog/api/v1/health' && method === 'GET') {
      return jsonResponse({ status: 'ok' });
    }

    if (!path.startsWith('/wanderlog/api/v1/')) return new Response('Not found', { status: 404 });
    if (!isAdmin(request, env)) return new Response(null, { status: 401 });

    if (path === '/wanderlog/api/v1/subscriptions' && method === 'GET') return handleListSubscriptions(request, env);
    if (path === '/wanderlog/api/v1/subscriptions' && method === 'POST') return handleAddSubscription(request, env);
    if (path === '/wanderlog/api/v1/refresh' && method === 'POST') return handleRefresh(request, env);
    if (path === '/wanderlog/api/v1/preview.ics' && method === 'GET') return handlePreviewIcs(request, env);

    const match = path.match(/^\/wanderlog\/api\/v1\/subscriptions\/([^/]+)$/);
    if (match && method === 'DELETE') return handleDeleteSubscription(request, env, decodeURIComponent(match[1]));
    if (match && method === 'PATCH') return handlePatchSubscription(request, env, decodeURIComponent(match[1]));

    return new Response('Not found', { status: 404 });
  },
};

function isAdmin(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  return request.headers.get('Authorization') === `Bearer ${expected}`;
}
