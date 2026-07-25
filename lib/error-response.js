// Builds the JSON body for a 500 response. In production we return a generic
// message so internal details (Mongo errors, collection names, stack hints)
// never leak to clients; in non-production we pass the real message through to
// keep debugging easy. The full error is always logged server-side by the caller.
function errorBody(err, { production } = {}) {
  return {
    error: production ? 'Internal server error' : (err && err.message) || 'Internal server error'
  };
}

module.exports = { errorBody };
