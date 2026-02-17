import tap from 'tap';

process.env.NODE_ENV = 'test';

const { default: fastify } = await import('../index.js');

tap.teardown(async () => {
  await fastify.close();
});

tap.test('Fastify server', async t => {
  await t.test('GET /', async t => {
    const response = await fastify.inject({ method: 'GET', url: '/' });
    t.equal(response.statusCode, 200, 'returns a status code of 200');
    t.same(response.json(), { message: 'Vonage Voiceサーバーが稼働中です。' }, 'returns the correct message');
  });

  await t.test('GET /_/health', async t => {
    const response = await fastify.inject({ method: 'GET', url: '/_/health' });
    t.equal(response.statusCode, 200, 'returns a status code of 200');
    t.same(response.body, 'OK', 'returns the correct message');
  });

  await t.test('GET /_/metrics', async t => {
    const response = await fastify.inject({ method: 'GET', url: '/_/metrics' });
    t.equal(response.statusCode, 200, 'returns a status code of 200');
    t.same(response.body, 'OK', 'returns the correct message');
  });

  await t.test('POST /event', async t => {
    const response = await fastify.inject({ method: 'POST', url: '/event' });
    t.equal(response.statusCode, 200, 'returns a status code of 200');
    t.same(response.body, 'OK', 'returns the correct message');
  });

  await t.test('POST /answer', async t => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/answer',
      payload: { from: '819012345678', to: '81312345678', uuid: 'test-uuid-123' }
    });
    t.equal(response.statusCode, 200, 'returns a status code of 200');
    const body = response.json();
    t.equal(body[0].action, 'talk', 'first action is talk');
    t.equal(body[0].text, '担当者にお繋ぎいたしますので、このまま少々お待ちください。', 'talk text is correct');
    t.equal(body[1].action, 'connect', 'second action is connect');
    const wsUri = body[1].endpoint[0].uri;
    t.ok(wsUri.includes('caller=819012345678'), 'URI contains caller parameter');
    t.ok(wsUri.includes('called=81312345678'), 'URI contains called parameter');
    t.ok(wsUri.includes('uuid=test-uuid-123'), 'URI contains uuid parameter');
    t.ok(wsUri.includes('token='), 'URI contains token parameter');
    t.equal(body[1].endpoint[0].contentType, 'audio/l16;rate=16000', 'contentType is correct');
  });

  await t.test('POST /connect without API key returns 401', async t => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/connect',
      payload: { to: '+818012345678' }
    });
    t.equal(response.statusCode, 401, 'requires API key');
  });

  await t.test('POST /connect with invalid API key returns 403', async t => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/connect',
      headers: { 'x-api-key': 'invalid-key' },
      payload: { to: '+818012345678' }
    });
    t.equal(response.statusCode, 403, 'rejects invalid API key');
  });
});