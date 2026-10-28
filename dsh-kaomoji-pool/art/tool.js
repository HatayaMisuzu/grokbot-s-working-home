const string = description => ({ type: 'string', description })
const integer = description => ({ type: 'integer', description })
const nodeProperties = {
  id: string('自定义图层名，用于后续修改；draw 中省略时生成 layer-N'),
  kind: { type: 'string', enum: ['text', 'line', 'box', 'ellipse'], description: '自绘文字、直线、矩形边框、椭圆' },
  x: integer('左上角列坐标，从 0 开始'), y: integer('左上角行坐标，从 0 开始'),
  text: string('text 图层的自绘多行文字，保留缩进；没有内置角色名'),
  x2: integer('line 终点列坐标'), y2: integer('line 终点行坐标'),
  width: integer('box / ellipse 宽度，至少 2 列'), height: integer('box / ellipse 高度，至少 2 行'),
  char: string('线条/轮廓使用的单列字符，可选'), fill: string('box / ellipse 内部填充的单列字符，可选'),
  transparent: { type: 'boolean', description: 'text 图层空格是否透明；默认 true，false 可用空格擦除背景' },
}

export function createArtTool(config = {}) {
  let engine
  return {
    name: 'text_art',
    description: '轻松聊天中的自由字符画工作台。先 guide 学习画法，再自己构图：draw 接受原文或通用图层，edit 局部修改，check 排版，inspect 回读画布。不按题材查找预制作品，不调用额外模型。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['guide', 'draw', 'edit', 'check', 'inspect'] },
        topic: { type: 'string', enum: ['basics', 'contours', 'composition', 'shading', 'unicode'], description: '按需学习基础、轮廓构造、构图动作、明暗、Unicode；默认 basics' },
        text: string('draw/check 的原始字符画，或 edit 的整幅新原文；不能与 objects 混用'),
        objects: { type: 'array', description: 'draw 的自绘图层，依数组顺序覆盖。每层都是自定义内容。与 text 二选一。', items: { type: 'object', additionalProperties: false, required: ['kind'], properties: nodeProperties } },
        artId: string('edit/inspect 的原作 id，或 latest；只在当前 agent 最近作品中有效'),
        changes: { type: 'array', description: 'edit 的图层更新；已有 id 合并字段，新 id 添加图层，remove:true 删除。', items: { type: 'object', additionalProperties: false, required: ['id'], properties: { ...nodeProperties, remove: { type: 'boolean' } } } },
        width: integer(`画布宽度；draw 省略时按内容计算，上限 ${config.maxWidth ?? 120}。edit 增大画布也用此字段。`),
        height: integer(`画布高度；draw 省略时按内容计算，上限 ${config.maxHeight ?? 80}。`),
        style: { type: 'string', enum: ['ascii', 'unicode'], description: '几何边框风格，默认 ascii；text 图层内容始终由你自行绘制' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        if (value.action === 'guide') return [{ type: 'text', text: value.content }]
        const notes = value.warnings?.length ? `\n排版提示：${value.warnings.join('；')}` : ''
        const layers = value.layers?.length ? `\n图层：${value.layers.map(layer => `${layer.id}(${layer.kind}@${layer.x},${layer.y})`).join('、')}` : ''
        const heading = value.artId ? `${value.artId}${value.parentId ? `（修改自 ${value.parentId}）` : ''}` : '排版检查'
        const inspect = value.action === 'inspect' ? `\n画布数据：${JSON.stringify(value.document)}` : ''
        return [{ type: 'text', text: `${heading}：${value.width} 列 × ${value.height} 行${layers}\n${value.markdown}${notes}${inspect}` }]
      },
    },
    isConcurrencySafe: args => args?.action === 'guide' || args?.action === 'check',
    async execute(args, execution) {
      execution?.signal?.throwIfAborted()
      if (args?.action === 'guide') {
        const { readGuide } = await import('./guides.js')
        return { action: 'guide', topic: args.topic ?? 'basics', content: await readGuide(args.topic, execution?.signal) }
      }
      const { createEngine, toMarkdown } = await import('./engine.js')
      engine ??= createEngine(config)
      const result = engine.run(args ?? {}, execution)
      return { ...result, markdown: toMarkdown(result.text) }
    },
  }
}
