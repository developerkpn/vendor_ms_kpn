// Generic, domain-agnostic helpers for the material feature (warehouse_be utils
// layer). Pure functions only — no DB, no Express, no material business rules.

// Collapse runs of whitespace to single spaces and trim.
const normalizeWhitespace = value =>
    String(value || "")
        .replace(/\s+/g, " ")
        .trim();

module.exports = {
    normalizeWhitespace,
};
