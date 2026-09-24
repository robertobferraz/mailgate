import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { renderTimelinePage } from './timeline-page';
import { reimbursementInputSchema } from './reimbursement-input';
import { RunsService, RunView } from './runs.service';

@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
  ): Promise<{ id: string; status: 'PENDING' }> {
    const parsed = reimbursementInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'invalid input',
        errors: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const run = await this.runs.create(parsed.data);
    return { id: run.id, status: 'PENDING' };
  }

  @Get(':id/timeline')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  )
  @Header('X-Content-Type-Options', 'nosniff')
  async timeline(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<string> {
    const view = await this.runs.getView(id);
    if (!view) throw new NotFoundException();
    return renderTimelinePage(view);
  }

  @Get(':id')
  async get(@Param('id', new ParseUUIDPipe()) id: string): Promise<RunView> {
    const view = await this.runs.getView(id);
    if (!view) throw new NotFoundException();
    return view;
  }
}
