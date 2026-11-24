'use strict';
// Route error handling shared by every module.
//
// - HttpError carries its own status (404 not found, 409 conflict, ...).
// - Plain `new Error('...')` from a route is a validation message for the user → 400, not logged.
// - ENOENT (a file or folder that isn't there) → 404.
// - Anything that looks like a bug or a system failure (TypeError, EACCES, ENOSPC, ...) → 500, logged with its stack,
//   so problems show up in `docker logs` instead of only as a vague message in the browser.
// The status is never taken from e.status: GitHub API errors carry GitHub's status there, and passing a GitHub 401
// through would make the UI think *you* are signed out.

class HttpError extends Error {
  constructor(httpStatus, message) {
    super(message);
    this.name = 'HttpError';
    this.httpStatus = httpStatus;
  }
}
const notFound = (msg = 'not found') => new HttpError(404, msg);

const PROGRAMMER_ERRORS = [TypeError, ReferenceError, SyntaxError, RangeError];

function statusFor(e) {
  if (e && Number.isInteger(e.httpStatus) && e.httpStatus >= 400 && e.httpStatus <= 599) return e.httpStatus;
  if (!e) return 400;
  if (e.code === 'ENOENT') return 404;                           // e.g. a file the UI asked for is gone
  if (e.code === 'ENOTDIR' || e.code === 'EISDIR') return 400;
  if (PROGRAMMER_ERRORS.some((T) => e instanceof T) || (typeof e.code === 'string' && /^E[A-Z]+$/.test(e.code))) return 500;
  return 400;
}

function makeWrap(log = console.error) {
  return (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
    const status = statusFor(e);
    if (status >= 500) log(`[agent-hub] ${req.method} ${req.originalUrl || req.url} failed:`, e?.stack || e);
    if (res.headersSent) { try { res.end(); } catch {} return; }
    res.status(status).json({ error: e?.message || String(e) });
  });
}

module.exports = { HttpError, notFound, statusFor, makeWrap, wrap: makeWrap() };
