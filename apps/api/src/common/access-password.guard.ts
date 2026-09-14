import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { CONFIG, type AppConfig } from '../config/configuration.js';
import { IS_PUBLIC } from './public.decorator.js';

/**
 * One password for the whole app.
 *
 * Deliberately a password and not an API key. An API key implies a machine
 * credential issued per client and rotated independently; this is a single
 * word a person types into a box once, and calling it a key made it sound
 * like something it is not.
 *
 * Be clear about what it still is not: authentication. One secret shared by
 * everyone on the team means no per-person identity, so nothing here can tell
 * you who saved an article or who deleted one, and revoking access for one
 * person means changing it for everybody.
 *
 * That is the right trade for an internal tool on a network you control, and
 * the wrong one for anything reachable from the public internet. It exists
 * because the article library stores real work on the server: without it,
 * anyone who can reach the port reads every brand and every article.
 *
 * OPTIONAL, and unset by default. Leave ACCESS_PASSWORD blank and the whole
 * app is open, which is exactly right on your own machine. The bootstrap logs
 * loudly when that happens, because an open server and a protected one look
 * identical from the outside.
 */
@Injectable()
export class AccessPasswordGuard implements CanActivate {
  private static readonly HEADER = 'x-access-password';
  private readonly logger = new Logger(AccessPasswordGuard.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const expected = this.config.accessPassword;
    // No password set: open, which is the default. Suits a single machine.
    if (!expected) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers[AccessPasswordGuard.HEADER];
    const supplied = Array.isArray(header) ? header[0] : header;

    if (!supplied || !AccessPasswordGuard.matches(supplied, expected)) {
      // Deliberately vague. Distinguishing "wrong password" from "no password
      // sent" tells an attacker which half of the problem to work on.
      throw new UnauthorizedException(
        'This server is password protected. Enter the password in the app, ' +
          'or set ACCESS_PASSWORD on the server if you are the one running it.',
      );
    }
    return true;
  }

  /**
   * Constant-time compare.
   *
   * A plain `===` on secrets leaks their contents through timing: it returns
   * as soon as two characters differ, so an attacker can recover the password
   * one character at a time. The length is compared first and separately,
   * because timingSafeEqual throws on mismatched lengths, and length alone is
   * not worth protecting.
   */
  private static matches(supplied: string, expected: string): boolean {
    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
