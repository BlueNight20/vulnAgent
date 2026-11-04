import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@vulnagent/shared';

export interface Pagination {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export function normalizePagination(
  page?: number | string,
  pageSize?: number | string,
): Pagination {
  const p = Math.max(1, Math.trunc(Number(page) || 1));
  const rawSize = Math.trunc(Number(pageSize) || DEFAULT_PAGE_SIZE);
  const size = Math.min(Math.max(1, rawSize), MAX_PAGE_SIZE);
  return { page: p, pageSize: size, skip: (p - 1) * size, take: size };
}
