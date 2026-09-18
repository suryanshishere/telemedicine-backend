import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request & { id?: string }>();
    const response = context.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const body = exception instanceof HttpException ? exception.getResponse() : undefined;
    const detail =
      typeof body === 'string'
        ? body
        : body && typeof body === 'object' && 'message' in body
          ? (body as { message: string | string[] }).message
          : status === 500
            ? 'An unexpected error occurred'
            : 'Request failed';

    if (status >= 500) {
      const error = exception instanceof Error ? exception : new Error('Unknown exception');
      this.logger.error(
        `Unhandled request failure requestId=${request.id ?? 'unknown'} path=${request.originalUrl}`,
        error.stack,
      );
    }

    response
      .status(status)
      .type('application/problem+json')
      .json({
        type: `https://httpstatuses.com/${status}`,
        title: HttpStatus[status] ?? 'Error',
        status,
        detail,
        instance: request.originalUrl,
        requestId: request.id ?? request.header('x-request-id'),
        timestamp: new Date().toISOString(),
      });
  }
}
