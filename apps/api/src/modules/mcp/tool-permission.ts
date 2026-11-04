import { matchToolPattern } from '../../common/utils/id';

interface PermissionRule { agentRole: string; toolPattern: string; allowed: boolean; requireApproval: boolean }
/** Caller supplies only the current task's and global rules. An explicit denial vetoes grants. */
export function toolPermission(rules: PermissionRule[], role: string, tool: string): { allowed: boolean; requireApproval: boolean } {
  const matched = rules.filter((rule) => rule.agentRole === role && matchToolPattern(rule.toolPattern, tool));
  return { allowed: matched.some((rule) => rule.allowed) && !matched.some((rule) => !rule.allowed), requireApproval: matched.some((rule) => rule.allowed && rule.requireApproval) };
}
