import type { Sql } from '../db';
import type { Env } from '../env';
import type { User } from './auth';

/** Everything a handler needs for one request. */
export interface Ctx {
  sql: Sql;
  env: Env;
  user: User;
  url: URL;
  params: Record<string, string>;
  req: Request;
  exec: ExecutionContext;
  /** Tables changed by this request, sent to the live-updates hub after the response. */
  changed: string[];
}
