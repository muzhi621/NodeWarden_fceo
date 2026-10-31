// 健康检查（/healthz）
//
// EdgeOne Pages maps this file to a URL and calls onRequest(context); the heavy
// lifting lives in the bundled runtime (scripts/build-edgeone.mjs).

import { handleEdgeOneRequest } from './_nodewarden/runtime.mjs';

export function onRequest(context) {
  return handleEdgeOneRequest(context);
}

export default onRequest;
