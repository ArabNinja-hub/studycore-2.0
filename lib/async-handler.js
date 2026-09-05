'use strict';

// Express 4 forwards synchronous throws, but not rejected route promises.
// Keep failures on the request's error-middleware path instead of logging an
// unhandled rejection and leaving the client waiting indefinitely.
module.exports = function asyncHandler(handler) {
  return function handleAsyncRequest(req, res, next) {
    return Promise.resolve().then(() => handler(req, res, next)).catch(next);
  };
};
