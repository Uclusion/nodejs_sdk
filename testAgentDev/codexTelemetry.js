import assert from 'assert';
import http from 'http';

const MAX_OTLP_BYTES = 2 * 1024 * 1024;

function readVarint(bytes, cursor) {
  let value = 0n;
  let shift = 0n;
  for (let index = 0; index < 10; index += 1) {
    assert(cursor.offset < bytes.length, 'Truncated protobuf varint');
    const byte = bytes[cursor.offset];
    cursor.offset += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return value;
    }
    shift += 7n;
  }
  throw new Error('Oversized protobuf varint');
}

function readBytes(bytes, cursor) {
  const length = Number(readVarint(bytes, cursor));
  assert(Number.isSafeInteger(length) && length >= 0, 'Invalid protobuf byte length');
  const end = cursor.offset + length;
  assert(end <= bytes.length, 'Truncated protobuf length-delimited field');
  const value = bytes.subarray(cursor.offset, end);
  cursor.offset = end;
  return value;
}

function skipField(bytes, cursor, wireType) {
  if (wireType === 0) {
    readVarint(bytes, cursor);
    return;
  }
  if (wireType === 1) {
    cursor.offset += 8;
  } else if (wireType === 2) {
    readBytes(bytes, cursor);
    return;
  } else if (wireType === 5) {
    cursor.offset += 4;
  } else {
    throw new Error(`Unsupported protobuf wire type ${wireType}`);
  }
  assert(cursor.offset <= bytes.length, 'Truncated protobuf fixed-width field');
}

function visitMessage(bytes, visitor) {
  const cursor = { offset: 0 };
  while (cursor.offset < bytes.length) {
    const tag = Number(readVarint(bytes, cursor));
    const field = tag >>> 3;
    const wireType = tag & 7;
    assert(field > 0, 'Invalid protobuf field number');
    const handled = visitor({ bytes, cursor, field, wireType });
    if (!handled) {
      skipField(bytes, cursor, wireType);
    }
  }
}

function protobufAnyValue(bytes) {
  let value;
  visitMessage(bytes, ({ cursor, field, wireType }) => {
    if (field === 1 && wireType === 2) {
      value = readBytes(bytes, cursor).toString('utf8');
      return true;
    }
    if ([2, 3].includes(field) && wireType === 0) {
      value = String(readVarint(bytes, cursor));
      return true;
    }
    if (field === 4 && wireType === 1) {
      assert(cursor.offset + 8 <= bytes.length, 'Truncated protobuf double');
      value = String(bytes.readDoubleLE(cursor.offset));
      cursor.offset += 8;
      return true;
    }
    if (field === 7 && wireType === 2) {
      value = readBytes(bytes, cursor).toString('base64');
      return true;
    }
    return false;
  });
  return value;
}

function protobufKeyValue(bytes) {
  let key;
  let value;
  visitMessage(bytes, ({ cursor, field, wireType }) => {
    if (field === 1 && wireType === 2) {
      key = readBytes(bytes, cursor).toString('utf8');
      return true;
    }
    if (field === 2 && wireType === 2) {
      value = protobufAnyValue(readBytes(bytes, cursor));
      return true;
    }
    return false;
  });
  return key ? [key, value] : null;
}

function protobufAttributes(bytes, repeatedField) {
  const attributes = new Map();
  visitMessage(bytes, ({ cursor, field, wireType }) => {
    if (field === repeatedField && wireType === 2) {
      const pair = protobufKeyValue(readBytes(bytes, cursor));
      if (pair) {
        attributes.set(pair[0], pair[1]);
      }
      return true;
    }
    return false;
  });
  return attributes;
}

function protobufLogRecord(bytes) {
  let body;
  const attributes = new Map();
  visitMessage(bytes, ({ cursor, field, wireType }) => {
    if (field === 5 && wireType === 2) {
      body = protobufAnyValue(readBytes(bytes, cursor));
      return true;
    }
    if (field === 6 && wireType === 2) {
      const pair = protobufKeyValue(readBytes(bytes, cursor));
      if (pair) {
        attributes.set(pair[0], pair[1]);
      }
      return true;
    }
    return false;
  });
  return { body, attributes };
}

