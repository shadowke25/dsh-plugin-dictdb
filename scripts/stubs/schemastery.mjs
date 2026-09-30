/**
 * Stub for `@deepseek-ai/schemastery`.
 *
 * Reproduces only the surface the plugin uses: Schema.object with
 * string/number/boolean fields carrying `.default()`. `resolveDefaults()`
 * mirrors the documented behaviour — the loader validates config through the
 * exported schema and fills omitted fields with their defaults.
 */
function makeField(kind, fallback) {
	const field = {
		kind,
		fallback,
		default(value) { return { ...field, fallback: value } },
	}
	return field
}

const Schema = {
	string: () => makeField('string', undefined),
	number: () => makeField('number', undefined),
	boolean: () => makeField('boolean', undefined),
	object(shape) {
		return {
			shape,
			/** Fill omitted keys with their declared defaults. */
			resolveDefaults(input) {
				const out = {}
				for (const [key, field] of Object.entries(shape)) {
					out[key] = input && key in input ? input[key] : field.fallback
				}
				return out
			},
		}
	},
}

export default Schema
