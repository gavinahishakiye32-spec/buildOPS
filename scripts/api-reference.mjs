#!/usr/bin/env node
// Renders docs/api-reference.md from the OpenAPI document plus the access-control
// decorators that OpenAPI does not carry (permissions, public routes, org header).
// Deterministic: same inputs produce a byte-identical file, so the drift guard in
// test/openapi-artifact.e2e-spec.ts can compare it.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'api-reference.md');
const HTTP = ['get', 'post', 'put', 'patch', 'delete'];

/* ------------------------------------------------------------------ source */

/** PermissionName -> literal, e.g. TASK_VIEW -> 'task.view'. */
function permissionValues() {
  const src = readFileSync(join(ROOT, 'src/common/permissions.ts'), 'utf8');
  const values = new Map();
  for (const m of src.matchAll(/^\s{2}([A-Z_]+):\s*'([a-z_.]+)'/gm)) {
    values.set(m[1], m[2]);
  }
  return values;
}

/* ------------------------------------------------------------------ schema */

const isRef = (schema) => Boolean(schema?.$ref);

function deref(document, schema) {
  let current = schema;
  while (isRef(current)) {
    const name = current.$ref.replace('#/components/schemas/', '');
    current = document.components.schemas[name];
  }
  return current;
}

const typeName = (schema) => {
  if (!schema) return '—';
  if (isRef(schema)) return schema.$ref.replace('#/components/schemas/', '');
  if (schema.type === 'array') {
    return `${typeName(schema.items)}[]`;
  }
  if (schema.enum) {
    return schema.enum.map((v) => `\`${v}\``).join(' \\| ');
  }
  if (schema.oneOf) return schema.oneOf.map((s) => typeName(s)).join(' \\| ');
  if (schema.allOf) {
    const parts = schema.allOf.map((s) => derefName(s)).filter((n) => n !== 'unknown');
    return [...new Set(parts)].join(' & ');
  }
  // A field declared `T | null` loses its primitive in the emitted schema
  // (reflect-metadata cannot express the union), so it arrives as a bare
  // `object` with an example. The example is the only signal left.
  if (schema.type === 'object' && !schema.properties && !schema.$ref) {
    if (schema.example === null) return 'null';
    if (typeof schema.example === 'string') return 'string';
    if (typeof schema.example === 'number') return 'number';
    if (typeof schema.example === 'boolean') return 'boolean';
    return 'object';
  }
  if (schema.type === 'object' || schema.properties) return 'object';
  if (schema.format) return `${schema.type} (${schema.format})`;
  return schema.type ?? '—';
};

const derefName = (schema) =>
  isRef(schema) ? schema.$ref.replace('#/components/schemas/', '') : (schema?.type ?? 'unknown');

/** Flattens $refs so a field table shows real types instead of wrapper names. */
function fieldRows(document, schema, depth = 0) {
  const resolved = deref(document, schema);
  const required = new Set(resolved.required ?? []);
  const rows = [];

  for (const [name, prop] of Object.entries(resolved.properties ?? {})) {
    const details = [];
    if (prop.enum) details.push(prop.enum.join(', '));
    if (prop.format === 'date-time') details.push('ISO 8601');
    if (prop.minimum !== undefined) details.push(`min ${prop.minimum}`);
    if (prop.maximum !== undefined) details.push(`max ${prop.maximum}`);
    if (prop.minLength !== undefined) details.push(`min length ${prop.minLength}`);
    if (prop.maxLength !== undefined) details.push(`max length ${prop.maxLength}`);
    if (prop.nullable) details.push('nullable');
    if (prop.default !== undefined) details.push(`default ${prop.default}`);

    rows.push([
      `\`${name}\`` + (required.has(name) ? ' (required)' : ''),
      typeName(prop),
      details.join(', ') || '—',
      prop.example === undefined ? '—' : `\`${JSON.stringify(prop.example)}\``,
    ]);

    // One level of nesting: page envelopes and message wrappers are the only
    // nested objects, and a frontend dev needs to see their keys.
    if (depth === 0 && !isRef(prop) && prop.type === 'object' && prop.properties) {
      for (const [child, childProp] of Object.entries(prop.properties)) {
        const childRequired = new Set(prop.required ?? []);
        rows.push([
          `&nbsp;&nbsp;↳ \`${child}\`` + (childRequired.has(child) ? ' (required)' : ''),
          typeName(childProp),
          childProp.enum ? childProp.enum.join(', ') : '—',
          childProp.example === undefined ? '—' : `\`${JSON.stringify(childProp.example)}\``,
        ]);
      }
    }
  }

  return rows;
}

const table = (headers, rows) => {
  if (rows.length === 0) return '_None._\n';
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return `${line(headers)}\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map((r) => line(r)).join('\n')}\n`;
};

