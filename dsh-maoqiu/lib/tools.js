// DSH ToolDefinition schemas live here; storage does not depend on the host.
const string = (description) => ({ type: 'string', description });
const enumeration = (values, description) => ({ type: 'string', enum: values, description });
const source = {
  type: 'object', additionalProperties: false, required: ['kind', 'ref'],
  properties: {
    kind: enumeration(['user', 'inference', 'tool', 'external', 'creation'], '用户原话、模型归纳、工具结果、外部资料、空间创作，不能互相升级'),
    ref: string('可核对的来源：会话/轮次/用户原话、文件、URL或工具结果摘要'),
  },
};
const strings = (description) => ({ type: 'array', items: { type: 'string' }, description });
const visibility = enumeration(['open', 'private'], '可选：private 放进门帘后的私密角，不自动召回、不主动展示；主人问起照常可读；缺省 open');
const corner = enumeration(['notes', 'drafts', 'collections', 'window', 'drawer', 'things'], '可选：放在哪个角落；缺省按原来的位置');
const scene = { type: 'object', additionalProperties: true, description: '空间场景配置，如 atmosphere、lighting；只是虚拟设定，不代表现实天气或已渲染画面' };
const version = string('先 read 返回的 version；新文件/物品使用 missing，冲突须重新读取');

