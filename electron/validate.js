// Shared input validation helpers for all write-path modules.
//
// The app previously had strong authentication/authorization but almost no
// *data* validation: unbounded TEXT fields, no numeric ceilings, and no row
// caps on bulk imports. These helpers enforce type, presence, max length and
// numeric range at every IPC write entry point so a bad payload (buggy renderer
// or crafted input) cannot bloat the DB, exhaust CPU/memory, or store nonsense.

// Max lengths, chosen generously for real election data while still bounded.
const LIMITS = {
  electionTitle: 300,
  positionTitle: 300,
  candidateName: 300,
  stationName: 200,
  stationLocation: 200,
  officerName: 100,
  officerId: 64,
  voterId: 64,
  voterName: 200,
  phone: 32,
  machineName: 200,
  notes: 2000,
};

// Max number of rows accepted in a single bulk import (CSV / run pack).
const MAX_IMPORT_ROWS = 20000;

function isString(v) { return typeof v === 'string'; }

// Require a non-empty (after trim) string within [min, max] length.
function requiredString(value, field, { max = 300, min = 1 } = {}) {
  if (value === undefined || value === null) {
    return { ok: false, code: 'missing', error: `${field} is required` };
  }
  if (!isString(value)) {
    return { ok: false, code: 'invalid', error: `${field} must be text` };
  }
  const trimmed = value.trim();
  if (trimmed.length < min) {
    return { ok: false, code: 'invalid', error: `${field} is required` };
  }
  if (trimmed.length > max) {
    return { ok: false, code: 'too_long', error: `${field} must be ${max} characters or fewer (got ${trimmed.length})` };
  }
  return { ok: true };
}

// Optional string: if present, must be text and within length.
function optionalString(value, field, { max = 300 } = {}) {
  if (value === undefined || value === null || value === '') return { ok: true };
  if (!isString(value)) {
    return { ok: false, code: 'invalid', error: `${field} must be text` };
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    return { ok: false, code: 'too_long', error: `${field} must be ${max} characters or fewer` };
  }
  return { ok: true };
}

// Require an integer within [min, max].
function intInRange(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isFinite(n)) {
    return { ok: false, code: 'invalid', error: `${field} must be a number` };
  }
  if (n < min || n > max || !Number.isInteger(n)) {
    return { ok: false, code: 'invalid', error: `${field} must be a whole number between ${min} and ${max}` };
  }
  return { ok: true };
}

// Optional integer within [min, max].
function optionalIntInRange(value, field, opts = {}) {
  if (value === undefined || value === null || value === '') return { ok: true };
  return intInRange(value, field, opts);
}

module.exports = {
  LIMITS,
  MAX_IMPORT_ROWS,
  requiredString,
  optionalString,
  intInRange,
  optionalIntInRange,
};
