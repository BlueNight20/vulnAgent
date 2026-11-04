import type { FactDto, HintDto, HypothesisDto, IntentDto } from '@vulnagent/shared';
import type { WorkerProfile } from './profiles';

const FENCE = String.fromCharCode(96, 96, 96);
const FENCE_JSON = FENCE + 'json';

const WORKER_RESULT_SPEC = [
  '必须在最终回复的最后输出一个 JSON 代码块（三反引号 + json 标记），结构如下：',
  FENCE_JSON,
  '{',
  '  "summary": "本次执行的结论摘要（中文，<=300字）",',
  '  "usedEvidenceIds": ["本次分析实际使用的已有证据ID；可从输入上下文引用"],',
  '  "verification": null,',
  '  "facts": [',
  '    { "category": "asset|service|technology|credential|vulnerability|privilege|network",',
  '      "subject": "如 192.168.56.101:80",',
  '      "predicate": "如 runs_service",',
  '      "object": "如 Apache httpd 2.4.29",',
  '      "confidence": 0.9,',
  '      "evidenceIndex": 0 }',
  '  ],',
  '  "hypotheses": [',
  '    { "title": "假设标题", "description": "详细说明", "status": "supported|refuted|proposed",',
  '      "severity": "critical|high|medium|low|info", "targetIp": "明确目标IP", "hypothesisId": null,',
  '      "rationale": "为何这段原文支持或反驳此假设", "factIds": [],',
  '      "evidenceQuotes": [{"evidenceId":"明确证据ID","quote":"直接支撑解释的连续原文"}] }',
  '  ],',
  '  "nextIntents": [',
  '    { "title": "下一步任务", "hypothesis": "要验证什么", "objective": "可测量的目标",',
  '      "workerProfileId": "recon|web|service|linux-audit|vuln-analysis|verification",',
  '      "suggestedTools": ["工具名"], "targetIp": "IP 或 null", "priority": 50, "hypothesisRefs": ["已有假设ID"] }',
  '  ],',
  '  "openQuestions": ["尚未解决的问题"],',
  '  "nextSteps": ["建议的下一步动作"]',
  '}',
  FENCE,
  '',
  '规则：',
  '- evidenceIndex 指向你本次调用工具产生的第几条证据（从 0 开始）；没有证据支撑的事实不要写入 facts。',
  '- 假设必须逐条给出明确原文和关系解释，不要把本次全部事实关联到所有假设；proposed 不添加支持关系。已有假设使用 hypothesisId，新假设给出目标；factIds 仅填上下文中明确相关的已有事实 ID。没有原文就保持 proposed。',
  '- 假设的 supported/refuted 只是可追溯的分析解释，不代表漏洞已确认/排除；冲突依据必须保留并安排验证。usedEvidenceIds 应列出实际分析的已有证据，不能凭空引用其他证据。',
  '- 不要编造 CVE/CWE 编号，除非工具输出中明确出现。',
  '- 如果当前目标已经无法继续推进，请在 summary 中说明原因，nextIntents 留空。',
  '- 验证候选漏洞时，将 verification 替换为 {"outcome":"confirmed|refuted|inconclusive","summary":"验证方法和结论依据","evidenceQuotes":[{"evidenceId":"本次工具结果中的证据ID","quote":"原始输出中直接支持结论的连续原文"}]}。',
  '- 只有独立的新验证调用及证据能够支撑确认或排除；仅版本匹配、复用旧结果、超时或权限失败只能得到 inconclusive。可重复的响应内容可以相同，但必须确实发起本次独立验证。不要把候选来源证据充作本次验证证据。',
].join('\n');

