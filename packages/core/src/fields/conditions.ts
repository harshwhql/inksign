import { InkSignError, type ValidationIssue } from '../errors.js'
import type { Field, FieldCondition, FieldId, FieldValue } from '../types.js'
import { isEmpty } from './registry.js'

export type ValueLookup = (id: FieldId) => FieldValue

/** Evaluates one condition against the current value of its gating field. */
export function evaluateCondition(condition: FieldCondition, lookup: ValueLookup): boolean {
  const value = lookup(condition.whenField)

  switch (condition.operator) {
    case 'filled':
      return !isEmpty(value)
    case 'empty':
      return isEmpty(value)
    case 'equals':
      return compare(value, condition.value) === 0
    case 'not_equals':
      return compare(value, condition.value) !== 0
    case 'greater_than': {
      const result = compare(value, condition.value)
      return result !== undefined && result > 0
    }
    case 'less_than': {
      const result = compare(value, condition.value)
      return result !== undefined && result < 0
    }
    case 'includes': {
      const haystack = asText(value)
      const needle = condition.value === undefined ? '' : String(condition.value)
      return haystack?.includes(needle) ?? false
    }
  }
}

/**
 * Whether a field should be shown. All of its conditions must pass, and every
 * gating field must itself be visible: hiding a parent hides its children, so
 * a branch cannot be required through an invisible dependency.
 */
export function isFieldVisible(
  field: Field,
  fields: ReadonlyMap<FieldId, Field>,
  lookup: ValueLookup,
  seen: Set<FieldId> = new Set(),
): boolean {
  if (!field.conditions || field.conditions.length === 0) return true
  if (seen.has(field.id)) {
    throw new InkSignError(
      'CONDITION_CYCLE',
      `Field ${field.id} takes part in a conditional visibility cycle`,
      { fieldId: field.id, chain: Array.from(seen) },
    )
  }
  seen.add(field.id)

  for (const condition of field.conditions) {
    const parent = fields.get(condition.whenField)
    if (parent && !isFieldVisible(parent, fields, lookup, seen)) return false
    if (!evaluateCondition(condition, lookup)) return false
  }

  seen.delete(field.id)
  return true
}

/**
 * Finds every field whose visibility depends on `changed`, directly or
 * transitively, so the renderer can refresh exactly those.
 */
export function dependentFields(
  changed: FieldId,
  fields: ReadonlyMap<FieldId, Field>,
): readonly FieldId[] {
  const reverse = buildReverseIndex(fields)
  const out: FieldId[] = []
  const queue = [changed]
  const visited = new Set<FieldId>([changed])

  while (queue.length > 0) {
    const current = queue.shift() as FieldId
    for (const dependent of reverse.get(current) ?? []) {
      if (visited.has(dependent)) continue
      visited.add(dependent)
      out.push(dependent)
      queue.push(dependent)
    }
  }
  return out
}

/** Maps each gating field to the fields that depend on it. */
export function buildReverseIndex(
  fields: ReadonlyMap<FieldId, Field>,
): ReadonlyMap<FieldId, readonly FieldId[]> {
  const index = new Map<FieldId, FieldId[]>()
  for (const field of fields.values()) {
    for (const condition of field.conditions ?? []) {
      const bucket = index.get(condition.whenField)
      if (bucket) bucket.push(field.id)
      else index.set(condition.whenField, [field.id])
    }
  }
  return index
}

/**
 * Detects dependency cycles and references to fields that do not exist.
 *
 * Run this at authoring time: a cycle discovered mid-ceremony would otherwise
 * surface as a thrown error while the recipient is typing.
 */
export function validateConditions(
  fields: ReadonlyMap<FieldId, Field>,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = []

  for (const field of fields.values()) {
    for (const condition of field.conditions ?? []) {
      if (!fields.has(condition.whenField)) {
        issues.push({
          code: 'UNKNOWN_FIELD',
          message: `Field "${label(field)}" is conditional on field ${condition.whenField}, which does not exist`,
          path: `fields.${field.id}.conditions`,
          fieldId: field.id,
          severity: 'error',
        })
      }
      if (condition.whenField === field.id) {
        issues.push({
          code: 'CONDITION_CYCLE',
          message: `Field "${label(field)}" is conditional on itself`,
          path: `fields.${field.id}.conditions`,
          fieldId: field.id,
          severity: 'error',
        })
      }
    }
  }

  for (const cycle of findCycles(fields)) {
    const names = cycle.map((id) => {
      const field = fields.get(id)
      return field ? label(field) : id
    })
    issues.push({
      code: 'CONDITION_CYCLE',
      message: `Conditional visibility cycle: ${names.join(' depends on ')}`,
      path: `fields.${cycle[0]}.conditions`,
      ...(cycle[0] !== undefined ? { fieldId: cycle[0] } : {}),
      severity: 'error',
    })
  }

  return issues
}

