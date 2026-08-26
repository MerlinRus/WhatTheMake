import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BarcodeScannerSession,
  type ScannerControls,
  type ScannerDecoder,
} from '../src/scanner-session.js';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fakeStream() {
  let stopCount = 0;
  const stream = {
    getTracks: () => [{ stop: () => (stopCount += 1) }],
  } as unknown as MediaStream;
  return { stream, stopCount: () => stopCount };
}

function fakeVideo(): HTMLVideoElement {
  return { srcObject: null } as unknown as HTMLVideoElement;
}

test('quick close stops a camera stream that resolves later', async () => {
  const media = deferred<MediaStream>();
  const fake = fakeStream();
  let decoderCalls = 0;
  const decoder: ScannerDecoder = {
    async decodeFromStream() {
      decoderCalls += 1;
      return { stop() {} };
    },
  };
  const session = new BarcodeScannerSession(() => media.promise, decoder);

  const started = session.start(fakeVideo(), () => {});
  session.stop();
  media.resolve(fake.stream);

  assert.equal(await started, 'CANCELLED');
  assert.equal(fake.stopCount(), 1);
  assert.equal(decoderCalls, 0);
});

test('active session stops decoder and every media track', async () => {
  const fake = fakeStream();
  const video = fakeVideo();
  let controlsStopCount = 0;
  const controls: ScannerControls = {
    stop: () => (controlsStopCount += 1),
  };
  const session = new BarcodeScannerSession(async () => fake.stream, {
    async decodeFromStream() {
      return controls;
    },
  });

  assert.equal(await session.start(video, () => {}), 'ACTIVE');
  assert.equal(video.srcObject, fake.stream);
  session.stop();

  assert.equal(controlsStopCount, 1);
  assert.equal(fake.stopCount(), 1);
  assert.equal(video.srcObject, null);
});

test('close during decoder setup stops late controls', async () => {
  const fake = fakeStream();
  const controlsReady = deferred<ScannerControls>();
  let controlsStopCount = 0;
  const session = new BarcodeScannerSession(async () => fake.stream, {
    decodeFromStream: async () => controlsReady.promise,
  });

  const started = session.start(fakeVideo(), () => {});
  await Promise.resolve();
  session.stop();
  controlsReady.resolve({ stop: () => (controlsStopCount += 1) });

  assert.equal(await started, 'CANCELLED');
  assert.equal(controlsStopCount, 1);
  assert.ok(fake.stopCount() >= 1);
});
