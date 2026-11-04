import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  path: string;
  timestamp: string;
  details?: unknown;
}

const STATUS_CODE_MAP: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE_ENTITY',
  503: 'INTEGRATION_UNAVAILABLE',
};

export class IntegrationUnavailableError extends HttpException {
  constructor(message: string, details?: unknown) {
    super({ message, details }, HttpStatus.SERVICE_UNAVAILABLE);
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = '服务器内部错误';
    let details: unknown;
    let code = 'INTERNAL_ERROR';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = STATUS_CODE_MAP[status] ?? 'HTTP_ERROR';
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (res && typeof res === 'object') {
        const body = res as { message?: string | string[]; details?: unknown; error?: string };
        message = Array.isArray(body.message)
          ? body.message.join('；')
          : (body.message ?? body.error ?? message);
        details = body.details;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(`未处理异常: ${exception.message}`, exception.stack);
    }

    const body: ErrorBody = {
      statusCode: status,
      code,
      message,
      path: request?.url ?? '',
      timestamp: new Date().toISOString(),
    };
    if (details !== undefined) body.details = details;

    response.status(status).json(body);
  }
}
