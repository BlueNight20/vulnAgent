import { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { UsageTrendPoint } from '@vulnagent/shared';
import { EmptyState } from '../ui/panel';

export function UsageTrendChart({ points }: { points: UsageTrendPoint[] }) {
  const hasData = points.some((p) => p.tokens > 0);

  const option = useMemo(
    () => ({
      grid: { left: 44, right: 16, top: 24, bottom: 28 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#0B1F3A',
        borderWidth: 0,
        textStyle: { color: '#E2E8F0', fontSize: 11 },
      },
      xAxis: {
        type: 'category',
        data: points.map((p) => p.date.slice(5)),
        axisLine: { lineStyle: { color: '#E2E8F0' } },
        axisTick: { show: false },
        axisLabel: { color: '#94A3B8', fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: '#F1F5F9' } },
        axisLabel: { color: '#94A3B8', fontSize: 10 },
      },
      series: [
        {
          name: 'Token',
          type: 'line',
          smooth: true,
          symbolSize: 4,
          data: points.map((p) => p.tokens),
          itemStyle: { color: '#2563EB' },
          lineStyle: { width: 2 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(37,99,235,0.22)' },
                { offset: 1, color: 'rgba(37,99,235,0.01)' },
              ],
            },
          },
        },
      ],
    }),
    [points],
  );

  if (!hasData) {
    return (
      <EmptyState
        title="暂无 Token 消耗数据"
        description="图表数据来源于 model_usage 表，需在接入执行引擎并产生模型调用后才有真实数据。"
      />
    );
  }

  return <ReactECharts option={option} style={{ height: 220 }} opts={{ renderer: 'canvas' }} />;
}
