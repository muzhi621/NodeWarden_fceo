// A minimal S3-compatible server for tests.
//
// It exists to *verify* the client rather than to be a full S3: every request
// must carry a correct AWS Signature V4, computed here from the raw request line
// and headers with an implementation that shares no code with the uploader. A
// signature that does not match is rejected with the same 403 body AWS/OSS/COS
// return, so a canonicalization bug in the client shows up as a red test instead
// of as a mysterious failure in production.
//
// Supported: PUT/GET/HEAD/DELETE object, GET ?list-type=2 (prefix, delimiter,
// continuation-token, max-keys).

import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface S3ObjectRecord {
  body: Uint8Array;
  contentType: string;
}

export interface S3ServerOptions {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Objects pre-seeded into the bucket (key -> body). */
  seed?: Record<string, string>;
  /** Force the listing page size, to exercise continuation tokens. */
  pageSize?: number;
}

export interface S3TestServer {
  endpoint: string;
  objects: Map<string, S3ObjectRecord>;
  requests: Array<{ method: string; url: string; authorization: string | null }>;
  close: () => Promise<void>;
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash('sha256').update(typeof value === 'string' ? Buffer.from(value, 'utf8') : value).digest('hex');
}

function hmac(key: Buffer | string, message: string): Buffer {
  return createHmac('sha256', key).update(message, 'utf8').digest();
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeQueryPart(value: string): string {
  // S3 does not decode '+' as a space in query strings (unlike form encoding):
  // a client that sends '+' signs a different canonical form than the server
  // computes, and gets SignatureDoesNotMatch. Keep it literal here so the test
  // catches that class of bug.
  return decodeURIComponent(value);
}

function canonicalQuery(rawQuery: string): string {
  if (!rawQuery) return '';
  return rawQuery
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const index = pair.indexOf('=');
      const key = index === -1 ? pair : pair.slice(0, index);
      const value = index === -1 ? '' : pair.slice(index + 1);
      return [decodeQueryPart(key), decodeQueryPart(value)] as [string, string];
    })
    .map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join('&');
}

