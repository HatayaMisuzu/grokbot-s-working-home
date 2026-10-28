import { appendFileSync } from 'node:fs'
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context)
  appendFileSync(process.env.TEXT_ART_IMPORT_TRACE, result.url + '\n')
  return result
}
