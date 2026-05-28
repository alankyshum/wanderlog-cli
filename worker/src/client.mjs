export async function fetchTrip(env, tripKey) {
  if (!tripKey) throw new Error('tripKey is required');
  if (!env.WANDERLOG_COOKIE) throw new Error('upstream auth failure');
  const baseUrl = (env.WANDERLOG_BASE_URL || 'https://wanderlog.com').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/api/tripPlans/${encodeURIComponent(tripKey)}?clientSchemaVersion=2`, {
    method: 'GET',
    headers: {
      Cookie: env.WANDERLOG_COOKIE,
      Accept: 'application/json',
    },
  });

  if (response.status === 401 || response.status === 403) throw new Error('upstream auth failure');
  if (response.status === 404) throw new Error('upstream not found');
  if (!response.ok) throw new Error(`upstream error ${response.status}`);
  return response.json();
}
