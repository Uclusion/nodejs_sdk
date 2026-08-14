import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error.code)) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

export function atomicWriteBytes(targetPath, bytes) {
  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, targetPath);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

export function atomicWriteJson(targetPath, value) {
  atomicWriteBytes(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

export function ratchetIfAllPassed({
  results,
  expectedCount,
  targetPath,
  pins,
  baselineBytes = fs.readFileSync(targetPath),
  writeJson = atomicWriteJson,
  writeBytes = atomicWriteBytes
}) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1) {
    throw new Error('expectedCount must be a positive safe integer');
  }
  if (results.length !== expectedCount || results.some((result) => result.status !== 'passed')) {
    return false;
  }
  try {
    writeJson(targetPath, pins);
  } catch (error) {
    try {
      writeBytes(targetPath, baselineBytes);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Last-known-good ratchet failed and its baseline rollback also failed'
      );
    }
    throw error;
  }
  return true;
}
