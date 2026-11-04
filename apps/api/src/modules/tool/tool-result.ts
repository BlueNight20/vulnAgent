import { truncateOutput, type TruncateResult } from './tool-output';
import type { ToolContentBlock, ToolResult } from './core-tool';

/**
 * 把工具结果编码成模型可见的文本。
 *
 * 关键约束（与 artex 等价，自写实现）：
 * 1) 任何失败都编码成正常结果 + isError，绝不向 agent loop 抛异常；
 * 2) 文本在唯一出口统一截断；
 * 3) 二进制附件只提供元数据（模型不能"看到"图片），避免误导模型以为已读取内容；
 * 4) 外部引用同样只是引用，不代表已取得内容。
 */

export interface EncodedResult {
  text: string;
  isError: boolean;
  truncation: TruncateResult;
}

export function textOf(result: ToolResult): string {
  return result.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
}

/**
 * 编码给模型看的结果。
 *
 * 截断只影响模型上下文；证据落库使用 `evidenceTextOf`，保存未截断的全文，
 * 否则无法与工具原始输出逐字核对。
 */
export function encodeForModel(result: ToolResult, limit?: number): { text: string; isError: boolean; truncation: TruncateResult } {
  const raw = evidenceTextOf(result);
  const truncation = truncateOutput(raw || '(no output)', limit);
  return { text: truncation.text, isError: result.isError, truncation: { ...truncation, fullLength: raw.length } };
}

/** 未截断的证据文本：包含正文、附件元数据与外部引用说明。 */
export function evidenceTextOf(result: ToolResult): string {
  const parts: string[] = [];
  const text = textOf(result);
  if (text.trim()) parts.push(text);

  const attachments = result.content.filter((block): block is Extract<ToolContentBlock, { type: 'attachment' }> => block.type === 'attachment');
  if (attachments.length) {
    parts.push(
      '附件已保存（仅提供元数据，不等于模型已读取图像或抓包内容）：\n'
        + attachments.map((a) => `${a.attachmentId} ${a.filename} ${a.mimeType} ${a.sizeBytes} 字节 SHA-256 ${a.sha256}`).join('\n'),
    );
  }

  const references = result.content.filter((block): block is Extract<ToolContentBlock, { type: 'reference' }> => block.type === 'reference');
  if (references.length) {
    parts.push(
      '外部引用尚未获取（不构成已取得的内容证据）：\n'
        + references.map((r) => `${r.name}: ${r.uri}`).join('\n'),
    );
  }

  return parts.join('\n');
}

/** 失败结果的固定说明：明确"探测失败不等于目标状态"。 */
export function failureNotice(detail: {
  tool: string;
  kind?: string | null;
  retryable?: boolean;
  reason?: string | null;
  suggestion?: string | null;
}): string {
  return [
    '工具执行失败。',
    `工具: ${detail.tool}`,
    `失败分类: ${detail.kind ?? 'unknown'}`,
    `是否可重试: ${detail.retryable ? '是' : '否'}`,
    `原因: ${detail.reason ?? '未知错误'}`,
    ...(detail.suggestion ? [`调整建议: ${detail.suggestion}`] : []),
    '',
    '注意：这是探测过程失败，不能据此推断目标状态（不要把失败当作「端口关闭」或「服务不存在」）。',
    detail.retryable
      ? '按调整建议有界尝试；本会话相同参数失败两次后禁止再次原样调用。连接故障先检查服务，执行超时应缩小范围。'
      : '请换用其他工具，或把该目标的相关结论记为「未知」。',
  ].join('\n');
}
