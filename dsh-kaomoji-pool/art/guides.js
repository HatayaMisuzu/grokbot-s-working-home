import { readFile } from 'node:fs/promises'

const guides = {
  basics: new URL('../skills/text-art-freehand/SKILL.md', import.meta.url),
  contours: new URL('../skills/text-art-freehand/references/contours.md', import.meta.url),
  composition: new URL('../skills/text-art-freehand/references/composition.md', import.meta.url),
  shading: new URL('../skills/text-art-freehand/references/shading.md', import.meta.url),
  unicode: new URL('../skills/text-art-freehand/references/unicode.md', import.meta.url),
}

export async function readGuide(topic = 'basics', signal) {
  if (!Object.hasOwn(guides, topic)) throw new Error(`topic 可选 ${Object.keys(guides).join('、')}`)
  signal?.throwIfAborted()
  return readFile(guides[topic], { encoding: 'utf8', signal })
}