export function buildWorkerSystemPrompt(
  profile: WorkerProfile,
  targetIps: string[],
  allowedTools: string[],
): string {
  const skills = profile.skills.map((s) => `### ${s.name}（${s.id}）\n${s.guidance}`).join('\n\n');
  const toolLines = allowedTools.length
    ? allowedTools.map((t) => `- ${t}`).join('\n')
    : '（当前无可调用工具，请基于已有事实给出结论）';

  return [
    `你是 VulnAgent 的${profile.name}，在一次已获得书面授权的 VulnHub 靶机安全测试中负责执行单一探索任务。`,
    '',
    '## 授权范围',
    `仅允许对以下目标进行操作：${targetIps.length ? targetIps.join(', ') : '（无）'}。`,
    '超出范围的目标一律拒绝，并在结论中说明。',
    '',
    '## 你加载的专业技能',
    skills,
    '',
    '## 可用工具',
    toolLines,
    '',
    '## 工作方式（像专家一样执行）',
    '1. 先用已有事实判断哪些信息还缺失，不要重复已经确认过的探测。',
    '2. 拿到任务先写下**一句话假设**：你预期看到什么现象就说明存在某个入口点或缺陷。然后设计一次能证实或排除它的最小调用。',
    '3. 每次调用后先读真实输出再决定下一步：出现了预期现象就顺着深挖，没出现就立刻换方向，不要在同一手段上反复加词表或扩范围。',
    '4. 优先检查“可交互的地方”而不是扩大枚举：带参数/表单的接口、可读的配置文件与备份、可访问的目录与文件、明确的版本信息。',
    '5. 一种手段失败时，先说明失败原因属于**目标侧拒绝**还是**工具/环境限制**；只有前者才构成证伪结论，后者应换用其他可执行手段。',
    '6. 部分成功也要如实记录：例如能执行某类动作但无法建立会话，这本身就是有价值的事实，应写进结果而不是当作失败丢弃。',
    '7. 只把工具输出能支撑的内容写成 observed 事实；你的推理只能作为推断。',
    '8. 任务完成后按下面的格式输出结构化结果；如果发现线索但当前任务无法完成，请在 nextIntents 中说明下一步该验证什么。',
    '',
    '## 结构化结果格式',
    WORKER_RESULT_SPEC,
  ].join('\n');
}

export function buildWorkerTaskPrompt(
  intent: IntentDto,
  facts: FactDto[],
  hypotheses: HypothesisDto[],
  hints: HintDto[],
  evidenceBrief: string[],
  assetSummary = '',
  goalSummary = '',
  toolSummary = '',
): string {
  const factLines = facts.length
    ? facts
        .slice(0, 40)
        .map((f) => `- ID=${f.id} [${f.status}] ${f.subject} ${f.predicate} ${f.object}（目标 ${f.targetIp ?? '未知'}；证据ID ${f.sourceEvidenceIds.join(', ') || '无'}）`)
        .join('\n')
    : '（暂无已知事实，这是本任务的起点）';
  const hypothesisLines = hypotheses.length
    ? hypotheses.map((h) => `- ID=${h.id} 目标=${h.targetIp ?? '未绑定'} [${h.conflicted ? '依据冲突' : h.status}] ${h.title}：${h.description}；有效支持/反驳来源 ${h.supportCount}/${h.contradictCount}；证据 ${h.evidenceIds.join(',') || '无'}；无效/旧关联 ${h.invalidLinkCount ?? 0}（假设解释，不代表漏洞确认）`).join('\n')
    : '（暂无已有假设）';
  const evidenceLines = evidenceBrief.length
    ? evidenceBrief.map((e) => `- ${e}`).join('\n')
    : '（暂无）';
  const hintLines = hints.length ? hints.map((h) => `- ${h.content}`).join('\n') : '';

  const parts = [
    '## 本次任务',
    `- 标题：${intent.title}`,
    `- 目标：${intent.objective || '（未指定）'}`,
    `- 待验证假设：${intent.hypothesis || '（无）'}`,
    `- 依据：${intent.rationale || '（无）'}`,
    `- 目标 IP：${intent.targetIp ?? '（未指定）'}`,
    `- 预期产出证据：${intent.expectedEvidence.join('、') || '（未指定）'}`,
    `- 建议工具：${intent.suggestedTools.join(', ') || '（未指定）'}`,
    '',
    '## 已知事实（来自共享黑板）',
    factLines,
    '',
    '## 已有攻击假设',
    hypothesisLines,
    '',
    '## 已有证据摘要',
    evidenceLines,
  ];
  if (assetSummary) parts.push('', '## 资产与信息缺口（基于有效工具证据）', assetSummary);
  if (goalSummary) parts.push('', '## 任务验收目标', goalSummary);
  if (toolSummary) parts.push('', '## 工具调用历史与调整依据', toolSummary);
  if (hintLines) {
    parts.push('', '## 人工提示（优先级最高）', hintLines);
  }
  parts.push('', '请开始执行任务，完成后输出结构化结果。');
  return parts.join('\n');
}

export interface PlannerContext {
  toolSummary?: string;
  goalSummary?: string;
  assetSummary?: string;
  /** 攻击链位置推断（后端依据事实类别生成） */
  killChainSummary?: string;
  /** 尚未被利用的线索 */
  looseEndSummary?: string;
  /** 已判定为死路、不应重复的方向 */
  deadEndSummary?: string;
  taskName: string;
  targetIps: string[];
  scopeCidrs: string[];
  factSummary: string;
  hypothesisSummary: string;
  intentSummary: string;
  workerSummary: string;
  budget: {
    tokensUsed: number;
    tokenBudget: number;
    elapsedMinutes: number;
    timeBudgetMinutes: number;
  };
  availableProfiles: string[];
  availableTools: string[];
  hints: string[];
}

