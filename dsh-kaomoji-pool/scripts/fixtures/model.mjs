// A scripted transport fixture, NOT evidence of real model drawing ability.
import { appendFileSync } from 'node:fs'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'text-art-smoke-model'
export const inject = ['llm']

const asText = message => (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')
const calls = {
  ART_GUIDE: { action: 'guide' },
  ART_DRAW: {
    action: 'draw', width: 36, height: 12,
    objects: [
      { id: 'sea', kind: 'line', x: 0, y: 10, x2: 35, y2: 10, char: '~' },
      { id: 'moon', kind: 'ellipse', x: 27, y: 0, width: 7, height: 4, char: '.' },
      { id: 'sail', kind: 'text', x: 8, y: 2, text: '  |\\\n  | \\\n  |__\\\n _|___\n\\_____/' },
      { id: 'stars', kind: 'text', x: 1, y: 0, text: '*   .          *' },
    ],
  },
  ART_EDIT: { action: 'edit', artId: 'latest', changes: [{ id: 'moon', x: 23 }, { id: 'flag', kind: 'text', x: 7, y: 1, text: '{{}}' }] },
  ART_RAW: { action: 'draw', text: '\n  /\\  \n ( o )\n  ``` ' },
}

export function apply(ctx, config) {
  class Model extends LlmAdapter {
    async *stream(options) {
      const messages = options.messages || []
      const index = messages.findLastIndex(message => message.role === 'user' && message.source?.kind === 'user')
      const marker = asText(messages[index]).match(/ART_[A-Z]+/)?.[0] || ''
      appendFileSync(config.evidence, JSON.stringify({ marker, purpose: options.purpose, tools: (options.tools || []).map(tool => tool.name) }) + '\n')
      if (options.purpose !== 'session-title' && calls[marker] && !messages.slice(index + 1).some(message => message.role === 'tool')) {
        const args = JSON.stringify(calls[marker]), id = 'call-' + marker
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'text_art', argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'text_art', arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const text = options.purpose === 'session-title' ? 'Text art smoke' : 'Scripted host transport check complete.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['text-art-smoke'], new Model())
}
