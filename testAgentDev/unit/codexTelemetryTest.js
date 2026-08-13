import assert from 'assert';
import http from 'http';
import {
  extractConversationRecordsFromProtobuf,
  startCodexTelemetryReceiver
} from '../codexTelemetry.js';

function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function fieldBytes(field, bytes) {
  return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes]);
}

function stringField(field, value) {
  return fieldBytes(field, Buffer.from(value));
}

function anyString(value) {
  return stringField(1, value);
}

function keyValue(key, value) {
  return Buffer.concat([stringField(1, key), fieldBytes(2, anyString(value))]);
}

function attributes(values) {
  return Buffer.concat(Object.entries(values).map(([key, value]) =>
    fieldBytes(6, keyValue(key, value))));
}

function logRecord({ body, attributes: values = {} }) {
  return Buffer.concat([
    fieldBytes(5, anyString(body)),
    attributes(values)
  ]);
}

function payload(model = 'gpt-5.6-sol', conversationId = 'thread-exact', {
  includeModel = true,
  duplicate = false
} = {}) {
  const values = {
    'event.name': 'codex.conversation_starts',
    'conversation.id': conversationId,
    originator: 'codex_exec',
    'account.email': 'must-never-be-retained@example.invalid'
  };
  if (includeModel) {
    values.model = model;
  }
  const records = [
    logRecord({
      body: 'codex.api_request',
      attributes: { model: 'irrelevant' }
    }),
    logRecord({ body: 'codex.conversation_starts', attributes: values })
  ];
  if (duplicate) {
    records.push(logRecord({ body: 'codex.conversation_starts', attributes: values }));
  }
  const resource = fieldBytes(1, keyValue('service.name', 'codex-cli'));
  const scopeLogs = Buffer.concat(records.map((record) => fieldBytes(2, record)));
  const resourceLogs = Buffer.concat([
    fieldBytes(1, resource),
    fieldBytes(2, scopeLogs)
  ]);
  return fieldBytes(1, resourceLogs);
}

function postProtobuf(url, body, contentType = 'application/x-protobuf') {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        'content-type': contentType,
        'content-length': body.length
      }
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end(body);
  });
}

describe('Codex OTel model resolver', () => {
  it('extracts only the exact conversation-start model attribute', () => {
    assert.deepStrictEqual(extractConversationRecordsFromProtobuf(
      payload('gpt-exact-default')
    ), [{
      conversation_id: 'thread-exact',
      model: 'gpt-exact-default'
    }]);
  });

  it('receives OTLP/HTTP protobuf and resolves one exact model', async () => {
    const receiver = await startCodexTelemetryReceiver({ timeoutMs: 500 });
    try {
      assert.strictEqual(
        await postProtobuf(receiver.endpoint, payload('gpt-live-default')),
        200
      );
      assert.strictEqual(
        await receiver.resolvedModel('thread-exact'),
        'gpt-live-default'
      );
    } finally {
      await receiver.close();
    }
  });

  it('fails honestly when the conversation event omits model metadata', () => {
    assert.throws(
      () => extractConversationRecordsFromProtobuf(payload(undefined, undefined, {
        includeModel: false
      })),
      /did not include its resolved model/
    );
  });

  it('rejects a mismatched thread and duplicate records for one thread', async () => {
    const receiver = await startCodexTelemetryReceiver({ timeoutMs: 50 });
    try {
      await postProtobuf(receiver.endpoint, payload('wrong-model', 'different-thread'));
      await assert.rejects(
        receiver.resolvedModel('expected-thread'),
        /did not match JSONL thread/
      );
      await postProtobuf(receiver.endpoint, payload('first', 'different-thread', {
        duplicate: true
      }));
      await assert.rejects(
        receiver.resolvedModel('different-thread'),
        /found \[/
      );
    } finally {
      await receiver.close();
    }
  });

  it('rejects an unrelated conversation even when the expected record is present', async () => {
    const receiver = await startCodexTelemetryReceiver({ timeoutMs: 200 });
    try {
      await postProtobuf(receiver.endpoint, payload('expected-model', 'expected-thread'));
      await postProtobuf(receiver.endpoint, payload('other-model', 'other-thread'));
      await assert.rejects(
        receiver.resolvedModel('expected-thread'),
        /exactly one conversation-start record/
      );
    } finally {
      await receiver.close();
    }
  });

  it('fails closed on malformed or non-protobuf OTLP', async () => {
    const receiver = await startCodexTelemetryReceiver({ timeoutMs: 50 });
    try {
      assert.strictEqual(await postProtobuf(receiver.endpoint, Buffer.from([0xff])), 400);
      await assert.rejects(receiver.resolvedModel('thread-exact'));
    } finally {
      await receiver.close();
    }

    const wrongType = await startCodexTelemetryReceiver({ timeoutMs: 50 });
    try {
      assert.strictEqual(
        await postProtobuf(wrongType.endpoint, payload(), 'application/json'),
        400
      );
    } finally {
      await wrongType.close();
    }
  });
});
