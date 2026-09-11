import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { Sql } from 'postgres';

@Injectable()
export class DrizzleService implements OnModuleDestroy {
  private readonly client: Sql;
  readonly db;

  constructor(private readonly configService: ConfigService) {
    const connectionString = this.configService.get<string>('DATABASE_URL');

    if (!connectionString) {
      throw new Error('DATABASE_URL is not configured');
    }

    this.client = postgres(connectionString, {
      prepare: false,
    });

    this.db = drizzle(this.client);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.end();
  }
}
