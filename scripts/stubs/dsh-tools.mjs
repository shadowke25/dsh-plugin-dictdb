/**
 * Stub for `@deepseek-ai/dsh-tools`.
 *
 * Reproduces the documented contract of `defineTool`: it validates the
 * definition shape and returns it. The real helper additionally type-derives
 * `args` from `parameters`; at runtime that is a no-op, so the identity
 * behaviour is faithful for our purposes.
 *
 * This stub is NOT the real implementation — it cannot validate against the
 * real ParameterSchemaSpec. scripts/smoke.mjs compensates by asserting the
 * definition shapes the docs specify.
 */
export function defineTool(definition) {
	if (!definition || typeof definition !== 'object') {
		throw new TypeError('defineTool: definition must be an object')
	}
	if (typeof definition.name !== 'string' || !definition.name) {
		throw new TypeError('defineTool: name is required')
	}
	if (typeof definition.description !== 'string' || !definition.description) {
		throw new TypeError(`defineTool(${definition.name}): description is required`)
	}
	if (typeof definition.execute !== 'function') {
		throw new TypeError(`defineTool(${definition.name}): execute is required`)
	}
	if (!definition.output || typeof definition.output.render !== 'function') {
		throw new TypeError(`defineTool(${definition.name}): output.render is required`)
	}
	return definition
}
