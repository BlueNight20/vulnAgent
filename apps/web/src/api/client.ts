export interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
  path?: string;
  timestamp?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const BASE = '/api';

/** 网络层失败（连接被拒、连接被重置、代理异常）统一转成可读错误，避免界面出现英文 TypeError。 */
const NETWORK_ERROR_MESSAGE = '无法连接后端服务。请确认 API 已启动、端口未被占用，然后重试。';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      ...init,
    });
  } catch (cause) {
    throw new ApiError(NETWORK_ERROR_MESSAGE, 0, 'NETWORK_ERROR', cause);
  }

  // 代理或服务端异常时可能返回空响应体，不能假设一定是 JSON。
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      if (response.ok) throw new ApiError('服务端返回了无法解析的响应', response.status, 'INVALID_RESPONSE');
      data = null;
    }
  }

  if (!response.ok) {
    const body = (data ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(
      body.message ?? `请求失败（HTTP ${response.status}）`,
      response.status,
      body.code ?? 'HTTP_ERROR',
      (body as { details?: unknown }).details,
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
