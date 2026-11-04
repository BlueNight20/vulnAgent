import { describe, expect, it } from 'vitest';
import { recoverToolSelection } from './tool-recovery';
const now = Date.now();
const failure = (status = 'error', age = 0) => ({ toolName: 'gobuster_scan', status, targetIp: 'target', errorMessage: 'command not found', createdAt: new Date(now - age) });
describe('工具故障恢复', () => {
  it('跨 Worker 的两次失败后选择目录中可用的替代能力', () => {
    const result = recoverToolSelection(['gobuster_scan'], ['gobuster_scan', 'ffuf_scan'], [failure(), failure()], 'target', now);
    expect(result.tools).toEqual(['ffuf_scan']);
    expect(result.notes.join()).toContain('重新生成参数');
  });
  it('成功调用会打断连续失败，冷却结束后可再次尝试', () => {
    expect(recoverToolSelection(['gobuster_scan'], [], [failure('success'), failure()], 'target', now).tools).toEqual(['gobuster_scan']);
    expect(recoverToolSelection(['gobuster_scan'], [], [failure('error', 400000), failure('error', 400001)], 'target', now).tools).toEqual(['gobuster_scan']);
  });
  it('没有可用替代品时保留未覆盖说明，不生成不存在的工具', () => {
    const result = recoverToolSelection(['gobuster_scan'], [], [failure(), failure()], 'target', now);
    expect(result.tools).toEqual([]);
    expect(result.notes.join()).toContain('保留未覆盖项');
  });
});