/** Markdown-safe inline text: pipes and newlines would break a table cell. */
const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/* ----------------------------------------------------------------- render */

function render() {
  const document = JSON.parse(readFileSync(join(ROOT, 'docs/openapi.json'), 'utf8'));
  const values = permissionValues();

  const operations = [];
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const method of HTTP) {
      if (methods[method]) {
        operations.push({ method: method.toUpperCase(), path, operation: methods[method] });
      }
    }
  }
  operations.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  const out = [];
  const tags = new Map();
  for (const entry of operations) {
    for (const tag of entry.operation.tags ?? ['other']) {
      if (!tags.has(tag)) tags.set(tag, []);
      tags.get(tag).push(entry);
    }
  }

  const order = (document.tags ?? []).map((t) => t.name);
  const tagNames = [...tags.keys()].sort(
    (a, b) => order.indexOf(a) - order.indexOf(b) || a.localeCompare(b),
  );

  out.push('# OPS API — API Reference');
  out.push('');
  out.push(
    'The endpoint contract: every route with its access control, parameters, request',
    'body and responses. Generated from `docs/openapi.json` — do not edit this file by',
    'hand, change the controller or DTO and run `npm run docs:openapi` instead.',
    '',
    'For the behaviour a schema cannot express (auth flows, browser headers, error',
    'handling, client patterns) see [frontend-guide.md](frontend-guide.md).',
  );
  out.push('');
  out.push('| | |');
  out.push('| --- | --- |');
  out.push(`| Base URL | \`${document.servers[0].url}\` |`);
  out.push('| Authentication | `Authorization: Bearer <access token>` |');
  out.push('| Organization header | `x-organization-id: <uuid>` |');
  out.push(`| Endpoints | ${operations.length} |`);
  out.push('');
  out.push('## Conventions');
  out.push('');
  out.push(
    '- **Paths** are relative to the base URL above; the `api/v1` prefix is already included.',
    '- **Auth** — a stateless access token in the `Authorization` header. A route marked *public* needs none.',
    '- **Organization** — organization-scoped routes need an active organization: send `x-organization-id`, or call the `/organizations/{organizationId}` form, which takes precedence when both are present. Your membership is verified on every call.',
    '- **Permission** — the permission(s) a route requires. Granted through your role in that organization; a missing one returns `403`.',
    '- **Pagination** — `page` (1-based) and `limit` (default 20, max 100) in the query, answered as `{ items, total, page, limit, totalPages }`.',
    '- **Errors** — `{ statusCode, error, message, timestamp, path }`, where `message` is a string for business errors and a string array when several fields failed validation.',
    '- **PATCH** — send only the fields to change; omitted fields are untouched. Unknown fields are rejected with `400`.',
    '- **DELETE** — answers `200` with a `{ message }` body.',
    '- **Timestamps** — ISO 8601 UTC strings.',
  );
  out.push('');

  for (const name of tagNames) {
    const meta = (document.tags ?? []).find((t) => t.name === name);
    out.push(`## ${name}`);
    out.push('');
    if (meta?.description) out.push(meta.description, '');

    for (const { method, path, operation } of tags.get(name)) {
      out.push(`### ${method} ${path}`);
      out.push('');
      out.push(`**${operation.summary}**`);
      out.push('');
      if (operation.description) out.push(operation.description, '');

      // Access control, read from the x-* extensions the guards publish.
      const auth = operation['x-auth'];
      const permissions = operation['x-permissions'] ?? [];
      const organization = operation['x-organization-context'];

      const lines = [];
      if (!auth?.required) {
        lines.push('**Auth:** public — no token needed');
      } else if (auth.context === 'user') {
        lines.push('**Auth:** bearer token (user-scoped)');
      } else {
        lines.push('**Auth:** bearer token');
      }

      if (auth?.required) {
        if (organization?.required === false) {
          lines.push('**Organization:** not required');
        } else if (organization?.required) {
          lines.push(
            path.includes('/organizations/{organizationId}')
              ? '**Organization:** from the `{organizationId}` path segment (the header is optional)'
              : '**Organization:** required — send `x-organization-id`',
          );
        }
      }

      if (permissions.length > 0) {
        lines.push(`**Permission:** ${permissions.map((p) => `\`${p}\``).join(', ')}`);
      } else if (auth?.required && organization?.required) {
        lines.push('**Permission:** any role of the organization');
      }

      out.push(lines.join('  \n'));
      out.push('');

      // Parameters.
      const params = (operation.parameters ?? []).filter((p) => p.in !== 'header');
      if (params.length > 0) {
        out.push('**Parameters**');
        out.push('');
        out.push(
          table(
            ['Name', 'In', 'Type', 'Required', 'Details', 'Description'],
            params.map((p) => [
              `\`${p.name}\``,
              p.in,
              typeName(p.schema),
              p.required ? 'yes' : 'no',
              p.schema?.enum ? p.schema.enum.join(', ') : p.schema?.default !== undefined ? `default \`${p.schema.default}\`` : '—',
              cell(p.description),
            ]),
          ),
        );
        out.push('');
      }

      // Request body.
      if (operation.requestBody) {
        const content = operation.requestBody.content?.['application/json']?.schema;
        out.push(`**Request body**${operation.requestBody.required ? '' : ' (optional)'}`);
        out.push('');
        if (content) {
          out.push(`Schema: \`${derefName(content)}\``);
          out.push('');
          out.push(
            table(
              ['Field', 'Type', 'Constraints', 'Example'],
              fieldRows(document, content),
            ),
          );
        }
        out.push('');
      }

      // Responses.
      out.push('**Responses**');
      out.push('');
      const rows = [];
      for (const [code, response] of Object.entries(operation.responses).sort()) {
        const schema = response.content?.['application/json']?.schema;
        const label = schema
          ? schema.type === 'array'
            ? `array of \`${derefName(schema.items)}\``
            : derefName(schema)
          : '—';
        rows.push([`\`${code}\``, label, cell(response.description) || '—']);
      }
      out.push(table(['Status', 'Schema', 'Meaning'], rows));
      out.push('');

      // Field table of the success response, the part clients actually read.
      const success = Object.entries(operation.responses).find(([c]) => c.startsWith('2'));
      const successSchema = success?.[1]?.content?.['application/json']?.schema;
      if (successSchema) {
        // An array response is documented through its item schema.
        const target = successSchema.type === 'array' ? successSchema.items : successSchema;
        const resolved = deref(document, target);
        const label =
          successSchema.type === 'array'
            ? `one item of \`${derefName(successSchema.items)}\``
            : `\`${derefName(successSchema)}\``;

        if (Object.keys(resolved.properties ?? {}).length > 0) {
          out.push(`**${success[0]} body fields** (${label})`);
          out.push('');
          out.push(
            table(
              ['Field', 'Type', 'Constraints', 'Example'],
              fieldRows(document, target),
            ),
          );
          out.push('');
        }
      }
    }
  }

  // Permission catalogue: which routes enforce each permission.
  const requiredBy = new Map();
  for (const { method, path, operation } of operations) {
    for (const permission of operation['x-permissions'] ?? []) {
      if (!requiredBy.has(permission)) requiredBy.set(permission, []);
      requiredBy.get(permission).push(`${method} ${path}`);
    }
  }

  out.push('## Permission catalogue');
  out.push('');
  out.push(
    'Every permission the API checks. A role grants a subset of these; a role that',
    'lacks the permission an endpoint lists gets `403` on that endpoint.',
  );
  out.push('');
  out.push(
    table(
      ['Permission', 'Constant', 'Required by'],
      [...values.entries()].map(([key, value]) => [
        `\`${value}\``,
        `\`PERMISSIONS.${key}\``,
        (requiredBy.get(value) ?? []).map((route) => `\`${route}\``).join('<br>') ||
          '—',
      ]),
    ),
  );
  out.push('');

  // Enumerations, grouped by the DTOs that declare them so `status` does not
  // read as one 14-value list.
  const enums = new Map();
  for (const [schemaName, schema] of Object.entries(document.components.schemas)) {
    for (const [field, prop] of Object.entries(schema.properties ?? {})) {
      if (!prop.enum) continue;
      const key = `${field}|${prop.enum.join(',')}`;
      if (!enums.has(key)) enums.set(key, { field, values: prop.enum, schemas: [] });
      enums.get(key).schemas.push(schemaName);
    }
  }
  if (enums.size > 0) {
    out.push('## Enumerations');
    out.push('');
    out.push('Each list is the full set of accepted values for that field.');
    out.push('');
    for (const { field, values, schemas } of [...enums.values()].sort((a, b) =>
      a.field.localeCompare(b.field) || a.schemas[0].localeCompare(b.schemas[0]),
    )) {
      out.push(`- **\`${field}\`** (${schemas.map((s) => `\`${s}\``).join(', ')}):`);
      out.push(`  ${values.map((v) => `\`${v}\``).join(', ')}`);
    }
    out.push('');
  }

  return out.join('\n');
}

const content = `${render().trimEnd()}\n`;

if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== content) {
    console.error(
      'docs/api-reference.md is out of date. Run: npm run docs:reference',
    );
    process.exit(1);
  }
  console.log('docs/api-reference.md is up to date');
} else {
  writeFileSync(OUT, content, 'utf8');
  console.log(`wrote docs/api-reference.md (${content.split('\n').length} lines)`);
}
