import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MessageStream } from './message-stream';

it('可查看无文本工具调用的参数和超出预览的完整消息，原文按文本转义', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView'); Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const complete = '完整回复'.repeat(2200) + '<img src=x onerror=alert(1)>';
  try {
    await act(async () => root.render(<MessageStream loading={false} messages={[
      { id: 'tool', sessionId: 'session', seq: 1, role: 'assistant', content: '', messageJson: { role: 'assistant', content: [{ type: 'toolCall', id: 'sdk-call', name: 'nmap_scan', arguments: { target: '192.0.2.10', ports: '80' } }] }, toolCallId: null, toolName: null, usage: null, createdAt: '' },
      { id: 'long', sessionId: 'session', seq: 2, role: 'assistant', content: complete.slice(0, 8000), messageJson: { role: 'assistant', content: [{ type: 'text', text: complete }] }, toolCallId: null, toolName: null, usage: null, createdAt: '' },
    ]} />));
    expect(container.querySelectorAll('details')).toHaveLength(2); expect(container.querySelector('details pre')?.textContent).toContain('nmap_scan'); expect(container.querySelector('details pre')?.textContent).toContain('192.0.2.10');
    expect(container.querySelectorAll('details pre')[1].textContent).toContain(complete); expect(container.textContent).toContain('上方为文本预览'); expect(container.querySelector('img')).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); if (descriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', descriptor); else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); }
});
