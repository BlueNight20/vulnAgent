/**
 * 前后端共享的输入校验工具。
 * 后端在 service 层做最终校验，前端用于表单即时反馈（单一实现，避免规则漂移）。
 */
const IPV4_SEGMENT = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`^${IPV4_SEGMENT}(\\.${IPV4_SEGMENT}){3}$`);
const CIDR_RE = new RegExp(`^${IPV4_SEGMENT}(\\.${IPV4_SEGMENT}){3}/([0-9]|[12][0-9]|3[0-2])$`);
export function isValidIPv4(value) {
    return IPV4_RE.test(value.trim());
}
export function isValidCidr(value) {
    return CIDR_RE.test(value.trim());
}
/** 允许 IPv4 或 CIDR（授权目标输入框） */
export function isValidTarget(value) {
    const v = value.trim();
    return isValidIPv4(v) || isValidCidr(v);
}
export function isPrivateIPv4(value) {
    if (!isValidIPv4(value))
        return false;
    const [a, b] = value.split('.').map(Number);
    if (a === 10)
        return true;
    if (a === 172 && b >= 16 && b <= 31)
        return true;
    if (a === 192 && b === 168)
        return true;
    if (a === 127)
        return true;
    return false;
}
/** 端口范围表达式，如 "1-1000"、"80,443,8000-8080"、"" */
export function isValidPortSpec(value) {
    const v = value.trim();
    if (v === '')
        return true;
    return v
        .split(',')
        .map((part) => part.trim())
        .every((part) => {
        if (!/^([0-9]{1,5})(-([0-9]{1,5}))?$/.test(part))
            return false;
        const [from, to] = part.split('-').map(Number);
        const max = Number.isNaN(to) ? from : to;
        return from >= 1 && from <= 65535 && max >= from && max <= 65535;
    });
}
export function normalizeTargets(raw) {
    return raw
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}
