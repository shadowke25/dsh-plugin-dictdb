/**
 * Module-resolution hook for the smoke test.
 *
 * `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery` are provided by the
 * DSH host from inside app.asar, so they cannot be resolved when the plugin is
 * loaded in a bare Node process. Redirect them to local stubs that reproduce
 * the documented contract.
 */
export async function resolve(specifier, context, nextResolve) {
	if (specifier === '@deepseek-ai/dsh-tools') {
		return { url: new URL('./dsh-tools.mjs', import.meta.url).href, shortCircuit: true }
	}
	if (specifier === '@deepseek-ai/schemastery') {
		return { url: new URL('./schemastery.mjs', import.meta.url).href, shortCircuit: true }
	}
	return nextResolve(specifier, context)
}
