// Aliyun FC "Web 函数" startup entry — the same file that ships at the root
// of nodewarden-fc.zip (see FC-DEPLOY.md section 九). Kept in the repository so
// the documented package layout and the released ZIP can never drift apart.
//
// The FC code directory is read-only and only /tmp is writable, so the
// writable data directory defaults to /tmp/nodewarden (set DATA_DIR to
// override, e.g. a mounted NAS path).

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/nodewarden';
process.env.ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR || `${process.env.DATA_DIR}/attachments`;
process.env.PORT = process.env.PORT || '9000';

// 1) Register the cloudflare:workers stub: the bundled server/index.mjs still
//    imports that specifier, which plain Node cannot resolve on its own.
await import('./server/register-cf-stub.mjs');

// 2) Start the bundled server (plain JS, no TypeScript toolchain needed).
await import('./server/index.mjs');
