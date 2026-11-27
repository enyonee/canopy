import { Ajv } from 'ajv';

// Canopy lengths count UTF-16 code units and enum comparisons preserve JSON key order.
export function compiler(formats) {
  const ajv = new Ajv({ strict: false, strictNumbers: true, validateSchema: false, unicodeRegExp: false, formats });
  ajv.addKeyword({ keyword: 'canopyMinLength', type: 'string', validate: (n, v) => v.length >= n });
  ajv.addKeyword({ keyword: 'canopyMaxLength', type: 'string', validate: (n, v) => v.length <= n });
  ajv.addKeyword({ keyword: 'canopyEnum', compile: (values) => {
    const allowed = new Set(values.map((v) => JSON.stringify(v)));
    return (v) => allowed.has(JSON.stringify(v));
  } });
  const cache = new WeakMap();
  return (schema) => {
    if (!cache.has(schema)) {
      const wire = wireSchema(schema);
      cache.set(schema, ajv.compile(wire));
      if (wire !== false) ajv.removeSchema(wire);
    }
    return cache.get(schema);
  };
}

function wireSchema({ type, properties, required, additionalProperties, items, enum: values, format, pattern,
  minimum, maximum, minLength, maxLength }) {
  // Ajv omits the __proto__ property from its generated checks.
  if (properties && Object.hasOwn(properties, '__proto__')) return false;
  return {
    type, format, pattern, minimum, maximum, required,
    ...(properties && { properties: Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, wireSchema(v)])),
      additionalProperties: additionalProperties ?? true }),
    ...(items && { items: wireSchema(items) }),
    ...(values && { canopyEnum: values }),
    ...(minLength !== undefined && { canopyMinLength: minLength }),
    ...(maxLength !== undefined && { canopyMaxLength: maxLength }),
  };
}