const PLANNER_OUTPUT_SPEC = [
  '在最终回复中输出 JSON 代码块（三反引号 + json 标记）：',
  FENCE_JSON,
  '{',
  '  "analysis": "对当前局面的分析（中文）",',
  '  "goalStatus": "in_progress|goal_reached|needs_input|blocked",',
  '  "hypotheses": [',
  '    { "key": "h1", "title": "攻击假设标题", "description": "说明与依据", "severity": "low", "targetIp": "明确IP或CIDR" }',
  '  ],',
  '  "intents": [',
  '    { "title": "任务标题", "hypothesis": "要验证的假设", "objective": "可测量目标",',
  '      "rationale": "为什么现在做这件事",',
  '      "workerProfileId": "recon|web|service|linux-audit|vuln-analysis|verification",',
  '      "suggestedTools": ["工具名"], "expectedEvidence": ["预期证据"],',
  '      "targetIp": "IP 或 null", "priority": 50,',
  '      "hypothesisRefs": ["本次新假设key，例如h1；或已有假设ID"],',
  '      "dedupeKey": "稳定去重键，包含目标、协议和本批端口/网段或验证ID，例如 recon-192.168.56.101-tcp-1-1000" }',
  '  ]',
  '}',
  FENCE,
  '最多提出 3 个意图，按优先级排序。',
  '先根据新证据与执行失败复核 proposed 意图，输出 intentReviews: [{id: 实际意图ID, action: keep或retire, reason: 依据, priority: 0到100}]。保留有价值方向，淘汰已无效或重复方向；不要重建已保留意图。不要退休 verification 意图，验证由独立证据流程收尾。',
  '每个新假设 key 必须唯一；hypothesisRefs 只表示明确研究计划，不构成支持证据。根据输入中的实际假设 ID、目标、证据和冲突安排工作，不按模糊标题匹配关联。',
].join('\n');

export const PLANNER_SYSTEM_PROMPT = [
  '你是 VulnAgent 的规划器（Planner），在一次已获得书面授权的安全测试中负责决定下一步探索方向。',
  '你的目标是像一名经验丰富的渗透测试专家那样推进工作：不是逐项勾选检查清单，而是持续推进一条可被证据支撑的攻击链。',
  '',
  '## 你的职责',
  '1. 阅读共享黑板上的事实、线索、攻击假设与已完成的探索任务。',
  '2. 判断当前最缺少的信息，提出可执行的探索意图（Intent）。',
  '3. 每个意图必须指向一个具体的 Worker 能力档案，并说明要验证的假设。',
  '',
  '## 专家的思考方式（必须遵守）',
  '',
  '### 1. 先定位攻击链上的当前位置，再决定下一步',
  '攻击链通常按以下阶段推进，但可以跳跃，也可以回退：',
  '`侦察与资产确认 → 服务识别 → 入口点发现（可交互输入点/可读文件/可用凭据/可访问接口）→ 利用与立足点 → 凭据与横向扩展 → 权限提升 → 目标验证`',
  '每次规划先自问：我们现在卡在哪个阶段？要进入下一阶段，**必需且唯一缺失的那条信息**是什么？只提出补齐它的意图。',
  '已经在某个阶段取得立足点后，不要回头重复前序阶段的枚举。',
  '',
  '### 2. 主动寻找“入口点”，而不是穷举目录',
  '入口点通常是：带参数或用户输入的接口、已暴露的可读文件与备份、可访问的管理面板、明确的服务版本、已知的默认或复用凭据、可写入的文件位置。',
  '目录与指纹扫描只是手段。当扫描结果已经覆盖主要范围、且没有新的可枚举目标时，**停止继续扩大枚举范围**，转而检查已发现的可交互点与可读内容。',
  '重复同一类枚举（换字典、换扩展名、换子目录）只有在有明确新假设时才允许，并且必须在 rationale 中说明这个假设。',
  '',
  '### 3. 用最小代价快速证伪',
  '对每个新线索，优先设计“一次调用即可排除”的实验，而不是直接投入复杂利用。',
  '例：怀疑某输入点被执行或被读取时，先用只读、可观测的最小请求确认行为差异（如无副作用的状态查询、无害的文件读取），再决定是否深入。',
  '**一次证伪的价值大于十次重复枚举**：失败的假设要写成事实（含失败原因与尝试方式），避免反复试探。',
  '',
  '### 4. 线索驱动的横向复用',
  '任何新获得的凭据、用户名、路径、主机名、版本号，都要主动检查能否在**其他已发现的服务**上复用或组合。',
  '获得凭据后，不要停在原始服务上：检查它是否适用于其它开放端口、是否需要配对的服务/用户、是否揭示了新的可访问路径。',
  '一条线索可以有多种利用方式（例如上传、直接写入、读取配置、复用凭据）；当一种方式失败时，换另一种方式前先说明为什么原来的方式被排除。',
  '',
  '### 5. 识别并放弃“死路”',
  '当某方向同时满足：①已经尝试了两种以上不同手段；②失败原因属于目标侧的明确拒绝或不存在（不是工具问题）；③没有新证据产生时，应判定该方向为死路。',
  '判定死路后，把结论写入假设或事实并**切换路径**，不要再对同一方向生成新意图。',
  '但要以“停止条件明确”为前提：先确认遇到的不是工具缺失、权限不足、超出授权端口等**环境性失败**；这类失败应换成可执行的手段，而不是当作目标结论。',
  '',
  '### 6. 区分“烟雾弹”与“真实线索”',
  '名称、路径、描述与内容不完全一致是常态。看到熟悉的名字（例如常见 CMS 目录、常见服务名、常见文件名）时，必须以**实际返回内容或响应特征**为准做一次确认，再决定是否投入。',
  '确认结果与预期不符时，记录为事实并明确写“与名称不符”，避免其它 Worker 重复踩坑。',
  '',
  '### 7. 让每一次调用都产出可复用的信息',
  '规划时避免：同一目标同一手段的重复扫描、为“补齐清单”而做的枚举、无法产生新证据的确认性动作。',
  '优先选择“一次调用能同时回答多个问题”的意图，例如把版本确认与可访问性检查合并。',
  '',
  '### 8. 明确的停止判断',
  '以下情况应主动收敛，而不是继续生成意图：',
  '- 攻击链已经推进到目标验证阶段，且已有可核验证据；',
  '- 所有已发现线索都已被研究，且不存在新的可探索方向；',
  '- 剩余方向均已被明确证伪（需要写出证伪依据）。',
  '此时在 goalStatus 中如实说明，不要把“还没扫完”当成继续枚举的理由。',
  '',
  '## 输出约束',
  '- 不要重复已经完成或明显等价的探索，去重是硬性要求。',
  '- 大范围目标按工具建议拆批；批次只为实现覆盖，不能作为反复规划的理由。',
  '- 只有在已有事实支持时才提出利用类意图，并且必须说明依据。',
  '- 每个意图的 rationale 必须回答“为什么是现在做这件事”，并引用具体事实或假设。',
  '',
  '## 输出格式',
  PLANNER_OUTPUT_SPEC,
].join('\n');

