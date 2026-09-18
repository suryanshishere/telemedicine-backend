import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, finalize } from 'rxjs';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const routeInfo = request.route as { path?: string } | undefined;
    const route: string = routeInfo?.path ?? normalizePath(request.path);
    const stop = this.metrics.requestDuration.startTimer();

    return next.handle().pipe(
      finalize(() => {
        const labels = {
          method: request.method,
          route,
          status: String(response.statusCode),
        };
        stop(labels);
        this.metrics.requestCount.inc(labels);
      }),
    );
  }
}

function normalizePath(path: string): string {
  return path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id');
}
