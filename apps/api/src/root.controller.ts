import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

@ApiExcludeController()
@Controller()
export class RootController {
  @Get()
  root() {
    return {
      service: 'multiwa-gateway-api',
      status: 'ok',
      docs: '/api/docs',
      api: '/api/v1',
      health: '/api/v1/health',
    };
  }
}