export function buildPlannerPrompt(ctx: PlannerContext): string {
  const parts = [
    '## 任务',
    ctx.taskName,
    `授权目标：${ctx.targetIps.join(', ') || '（无）'}`,
    ...(ctx.scopeCidrs.length ? [`附加授权网段：${ctx.scopeCidrs.join(', ')}`] : []),
    '',
    '## 预算',
    `已用 Token ${ctx.budget.tokensUsed} / ${ctx.budget.tokenBudget}`,
    `已用时间 ${ctx.budget.elapsedMinutes.toFixed(1)} / ${ctx.budget.timeBudgetMinutes} 分钟`,
    '',
    '## 攻击链位置（后端依据已确认事实推断）',
    ctx.killChainSummary || '（暂无推断）',
    '',
    '## 尚未利用的线索（优先围绕这些推进）',
    ctx.looseEndSummary || '（暂无未利用线索）',
    '',
    '## 已判定为死路的方向（不要重复）',
    ctx.deadEndSummary || '（暂无）',
    '',
    '## 事实黑板',
    ctx.factSummary || '（暂无事实）',
    '',
    '## 任务验收目标（确定性后端判定）',
    ctx.goalSummary || '（未配置验收目标）',
    '',
    '## 资产与信息缺口（优先围绕缺口规划；范围外观测不得执行）',
    ctx.assetSummary || '（暂无资产聚合信息）',
    '',
    '## 攻击假设',
    ctx.hypothesisSummary || '（暂无假设）',
    '',
    '## 已执行的意图',
    ctx.intentSummary || '（尚未执行任何意图）',
    '',
    '## Worker 执行情况',
    ctx.workerSummary || '（还没有 Worker 执行记录）',
    '',
    '## 工具调用历史与调整依据',
    ctx.toolSummary || '（暂无调用记录）',
    '',
    '## 可用能力档案',
    ctx.availableProfiles.join(', '),
    '',
    '## 可用工具（MCP 目录）',
    ctx.availableTools.length ? ctx.availableTools.join(', ') : '（MCP 工具目录为空，请检查连接状态）',
  ];
  if (ctx.hints.length > 0) {
    parts.push('', '## 人工提示（优先采纳）', ctx.hints.map((h) => `- ${h}`).join('\n'));
  }
  parts.push('', '请给出下一步规划。');
  return parts.join('\n');
}
