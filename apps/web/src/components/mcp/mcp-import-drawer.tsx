import { useState } from 'react';
import { Drawer } from '../ui/drawer';
import { Textarea } from '../ui/input';
import { Button } from '../ui/button';
import { mcpApi } from '../../api/mcp';
import { parseMcpImport } from './mcp-import';

export function McpImportDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<Array<{ name: string; ok: boolean; message: string }>>([]);
  const [done, setDone] = useState<Set<string>>(new Set());
  async function run() {
    setError('');
    let configs;
    try { configs = parseMcpImport(text); } catch (e) { setError((e as Error).message); return; }
    setBusy(true); setResults([]);
    try {
      for (const config of configs) {
        if (done.has(config.name)) { setResults((old) => [...old, { name: config.name, ok: true, message: '本次已添加' }]); continue; }
        try {
          const server = await mcpApi.create(config);
          setDone((old) => new Set([...old, config.name]));
          setResults((old) => [...old, { name: config.name, ok: true, message: `已添加 · ${server.toolCount} 工具` }]);
          onSaved();
        } catch (e) { setResults((old) => [...old, { name: config.name, ok: false, message: (e as Error).message }]); }
      }
    } finally { setBusy(false); }
  }
  return <Drawer open title="导入 MCP 配置" description="粘贴 mcpServers JSON，逐项检测连接并保存。" onClose={() => { if (!busy) onClose(); }} footer={<Button variant="primary" loading={busy} disabled={!text.trim()} onClick={() => void run()}>检测并导入</Button>}>
    <label className="text-sm">服务配置<Textarea aria-label="MCP JSON 配置" className="mt-2 font-mono" rows={14} value={text} disabled={busy} onChange={(e) => { setText(e.target.value); setError(''); }} placeholder={'{"mcpServers":{"Browser":{"url":"http://127.0.0.1:8931/mcp"}}}'} /></label>
    <p className="mt-2 text-xs text-ink-400">支持 Streamable HTTP、SSE、stdio 和自定义请求头。凭据加密保存；同名服务会返回冲突，不覆盖已有配置。</p>
    {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
    <ul aria-live="polite" className="mt-4 space-y-2">{results.map((result) => <li key={result.name} className={`rounded p-3 text-sm ${result.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}><strong>{result.name}</strong> · {result.message}</li>)}</ul>
  </Drawer>;
}
