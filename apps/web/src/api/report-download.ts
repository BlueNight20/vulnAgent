export async function downloadReportFile(path: string, filename: string): Promise<void> {
  const response = await fetch(`/api${path}`);
  if (!response.ok) {
    let message = `导出失败（HTTP ${response.status}）`;
    try { const error = await response.json() as { message?: string | string[] }; if (error.message) message = Array.isArray(error.message) ? error.message.join('；') : error.message; } catch { /* Keep status. */ }
    throw new Error(message);
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
