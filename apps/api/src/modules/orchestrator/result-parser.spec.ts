import { describe, expect, it } from 'vitest';
import { extractJsonBlock, fallbackWorkerResult, parsePlannerResult, parseWorkerResult } from './result-parser';

describe('结构化结果解析', () => {
  it('假设使用明确 ID/目标/原文与意图引用，丢弃隐式证据索引并限制引用规模', () => {
    const result = parseWorkerResult(JSON.stringify({ hypotheses: [{ key: 'h1', hypothesisId: 'existing', title: '测试', targetIp: '192.168.56.101', rationale: '解释', evidenceQuotes: [{ evidenceId: 'e', quote: 'actual continuous output' }, { evidenceIndex: 0, quote: 'implicit' }], factIds: ['f'] }], nextIntents: [{ title: '复核', hypothesisRefs: ['h1', 'existing'] }] }));
    expect(result?.hypotheses[0]).toMatchObject({ key: 'h1', hypothesisId: 'existing', targetIp: '192.168.56.101', factIds: ['f'], evidenceQuotes: [{ evidenceId: 'e', quote: 'actual continuous output' }] });
    expect(result?.nextIntents[0].hypothesisRefs).toEqual(['h1', 'existing']);
    expect(parseWorkerResult(JSON.stringify({ hypotheses: [{ title: 'x', evidenceQuotes: Array.from({ length: 11 }, () => ({ evidenceId: 'e', quote: 'q' })) }] }))?.hypotheses[0].evidenceQuotes).toHaveLength(10);
  });
  it('解析验证结果时只接受已定义的结论和明确证据 ID 引用', () => {
    const parsed = parseWorkerResult(JSON.stringify({ verification: { outcome: 'confirmed', summary: '复核', evidenceQuotes: [{ evidenceId: 'e', quote: '真实输出' }, { evidenceIndex: 0, quote: '旧索引不能代替证据ID' }] } }));
    expect(parsed?.verification?.evidenceQuotes).toEqual([{ evidenceId: 'e', quote: '真实输出' }]);
    expect(parseWorkerResult(JSON.stringify({ verification: { outcome: 'probably' } }))?.verification).toBeNull();
  });
  it('从 ```json 代码块中提取对象', () => {
    const text = '分析如下\n```json\n{"a":1}\n```';
    expect(extractJsonBlock(text)).toEqual({ a: 1 });
  });

  it('没有代码块时可以退化为花括号截取', () => {
    expect(extractJsonBlock('结果：{"b":2} 结束')).toEqual({ b: 2 });
  });

  it('解析 Worker 结果的事实与证据索引', () => {
    const text = `完成扫描
\`\`\`json
{
  "summary": "发现 80 端口",
  "facts": [
    {"category":"service","subject":"192.168.56.101:80","predicate":"runs_service","object":"Apache 2.4.29","confidence":0.9,"evidenceIndex":0}
  ],
  "hypotheses": [{"title":"存在默认页","description":"index 为默认页","status":"supported","severity":"low"}],
  "nextIntents": [{"title":"目录枚举","workerProfileId":"web","suggestedTools":["gobuster_dir"],"targetIp":"192.168.56.101","priority":70}],
  "openQuestions": ["是否有后台"],
  "nextSteps": ["枚举目录"]
}
\`\`\``;
    const parsed = parseWorkerResult(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.facts[0].category).toBe('service');
    expect(parsed!.facts[0].evidenceIndex).toBe(0);
    expect(parsed!.hypotheses[0].status).toBe('supported');
    expect(parsed!.nextIntents[0].workerProfileId).toBe('web');
    expect(parsed!.nextIntents[0].dedupeKey).toMatch(/^intent:v2:[a-f0-9]{64}$/);
  });

  it('非法 profile 回落到 recon', () => {
    const parsed = parseWorkerResult('```json\n{"nextIntents":[{"title":"x","workerProfileId":"hack"}]}\n```');
    expect(parsed!.nextIntents[0].workerProfileId).toBe('recon');
  });

  it('解析 Planner 结果与目标状态', () => {
    const text = '```json\n{"analysis":"需要补端口","goalStatus":"goal_reached","intents":[{"title":"端口扫描","workerProfileId":"recon","dedupeKey":"recon-1"}]}\n```';
    const parsed = parsePlannerResult(text);
    expect(parsed!.goalStatus).toBe('goal_reached');
    expect(parsed!.intents).toHaveLength(1);
  });

  it('未知 goalStatus 回落到 in_progress', () => {
    const parsed = parsePlannerResult('```json\n{"analysis":"x","goalStatus":"finished"}\n```');
    expect(parsed!.goalStatus).toBe('in_progress');
  });

  it('无结构化输出时降级为文本摘要且不编造事实', () => {
    const parsed = fallbackWorkerResult('工具全部失败，无法连接目标', '端口扫描');
    expect(parsed.facts).toHaveLength(0);
    expect(parsed.summary).toContain('工具全部失败');
    expect(parsed.openQuestions.length).toBeGreaterThan(0);
  });
});
