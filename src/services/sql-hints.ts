// Read hints understood by the multi-node adapter.
//
// Authentication is not eventually consistent. A refresh token, a device
// session stamp and a user's security stamp are written by the request that
// creates them and read back moments later by the request that continues the
// session. Sending that read to a replica that is one replay behind returns
// "row not found", which is indistinguishable from "this credential is invalid"
// — so the caller deletes the token and clears the cookie. The login works,
// and the next page load logs the user out. That is exactly the symptom this
// hint exists to kill.
//
// So those statements carry an inline comment. MySQL ignores it, D1 ignores it,
// and MySqlClusterDatabase routes the statement to the node that holds the
// committed writes.

export const PRIMARY_READ_HINT = '/* nw:primary */';

const PRIMARY_READ_PATTERN = /\/\*\s*nw:primary\s*\*\//i;

export function wantsPrimaryRead(sql: string): boolean {
  return PRIMARY_READ_PATTERN.test(sql);
}