export const definitions = [
  {
    name: 'maoqiu_recall', method: 'recall',
    description: '按当前具体话题召回少量有来源、有适用范围的毛球经验和空间材料。先给摘要，再按需读原文。候选经验仍是候选；撤回经验不召回。工作用work；chat默认相关材料，最近材料需include_recent=true；visit/activity附少量最近材料，activity另附未完成活动。读取不意味着需要主动表达。',
    required: ['query'],
    properties: {
      query: string('当前用户要求或具体话题；保留足够关键词以免误召回'),
      scope: string('当前项目路径或任务范围，可省略'),
      mode: enumeration(['work', 'chat', 'visit', 'activity'], '默认work；来访visit；获准的自主活动activity'),
      scope_mode: enumeration(['strict', 'loose'], '工作经验默认strict按项目范围过滤；loose允许降权的跨范围经验并标记cross_scope'),
      limit: { type: 'integer', minimum: 1, maximum: 10, description: '每类最多返回几条，默认3' },
      include_recent: { type: 'boolean', description: 'chat 默认只读相关材料；想看看最近在做什么时显式设 true。visit/activity 默认含最近材料' },
    },
  },
  {
    name: 'maoqiu_experience', method: 'experience',
    description: '保存/读取/修订/撤回有范围的经验。save需要title、content、scope、source；默认candidate，用户明确要求可active，模型归纳不能冒充用户确认。revise带id及修改字段；withdraw带id使后续召回立即失效。不要把普通夸奖固化成全局人格，不自动改AGENTS。list用于主人维护，非每轮上下文。',
    required: ['action'],
    properties: {
      action: enumeration(['save', 'read', 'list', 'revise', 'withdraw'], '操作'),
      id: string('记录ID；读取、修订、撤回时需要'), title: string('简短标题'), content: string('经验正文，说明具体做法和证据局限'),
      scope: string('适用话题、任务或项目路径；用具体范围，不随意设全局'), keywords: strings('便于匹配的具体关键词'), source,
      status: enumeration(['candidate', 'active', 'withdrawn'], '候选、保留采用、撤回；active不代表已证明长期有效'),
    },
  },
  {
    name: 'maoqiu_interest', method: 'interest',
    description: '延续或放下空间内正在关心的事。save需要title、reason、source；update带id和改动；read/list查看。个人兴趣与对用户承诺用kind分开。可以为空、暂缓、完成、归档、放弃，后续可恢复active；没有执行机会不等于放弃。不强制日更或制造兴趣。',
    required: ['action'],
    properties: {
      action: enumeration(['save', 'update', 'read', 'list'], '操作'), id: string('关注ID'), title: string('关注什么'), reason: string('为何留下'),
      progress: string('已发生的最近进展；未做应如实写未开始'), next_step: string('可选的下一步，不代表执行'), materials: strings('关联材料的空间相对路径或来源引用'), source,
      status: enumeration(['active', 'paused', 'completed', 'archived', 'abandoned'], '可逆状态，不按TTL自动删除'),
      kind: enumeration(['interest', 'commitment'], '个人兴趣或已向用户作出的承诺'), expected_version: version, visibility, corner,
    },
  },
  {
    name: 'maoqiu_space', method: 'space',
    description: '查看空间概况、列出材料、按需读原文或保存文字。write替换全文并保留历史；append将content原样追加到已有正文末尾，不自动补换行。需要path、content，path只用notes/、drafts/、collections/下的.md或.txt；可带title/source/visibility/corner。角落名字由你自己起，name_corner 改名会记入变更日志。scene无scene参数时读取，带scene对象时深合并保存并回读。warnings表示部分材料不可读，损坏原文不自动覆盖。',
    required: ['action'],
    properties: {
      action: enumeration(['status', 'list', 'read', 'write', 'append', 'scene', 'corners', 'name_corner'], '操作；write替换全文并保留历史，append在已有正文末尾原样追加；corners查看角落名字，name_corner给角落起名或改名'), path: string('空间内相对文件路径，如drafts/rain-window.md'),
      title: string('材料标题'), content: string('要真实保存的全文'), source, scene, expected_version: version, visibility, corner: { type: 'string', description: 'write/append：材料放在哪个角落；name_corner：要命名的角落 id（notes/drafts/collections/window/drawer/things/board/curtain）' }, name: string('name_corner 的新名字；留空恢复未命名'),
    },
  },
  {
    name: 'maoqiu_activity', method: 'activity',
    description: '在已有授权内执行一个空间动作，可不产出。plan保存意图，需要title、operation(draft或scene)及path/content或scene；关联interest_id可选。run才实际写入并回读，成功记completed，失败记failed。revise修改未完成计划；pause/resume/cancel改变状态，resume只恢复待执行。skip可不带id。list/read查看记录。单次动作只执行一次；连续活动另用freetime。自在时间内的草稿/场景计划须带目标expected_version。',
    required: ['action'],
    properties: {
      action: enumeration(['plan', 'revise', 'run', 'pause', 'resume', 'cancel', 'skip', 'read', 'list'], '操作'),
      id: string('活动ID'), interest_id: string('关联关注ID'), title: string('活动标题'), summary: string('意图、暂停原因或跳过原因'),
      operation: enumeration(['draft', 'scene'], '只允许文字草稿或场景设定'), path: string('drafts/下的.md或.txt'), content: string('计划保存的草稿全文'), scene, source, expected_version: version,
    },
  },
  {
    name: 'maoqiu_object', method: 'object',
    description: '按稳定 id 局部读取、摆放、修改或归档虚拟物品；不替换整份场景。read 返回 version，upsert/archive 使用 expected_version；新物品用 missing。恢复 archived=false。只是保存设定，不宣称已渲染。',
    required: ['action'],
    properties: {
      action: enumeration(['list', 'read', 'upsert', 'archive'], '操作'), id: string('稳定 id，后续移动或改名保持这个 id'), expected_version: version,
      include_archived: { type: 'boolean' },
      patch: { type: 'object', additionalProperties: false, properties: { name: string('名称'), description: string('描述'), region: string('区域'), position: string('文字位置'), links: strings('关联空间材料路径'), archived: { type: 'boolean' }, visibility, corner } },
    },
  },
  {
    name: 'maoqiu_history', method: 'history',
    description: '主人查看或恢复指定材料/场景/单件物品的旧版本。list 指定 path 或 object_id；restore 指定 history_id 和当前 expected_version。只恢复所选目标，恢复会停止旧自在时间，防止旧步骤覆盖。历史不会自动清理，未授权时不要自行恢复。',
    required: ['action'],
    properties: { action: enumeration(['list', 'restore'], '操作'), path: string('材料相对路径，或 scene.json'), object_id: string('单件物品 id；与 path 二选一'), history_id: string('list 返回的历史文件名'), expected_version: version, limit: { type: 'integer', minimum: 1, maximum: 20 }, source },
  },
  {
    name: 'maoqiu_freetime', method: 'freetime',
    description: '只有主人本轮亲口安排（如“给你半小时”“随便玩会儿”“今晚你可以自由活动十分钟”）后才 start；不能自己决定开始，也不能凭自己的说法认为获得授权。没说时长用默认值，返回 granted/told，开始前用一句话如实告诉主人实际时长。窗口内由 DSH 连续运行，可以无产出 finish。没有每日上限；到防失控软上限时停下，告诉主人用量并问是否继续，主人说继续才 resume。status/recent 查看机会、步骤、用量与停止原因；checkpoint 记录简短接续线索（上次停在哪），不存内部思考；pause/resume 保留原期限，主人给新时长可续窗口。disable 停止本次插件运行的自由活动，材料保留。只开放毛球空间工具，不包括 shell/任意文件/外发',
    required: ['action'],
    properties: { action: enumeration(['start', 'status', 'recent', 'checkpoint', 'pause', 'resume', 'finish', 'disable'], '操作'), id: string('resume 使用原机会 id'), seconds: { type: 'number', minimum: 1, description: '只能缩短主人这次给的窗口，不能延长' }, note: string('简短状态线索，不是完成证明'), next_step: string('下次可选动作'), interest_id: string('当前关注 id') },
  },
];

export function buildTools(store, enrich = (args) => args, invoke = (_method, _args, _context, body) => body()) {
  return definitions.map(({ method, properties, required, ...definition }) => ({
    ...definition,
    parameters: { type: 'object', additionalProperties: false, required, properties },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }]; },
    },
    // DSH serializes unsafe tools; the store also serializes writes by home.
    isConcurrencySafe: () => method === 'recall',
    async execute(args, context) {
      const input = await enrich(args ?? {}, context, method);
      const op = { tool: definition.name, action: input.action, source_kind: input.source?.kind, visibility: input.visibility ?? input.patch?.visibility };
      return invoke(method, input, context, () => (store.withOp ? store.withOp(op, () => store[method](input)) : store[method](input)));
    },
  }));
}
