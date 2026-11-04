import type { McpServerDto } from '@vulnagent/shared';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Drawer } from '../ui/drawer';
import { Input, Select, Textarea } from '../ui/input';
import { Button } from '../ui/button';
import { mcpApi, type McpServerInput } from '../../api/mcp';

export function McpAddDrawer({ onClose, onSaved, server }: { server?: McpServerDto; onClose: () => void; onSaved: (id: string) => void }) {
  const [form, setForm] = useState<McpServerInput>({ name: server?.name ?? '', endpoint: server?.endpoint ?? '', transport: server?.transport ?? 'streamable-http', token: '' });
  const [preserve, setPreserve] = useState(Boolean(server));
  const [args, setArgs] = useState('[]');
  const [env, setEnv] = useState('{}');
  const [headers, setHeaders] = useState('{}');
  const [inputError, setInputError] = useState('');
  const [auth, setAuth] = useState('none');
  const test = useMutation({ mutationFn: (input: McpServerInput) => server ? mcpApi.testUpdate(server.id, input) : mcpApi.test(input) });
  const save = useMutation({ mutationFn: (input: McpServerInput) => server ? mcpApi.update(server.id, input) : mcpApi.create(input), onSuccess: (server) => onSaved(server.id) });
  const busy = test.isPending || save.isPending;
  const update = (key: keyof McpServerInput, value: string) => { setForm((old) => ({ ...old, [key]: value })); test.reset(); save.reset(); };
  const stdio = form.transport === 'stdio';
  const valid = Boolean(form.name.trim() && (stdio ? preserve || form.command?.trim() : form.endpoint.trim() && (preserve || auth === 'none' || form.token?.trim())));
  function submit(saveServer: boolean) {
    let payload = form;
    setInputError('');
    if (preserve) {
      payload = { name: form.name, endpoint: form.endpoint, transport: form.transport, preserveCredentials: true };
    } else if (stdio) {
      try {
        const parsedArgs = JSON.parse(args); const parsedEnv = JSON.parse(env);
        if (!Array.isArray(parsedArgs) || parsedArgs.some((v) => typeof v !== 'string')) throw new Error();
        if (!parsedEnv || typeof parsedEnv !== 'object' || Array.isArray(parsedEnv) || Object.values(parsedEnv).some((v) => typeof v !== 'string')) throw new Error();
        payload = { name: form.name, transport: 'stdio', endpoint: 'stdio://local', command: form.command, args: parsedArgs, env: parsedEnv };
      } catch { setInputError('参数需要 JSON 字符串数组，环境变量需要 JSON 字符串键值对象'); return; }
    } else {
      try {
        const parsed = JSON.parse(headers);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some((v) => typeof v !== 'string')) throw new Error();
        payload = { ...form, headers: parsed };
      } catch { setInputError('请求头需要 JSON 字符串键值对象'); return; }
    }
    if (saveServer) save.mutate(payload); else test.mutate(payload);
  }
  return <Drawer open onClose={() => { if (!busy) onClose(); }} title={server ? '编辑 MCP 服务' : '添加 MCP 服务'} description="填写连接信息，检测成功后保存。" width="w-[480px] max-w-full" footer={<div className="flex gap-3"><Button disabled={!valid || busy} loading={test.isPending} onClick={() => submit(false)}>测试连接</Button><Button variant="primary" disabled={!valid || busy} loading={save.isPending} onClick={() => submit(true)}>保存服务</Button></div>}>
    <fieldset disabled={busy} className="space-y-5">
      <label className="block text-sm font-medium">服务名称 *<Input className="mt-2" value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="例如 Browser MCP" maxLength={80} /></label>
      <label className="block text-sm font-medium">传输方式<Select className="mt-2" value={form.transport} onChange={(e) => { update('transport', e.target.value); setPreserve(false); }}><option value="streamable-http">Streamable HTTP</option><option value="sse">SSE（兼容）</option><option value="stdio">stdio</option></Select></label>
      {server && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={preserve} disabled={form.transport !== server.transport} onChange={(e) => { setPreserve(e.target.checked); test.reset(); save.reset(); }} />{stdio ? '保留已保存的启动命令、参数和环境变量' : '保留已保存的认证信息与请求头'}</label>}
      {stdio ? preserve ? <p className="text-xs text-ink-400">启动配置已加密保存。取消勾选后可完整替换。</p> : <>
        <label className="block text-sm font-medium">启动命令 *<Input className="mt-2" value={form.command ?? ''} onChange={(e) => update('command', e.target.value)} placeholder="node 或可执行文件完整路径" /></label>
        <label className="block text-sm font-medium">参数（JSON 数组）<Textarea className="mt-2 font-mono" value={args} onChange={(e) => { setArgs(e.target.value); test.reset(); }} placeholder='["server.js"]' /></label>
        <label className="block text-sm font-medium">环境变量（JSON 对象）<Textarea className="mt-2 font-mono" value={env} onChange={(e) => { setEnv(e.target.value); test.reset(); }} placeholder='{"API_KEY":"..."}' /></label>
        <p className="rounded bg-blue-50 p-3 text-xs text-blue-800">服务由后端启动。命令、参数和环境变量加密保存。</p>
      </> : <>
      <label className="block text-sm font-medium">服务地址 *<Input className="mt-2" value={form.endpoint} onChange={(e) => update('endpoint', e.target.value)} placeholder="http://127.0.0.1:8931/mcp" maxLength={300} /></label>
      {!preserve && <>
      <label className="block text-sm font-medium">认证方式<Select className="mt-2" value={auth} onChange={(e) => { setAuth(e.target.value); update('token', ''); }}><option value="none">无需认证</option><option value="bearer">Bearer Token</option></Select></label>
      {auth === 'bearer' && <label className="block text-sm font-medium">访问令牌 *<Input type="password" autoComplete="new-password" className="mt-2" value={form.token} onChange={(e) => update('token', e.target.value)} /><span className="mt-2 block text-xs text-ink-400">凭据仅在后端加密保存。</span></label>}
      <details className="rounded-lg border border-ink-200 p-3">
        <summary className="cursor-pointer text-sm font-medium">高级连接设置</summary>
        <label className="mt-3 block text-sm font-medium">自定义请求头（JSON 对象）<Textarea className="mt-2 font-mono" value={headers} onChange={(e) => { setHeaders(e.target.value); test.reset(); save.reset(); }} placeholder='{"X-API-Key":"..."}' /></label>
        <p className="mt-2 text-xs text-ink-400">请求头加密保存，可用于 API Key 认证。使用 Bearer Token 时请勿重复填写 Authorization。</p>
      </details>
      </>}
      </>}
    </fieldset>
    {inputError && <p role="alert" className="mt-3 text-sm text-red-700">{inputError}</p>}
    {test.data && <div role="status" className={`mt-6 rounded-lg border p-4 ${test.data.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800'}`}>{test.data.ok ? `连接成功 · 已发现 ${test.data.toolCount} 个工具 · ${test.data.latencyMs} ms` : test.data.error}</div>}
    {(test.error || save.error) && <p role="alert" className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700">{(test.error || save.error)?.message}</p>}
  </Drawer>;
}