export function decodeOtlpProtobuf(payload) {
  const records = [];
  visitMessage(payload, ({ bytes, cursor, field, wireType }) => {
    if (field !== 1 || wireType !== 2) {
      return false;
    }
    const resourceLog = readBytes(bytes, cursor);
    const resourceAttributes = new Map();
    const logRecords = [];
    visitMessage(resourceLog, ({ bytes: resourceBytes, cursor: resourceCursor,
      field: resourceField, wireType: resourceWireType }) => {
      if (resourceField === 1 && resourceWireType === 2) {
        const resource = readBytes(resourceBytes, resourceCursor);
        for (const [key, value] of protobufAttributes(resource, 1)) {
          resourceAttributes.set(key, value);
        }
        return true;
      }
      if (resourceField === 2 && resourceWireType === 2) {
        const scopeLogs = readBytes(resourceBytes, resourceCursor);
        visitMessage(scopeLogs, ({ bytes: scopeBytes, cursor: scopeCursor,
          field: scopeField, wireType: scopeWireType }) => {
          if (scopeField === 2 && scopeWireType === 2) {
            logRecords.push(protobufLogRecord(readBytes(scopeBytes, scopeCursor)));
            return true;
          }
          return false;
        });
        return true;
      }
      return false;
    });
    for (const record of logRecords) {
      records.push({ resourceAttributes, ...record });
    }
    return true;
  });
  return records;
}

export function extractConversationRecordsFromProtobuf(payload) {
  const records = [];
  for (const record of decodeOtlpProtobuf(payload)) {
    const name = record.attributes.get('event.name') ||
      record.attributes.get('event_name') ||
      record.attributes.get('name') ||
      record.body;
    if (name !== 'codex.conversation_starts') {
      continue;
    }
    const model = record.attributes.get('model') || record.resourceAttributes.get('model');
    const conversationId = record.attributes.get('conversation.id') ||
      record.attributes.get('conversation_id') || record.resourceAttributes.get('conversation.id');
    assert(model, 'Codex OTel conversation-start event did not include its resolved model');
    assert(conversationId,
      'Codex OTel conversation-start event did not include its conversation id');
    records.push({ conversation_id: conversationId, model });
  }
  return records;
}

export async function startCodexTelemetryReceiver({
  host = '127.0.0.1',
  timeoutMs = 5000
} = {}) {
  const conversationRecords = [];
  const errors = [];
  let lastConversationRecordAt = 0;
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/logs') {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= MAX_OTLP_BYTES) {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      try {
        assert(bytes <= MAX_OTLP_BYTES, 'Codex OTel payload exceeded receiver limit');
        assert.strictEqual(
          String(request.headers['content-type'] || '').split(';')[0].trim(),
          'application/x-protobuf',
          'Codex OTel receiver accepts only OTLP protobuf'
        );
        assert(!request.headers['content-encoding'] || request.headers['content-encoding'] === 'identity',
          'Compressed Codex OTel payloads are unsupported');
        const payload = Buffer.concat(chunks);
        // Keep only the two allowlisted correlation fields. Raw telemetry can
        // contain account identity and tool data and is intentionally discarded.
        const extracted = extractConversationRecordsFromProtobuf(payload);
        conversationRecords.push(...extracted);
        if (extracted.length) {
          lastConversationRecordAt = Date.now();
        }
        response.writeHead(200, { 'content-type': 'application/x-protobuf' });
        response.end();
      } catch (error) {
        errors.push(error);
        response.writeHead(400, { 'content-type': 'text/plain' });
        response.end('invalid OTLP protobuf payload');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'Codex OTel receiver has no TCP address');

  return {
    endpoint: `http://${host}:${address.port}/v1/logs`,
    async resolvedModel(conversationId) {
      assert(conversationId, 'Codex OTel resolution requires the JSONL thread id');
      const deadline = Date.now() + timeoutMs;
      while (
        Date.now() <= deadline &&
        errors.length === 0 && (
          !conversationRecords.some((record) => record.conversation_id === conversationId) ||
          Date.now() - lastConversationRecordAt < 50
        )
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (errors.length) {
        throw errors[0];
      }
      assert.strictEqual(
        conversationRecords.length,
        1,
        `Codex OTel must expose exactly one conversation-start record for ` +
          `${conversationId}; found ${JSON.stringify(conversationRecords)}`
      );
      assert.strictEqual(
        conversationRecords[0].conversation_id,
        conversationId,
        `Codex OTel conversation id did not match JSONL thread ${conversationId}`
      );
      return conversationRecords[0].model;
    },
    async close() {
      if (!server.listening) {
        return;
      }
      await new Promise((resolve, reject) => server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }));
    }
  };
}