/**
 * Finds dependency cycles, by iterative depth-first search with colouring.
 *
 * Iterative rather than recursive so a long chain cannot overflow the stack,
 * and colour-marked rather than path-copying so it stays linear. Carrying a
 * copy of the parent path into each frame is the obvious implementation and is
 * quadratic in both time and memory, which turns a document with a long
 * conditional chain into a hang at authoring time.
 *
 * Each node is white (unvisited), grey (on the current path) or black (fully
 * explored). An edge to a grey node is a back edge, which is a cycle; an edge
 * to a black node is a path already proven acyclic, so it is skipped. Every
 * node and edge is therefore visited once.
 */
function findCycles(fields: ReadonlyMap<FieldId, Field>): readonly FieldId[][] {
  const cycles: FieldId[][] = []

  const WHITE = 0
  const GREY = 1
  const BLACK = 2
  const colour = new Map<FieldId, number>()

  /** The current path, with a set alongside it for O(1) membership tests. */
  const path: FieldId[] = []
  const onPath = new Set<FieldId>()

  for (const start of fields.keys()) {
    if ((colour.get(start) ?? WHITE) !== WHITE) continue

    // Each frame holds a node and how many of its edges have been followed.
    const stack: { id: FieldId; edge: number }[] = [{ id: start, edge: 0 }]
    colour.set(start, GREY)
    path.push(start)
    onPath.add(start)

    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { id: FieldId; edge: number }
      const conditions = fields.get(frame.id)?.conditions ?? []

      if (frame.edge >= conditions.length) {
        // Every edge explored, so this node is settled.
        colour.set(frame.id, BLACK)
        onPath.delete(frame.id)
        path.pop()
        stack.pop()
        continue
      }

      const next = conditions[frame.edge]?.whenField
      frame.edge += 1

      if (next === undefined || !fields.has(next)) continue

      if (onPath.has(next)) {
        // A back edge: the cycle is the path from `next` to here.
        cycles.push(path.slice(path.indexOf(next)))
        continue
      }
      if ((colour.get(next) ?? WHITE) === BLACK) continue

      colour.set(next, GREY)
      path.push(next)
      onPath.add(next)
      stack.push({ id: next, edge: 0 })
    }
  }

  return dedupeCycles(cycles)
}

function dedupeCycles(cycles: readonly FieldId[][]): readonly FieldId[][] {
  const seen = new Set<string>()
  const out: FieldId[][] = []
  for (const cycle of cycles) {
    const key = [...cycle].sort().join('|')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cycle)
  }
  return out
}

function label(field: Field): string {
  return field.label ?? field.id
}

function asText(value: FieldValue): string | undefined {
  switch (value.kind) {
    case 'text':
    case 'choice':
      return value.value
    case 'number':
      return String(value.value)
    case 'boolean':
      return value.value ? 'true' : 'false'
    default:
      return undefined
  }
}

/**
 * Three-way comparison between a field value and a literal.
 * Returns `undefined` when the two are not comparable.
 */
function compare(
  value: FieldValue,
  literal: string | number | boolean | undefined,
): number | undefined {
  if (literal === undefined) return isEmpty(value) ? 0 : 1

  if (typeof literal === 'boolean') {
    if (value.kind !== 'boolean') return undefined
    return value.value === literal ? 0 : 1
  }

  if (typeof literal === 'number') {
    const numeric = value.kind === 'number' ? value.value : Number(asText(value))
    if (!Number.isFinite(numeric)) return undefined
    return numeric === literal ? 0 : numeric > literal ? 1 : -1
  }

  const text = asText(value)
  if (text === undefined) return undefined
  return text === literal ? 0 : text > literal ? 1 : -1
}
