// The deep scan captures whatever is actually sitting in a store's
// window.dataLayer on page load, verbatim, then returns it in the API
// response and persists it into a lead's cached scan. Today's homepage-only,
// anonymous, read-only scan usually finds empty PII containers (e.g. Shopify's
// own Enhanced Conversions scaffolding pushes `user_data: { address: {} }`
// with nothing filled in) — but nothing in the capture path enforces that,
// it's incidental, not a guarantee. A store whose theme populates real
// customer data into the homepage dataLayer (session personalization, a
// misconfigured theme) would have it captured, shown in the UI, and written
// to plain unencrypted JSON on disk. This redacts before either happens.

// Whole-object containers that only ever hold PII by convention (GA4 Enhanced
// Conversions user_data, Shopify customer/address objects) — redact
// everything nested under these regardless of what fields they contain.
const PII_CONTAINER_KEYS = /^(user_data|customer|address|billing|shipping|billing_address|shipping_address)$/i;

// Individual fields that carry PII even outside one of the containers above.
const PII_FIELD_KEYS = /^(email|e_?mail|phone|phone_number|mobile|first_name|last_name|full_name|fname|lname|street|street_address|address1|address2|postal_code|zip|zipcode|ip|ip_address)$/i;

// Value-based fallback for PII sitting under an unexpected/custom key name.
// Deliberately narrow (email only) to avoid false-positive redaction of
// legitimate diagnostic values like prices, SKUs, or timestamps.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const REDACTED = '[REDACTED]';

function redactPII(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redactPII(v));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (PII_CONTAINER_KEYS.test(key) || PII_FIELD_KEYS.test(key)) {
        out[key] = v === null || v === undefined ? v : REDACTED;
      } else {
        out[key] = redactPII(v);
      }
    }
    return out;
  }
  if (typeof value === 'string' && EMAIL_PATTERN.test(value.trim())) {
    return REDACTED;
  }
  return value;
}

module.exports = { redactPII, REDACTED };
