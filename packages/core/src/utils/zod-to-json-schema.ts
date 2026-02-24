/**
 * Zod to JSON Schema Converter
 *
 * Converts Zod schemas to JSON Schema format for LLM tool definitions.
 * This implementation supports Zod 4's internal structure.
 */

import type { z } from 'zod';

type JsonSchema = Record<string, unknown>;

type ZodDef = {
  type: string;
  description?: string;
  checks?: Array<{ kind: string; value?: unknown }>;
  innerType?: z.ZodSchema<unknown>;
  element?: z.ZodSchema<unknown>;
  shape?: Record<string, z.ZodSchema<unknown>>;
  entries?: Record<string, string>;
  value?: unknown;
  options?: z.ZodSchema<unknown>[];
  valueType?: z.ZodSchema<unknown>;
  defaultValue?: () => unknown;
  schema?: z.ZodSchema<unknown>;
  minLength?: number;
  maxLength?: number;
};

/**
 * Convert a Zod schema to JSON Schema format
 */
export function zodToJsonSchema(schema: z.ZodSchema<unknown>): JsonSchema {
  const def = (schema as unknown as { _def: ZodDef })._def;

  switch (def.type) {
    case 'string':
      return handleString(def);

    case 'number':
      return handleNumber(def);

    case 'boolean':
      return { type: 'boolean' };

    case 'array':
      return handleArray(def);

    case 'object':
      return handleObject(def);

    case 'optional':
      return zodToJsonSchema(def.innerType as z.ZodSchema<unknown>);

    case 'nullable':
      return {
        oneOf: [
          zodToJsonSchema(def.innerType as z.ZodSchema<unknown>),
          { type: 'null' },
        ],
      };

    case 'enum':
      return {
        type: 'string',
        enum: def.entries ? Object.values(def.entries) : [],
      };

    case 'literal':
      return {
        const: def.value,
      };

    case 'union':
      return {
        oneOf: (def.options as z.ZodSchema<unknown>[]).map(zodToJsonSchema),
      };

    case 'record':
      return {
        type: 'object',
        additionalProperties: zodToJsonSchema(def.valueType as z.ZodSchema<unknown>),
      };

    case 'default': {
      const innerSchema = zodToJsonSchema(def.innerType as z.ZodSchema<unknown>);
      const defaultValue = def.defaultValue ? def.defaultValue() : undefined;
      return {
        ...innerSchema,
        default: defaultValue,
      };
    }

    case 'effects':
      return zodToJsonSchema(def.schema as z.ZodSchema<unknown>);

    default:
      return {};
  }
}

function handleString(def: ZodDef): JsonSchema {
  const schema: JsonSchema = { type: 'string' };

  // Handle string constraints if present
  const checks = def.checks as Array<{ kind: string; value?: unknown }> | undefined;
  if (checks) {
    for (const check of checks) {
      switch (check.kind) {
        case 'min':
          schema.minLength = check.value;
          break;
        case 'max':
          schema.maxLength = check.value;
          break;
        case 'email':
          schema.format = 'email';
          break;
        case 'url':
          schema.format = 'uri';
          break;
        case 'uuid':
          schema.format = 'uuid';
          break;
        case 'regex':
          schema.pattern = (check.value as RegExp).source;
          break;
      }
    }
  }

  // Handle description
  if (def.description) {
    schema.description = def.description;
  }

  return schema;
}

function handleNumber(def: ZodDef): JsonSchema {
  const schema: JsonSchema = { type: 'number' };

  // Handle number constraints if present
  const checks = def.checks as Array<{ kind: string; value?: unknown }> | undefined;
  if (checks) {
    for (const check of checks) {
      switch (check.kind) {
        case 'min':
          schema.minimum = check.value;
          break;
        case 'max':
          schema.maximum = check.value;
          break;
        case 'int':
          schema.type = 'integer';
          break;
      }
    }
  }

  // Handle description
  if (def.description) {
    schema.description = def.description;
  }

  return schema;
}

function handleArray(def: ZodDef): JsonSchema {
  const schema: JsonSchema = {
    type: 'array',
    items: def.element ? zodToJsonSchema(def.element) : {},
  };

  if (def.minLength !== undefined) {
    schema.minItems = def.minLength;
  }
  if (def.maxLength !== undefined) {
    schema.maxItems = def.maxLength;
  }

  if (def.description) {
    schema.description = def.description;
  }

  return schema;
}

function handleObject(def: ZodDef): JsonSchema {
  const shape = def.shape || {};

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    properties[key] = zodToJsonSchema(value);

    const valueDef = (value as unknown as { _def: ZodDef })._def;
    if (valueDef.type !== 'optional' && valueDef.type !== 'default') {
      required.push(key);
    }
  }

  const schema: JsonSchema = {
    type: 'object',
    properties,
  };

  if (required.length > 0) {
    schema.required = required;
  }

  if (def.description) {
    schema.description = def.description;
  }

  return schema;
}