function parseAuthorization(header: string): { accessKeyId: string; scope: string; signedHeaders: string; signature: string } | null {
  const match = /^AWS4-HMAC-SHA256\s+(.*)$/.exec(header.trim());
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const part of match[1].split(',')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    fields.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  const credential = fields.get('Credential');
  const signedHeaders = fields.get('SignedHeaders');
  const signature = fields.get('Signature');
  if (!credential || !signedHeaders || !signature) return null;
  const [accessKeyId, ...scopeParts] = credential.split('/');
  return { accessKeyId, scope: scopeParts.join('/'), signedHeaders, signature };
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function errorXml(code: string, message: string, status: number): { status: number; body: string } {
  return {
    status,
    body:
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code>` +
      `<Message>${xmlEscape(message)}</Message><RequestId>test</RequestId></Error>`,
  };
}

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

export async function startS3Server(options: S3ServerOptions): Promise<S3TestServer> {
  const objects = new Map<string, S3ObjectRecord>();
  for (const [key, body] of Object.entries(options.seed ?? {})) {
    objects.set(key, { body: new Uint8Array(Buffer.from(body, 'utf8')), contentType: 'application/octet-stream' });
  }
  const requests: S3TestServer['requests'] = [];

  const server = http.createServer((request, response) => {
    void (async () => {
      const rawUrl = request.url ?? '/';
      requests.push({ method: request.method ?? 'GET', url: rawUrl, authorization: request.headers.authorization ?? null });

      const authorization = parseAuthorization(String(request.headers.authorization ?? ''));
      if (!authorization) {
        const detail = errorXml('AccessDenied', 'Anonymous access is forbidden', 403);
        response.writeHead(detail.status, { 'Content-Type': 'application/xml' });
        response.end(detail.body);
        return;
      }
      if (authorization.accessKeyId !== options.accessKeyId) {
        const detail = errorXml('InvalidAccessKeyId', 'The access key does not exist', 403);
        response.writeHead(detail.status, { 'Content-Type': 'application/xml' });
        response.end(detail.body);
        return;
      }

      const body = await readBody(request);
      const payloadHash = String(request.headers['x-amz-content-sha256'] ?? sha256Hex(body));
      const amzDate = String(request.headers['x-amz-date'] ?? '');
      if (!amzDate) {
        const detail = errorXml('AccessDenied', 'Missing x-amz-date', 403);
        response.writeHead(detail.status, { 'Content-Type': 'application/xml' });
        response.end(detail.body);
        return;
      }

      const rawPath = rawUrl.split('?')[0];
      const rawQuery = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '';
      const signedHeaderNames = authorization.signedHeaders.split(';');
      const canonicalHeaders = signedHeaderNames
        .map((name) => `${name}:${String(request.headers[name] ?? '').trim().replace(/\s+/g, ' ')}`)
        .join('\n');
      const canonicalRequest = [
        String(request.method).toUpperCase(),
        rawPath || '/',
        canonicalQuery(rawQuery),
        `${canonicalHeaders}\n`,
        authorization.signedHeaders,
        payloadHash,
      ].join('\n');

      const scope = authorization.scope;
      const [dateStamp] = scope.split('/');
      const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
      const kDate = hmac(`AWS4${options.secretAccessKey}`, dateStamp);
      const kRegion = hmac(kDate, options.region);
      const kService = hmac(kRegion, 's3');
      const kSigning = hmac(kService, 'aws4_request');
      const expected = hmac(kSigning, stringToSign).toString('hex');

      if (expected !== authorization.signature) {
        const detail = errorXml(
          'SignatureDoesNotMatch',
          'The request signature we calculated does not match the signature you provided.',
          403
        );
        response.writeHead(detail.status, { 'Content-Type': 'application/xml' });
        response.end(detail.body);
        return;
      }

      // --- Bucket/object routing (path-style: /bucket/key) ------------------
      const trimmedPath = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
      const slash = trimmedPath.indexOf('/');
      const bucket = slash === -1 ? trimmedPath : trimmedPath.slice(0, slash);
      const key = slash === -1 ? '' : decodeURIComponent(trimmedPath.slice(slash + 1));

      if (!key && request.method === 'GET') {
        const params = new URLSearchParams(rawQuery);
        const prefix = params.get('prefix') ?? '';
        const delimiter = params.get('delimiter') ?? '';
        const token = params.get('continuation-token') ?? '';
        // Real S3 percent-encodes keys and prefixes when the client asks for
        // encoding-type=url, which is the only way a key containing '&' or '<'
        // survives an XML parser. Mirror it so the client's decoding is tested.
        const encodingType = params.get('encoding-type') === 'url' ? 'url' : '';
        const encodeForList = (value: string) => (encodingType ? encodeURIComponent(value) : xmlEscape(value));
        const allKeys = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort();
        const start = token ? Number(Buffer.from(token, 'base64').toString('utf8')) : 0;
        const pageSize = options.pageSize ?? 1000;
        const page = allKeys.slice(start, start + pageSize);
        const contents = page
          .map((name) => {
            const record = objects.get(name)!;
            return (
              `<Contents><Key>${encodeForList(name)}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified>` +
              `<ETag>"x"</ETag><Size>${record.body.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`
            );
          })
          .join('');
        const nextToken = start + pageSize < allKeys.length ? Buffer.from(String(start + pageSize)).toString('base64') : '';
        const commonPrefixes = delimiter
          ? [
              ...new Set(
                page
                  .map((name) => {
                    const rest = name.slice(prefix.length);
                    const index = rest.indexOf(delimiter);
                    return index === -1 ? null : prefix + rest.slice(0, index + delimiter.length);
                  })
                  .filter((value): value is string => !!value)
              ),
            ]
              .map((value) => `<CommonPrefixes><Prefix>${encodeForList(value)}</Prefix></CommonPrefixes>`)
              .join('')
          : '';
        const xml =
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
          `<Name>${xmlEscape(bucket)}</Name><Prefix>${encodeForList(prefix)}</Prefix><KeyCount>${page.length}</KeyCount>` +
          `<MaxKeys>${pageSize}</MaxKeys>${nextToken ? `<IsTruncated>true</IsTruncated>` : '<IsTruncated>false</IsTruncated>'}` +
          `${encodingType ? `<EncodingType>url</EncodingType>` : ''}` +
          `<NextContinuationToken>${nextToken}</NextContinuationToken>${contents}${commonPrefixes}</ListBucketResult>`;
        response.writeHead(200, { 'Content-Type': 'application/xml' });
        response.end(xml);
        return;
      }

      if (request.method === 'PUT' && key) {
        objects.set(key, {
          body: new Uint8Array(body),
          contentType: String(request.headers['content-type'] ?? 'application/octet-stream'),
        });
        response.writeHead(200, { ETag: '"test"' });
        response.end();
        return;
      }

      if ((request.method === 'GET' || request.method === 'HEAD') && key) {
        const record = objects.get(key);
        if (!record) {
          const detail = errorXml('NoSuchKey', 'The specified key does not exist.', 404);
          response.writeHead(detail.status, { 'Content-Type': 'application/xml' });
          response.end(request.method === 'HEAD' ? undefined : detail.body);
          return;
        }
        response.writeHead(200, {
          'Content-Type': record.contentType,
          'Content-Length': String(record.body.byteLength),
          'Last-Modified': 'Wed, 01 Jan 2026 00:00:00 GMT',
        });
        response.end(request.method === 'HEAD' ? undefined : Buffer.from(record.body));
        return;
      }

      if (request.method === 'DELETE' && key) {
        objects.delete(key);
        response.writeHead(204);
        response.end();
        return;
      }

      const detail = errorXml('NotImplemented', `${request.method} ${rawUrl} is not supported by the test server`, 501);
      response.writeHead(detail.status, { 'Content-Type': 'application/xml' });
      response.end(detail.body);
    })().catch((error) => {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end(String(error));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    objects,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
