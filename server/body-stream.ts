// Size-limited request body stream.
//
// The self-hosted entry hands the socket to the fetch pipeline as a stream, so
// the body is never buffered whole. That removes the implicit ceiling the old
// buffering code enforced, so the ceiling has to be re-applied while the bytes
// flow — otherwise a chunked upload (no `content-length`) is unbounded.

import { Readable, Transform } from 'node:stream';

export interface LimitedBody {
  /** The body, as the fetch pipeline expects it. */
  stream: ReadableStream;
  /** True once the stream was cut short because it grew past the limit. */
  exceeded: () => boolean;
}

export function createLimitedBody(source: Readable, maxBytes: number): LimitedBody {
  let received = 0;
  let exceeded = false;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) {
        exceeded = true;
        callback(new Error('Payload too large'));
        return;
      }
      callback(null, chunk);
    },
  });
  source.on('error', (error) => limiter.destroy(error));
  // `pipe` also unpipes on a destination error, so an overflow stops pulling
  // bytes off the socket instead of draining the whole upload to throw it away.
  source.pipe(limiter);
  return {
    stream: Readable.toWeb(limiter) as unknown as ReadableStream,
    exceeded: () => exceeded,
  };
}
