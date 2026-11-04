import { cn } from '../../lib/utils';

/** 页面内提示条（信息 / 警告）。所有内容均为真实状态说明，不包含任何模拟数据。 */
export function NoticeBanner({
  tone = 'info',
  text,
  icon,
}: {
  tone?: 'info' | 'warning' | 'danger';
  text: string;
  icon?: React.ReactNode;
}) {
  const cls =
    tone === 'danger'
      ? 'border-red-200 bg-red-50 text-red-700'
      : tone === 'warning'
        ? 'border-amber-200 bg-amber-50 text-amber-800'
        : 'border-brand-100 bg-brand-50 text-brand-700';
  return (
    <div className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]', cls)}>
      {icon}
      <span>{text}</span>
    </div>
  );
}
