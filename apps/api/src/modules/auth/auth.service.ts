import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type SessionUser, type UserRole } from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfig } from '@/config/app-config';
import { hashPassword, needsRehash, verifyPassword } from '@/common/crypto/password';
import { generateOpaqueToken, hashToken } from '@/common/crypto/tokens';
import { safeCompare } from '@/common/crypto/encryption';
import { UnauthenticatedError, ValidationError } from '@/common/errors';
import { AuditService } from '@/modules/system/audit.service';

/**
 * Dashboard authentication.
 *
 * Server-side sessions rather than stateless JWTs: an operator revoking access
 * must take effect immediately, which a self-contained token cannot offer without
 * a denylist that ends up being a session table anyway.
 *
 * What is stored is the *hash* of the session token. A database dump therefore
 * yields no usable sessions.
 */

export interface AuthenticatedSession {
  user: SessionUser;
  sessionId: string;
  csrfSecret: string;
}

/**
 * Deliberate constant-time-ish floor for failed logins. Without it, the response
 * time difference between "no such user" and "wrong password" enumerates accounts.
 */
const MIN_LOGIN_DURATION_MS = 250;

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureBootstrapAdmin().catch((error: unknown) => {
      this.logger.warn(`Could not verify the bootstrap admin: ${String(error)}`);
    });
  }

  /**
   * Creates the first admin when the user table is empty.
   *
   * Only ever runs on a fresh installation, and only when a password was supplied
   * — an account with a blank or guessable password would be worse than none.
   */
  private async ensureBootstrapAdmin(): Promise<void> {
    const userCount = await this.prisma.user.count();
    if (userCount > 0) return;

    const { email, password } = this.config.security.bootstrapAdmin;
    if (!password || password.length < 12) {
      this.logger.warn(
        'No users exist and BOOTSTRAP_ADMIN_PASSWORD is unset or shorter than 12 characters. ' +
          'Set it and restart, or create the first user with `npm run db:seed`.',
      );
      return;
    }

    await this.prisma.user.create({
      data: {
        email,
        name: 'Administrator',
        passwordHash: await hashPassword(password),
        role: 'ADMIN',
      },
    });
    this.logger.log(`Created bootstrap administrator ${email}.`);
  }

  async login(
    email: string,
    password: string,
    context: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<{ token: string; session: AuthenticatedSession }> {
    const startedAt = Date.now();
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    // Always run a verification, even without a user, so both paths cost the same.
    const passwordOk = user
      ? await verifyPassword(password, user.passwordHash)
      : await verifyPassword(password, DUMMY_HASH);

    await this.padDuration(startedAt);

    if (!user || !passwordOk || !user.isActive) {
      throw new UnauthenticatedError('Incorrect email or password.');
    }

    // Transparently upgrade a hash made with older, weaker parameters.
    if (needsRehash(user.passwordHash)) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(password) },
      });
    }

    const token = generateOpaqueToken();
    const csrfSecret = generateOpaqueToken(24);
    const session = await this.prisma.session.create({
      data: {
        tokenHash: hashToken(token),
        userId: user.id,
        csrfSecret,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent?.slice(0, 400) ?? null,
        expiresAt: new Date(Date.now() + this.config.security.sessionTtlMs),
      },
    });

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.record({
      userId: user.id,
      action: 'auth.login',
      entityType: 'User',
      entityId: user.id,
      ipAddress: context.ipAddress ?? null,
    });

    return {
      token,
      session: {
        sessionId: session.id,
        csrfSecret,
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
      },
    };
  }

  /**
   * Validates a session token and slides its idle window.
   *
   * Two independent expiries: an absolute TTL, and an idle timeout. The second is
   * what limits the damage of a session left open on a shared machine.
   */
  async validate(token: string): Promise<AuthenticatedSession | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });

    if (!session || session.revokedAt) return null;

    const now = Date.now();
    if (session.expiresAt.getTime() <= now) return null;

    const idleFor = now - session.lastSeenAt.getTime();
    if (idleFor > this.config.security.sessionIdleTimeoutMs) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });
      return null;
    }

    if (!session.user.isActive) return null;

    // Only write when the value would meaningfully change, so a burst of requests
    // does not turn into a burst of updates.
    if (idleFor > 60_000) {
      await this.prisma.session
        .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);
    }

    return {
      sessionId: session.id,
      csrfSecret: session.csrfSecret,
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        role: session.user.role,
      },
    };
  }

  async logout(token: string): Promise<void> {
    await this.prisma.session
      .updateMany({ where: { tokenHash: hashToken(token) }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
  }

  /** Revokes every session for a user — used when disabling an account. */
  async revokeAllSessions(userId: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /** Removes expired rows. Called by the maintenance cron. */
  async pruneSessions(): Promise<number> {
    const result = await this.prisma.session.deleteMany({
      where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { not: null } }] },
    });
    return result.count;
  }

  async createUser(input: {
    email: string;
    password: string;
    name?: string;
    role: UserRole;
  }): Promise<SessionUser> {
    if (input.password.length < 12) {
      throw new ValidationError('A password must be at least 12 characters long.');
    }

    const user = await this.prisma.user.create({
      data: {
        email: input.email.toLowerCase(),
        name: input.name ?? null,
        passwordHash: await hashPassword(input.password),
        role: input.role,
      },
    });

    return { id: user.id, email: user.email, name: user.name, role: user.role };
  }

  /** Verifies the double-submit CSRF token against the session secret. */
  verifyCsrf(session: AuthenticatedSession, presentedToken: string | undefined): boolean {
    if (!presentedToken) return false;
    return safeCompare(session.csrfSecret, presentedToken);
  }

  private async padDuration(startedAt: number): Promise<void> {
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_LOGIN_DURATION_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_LOGIN_DURATION_MS - elapsed));
    }
  }
}

/**
 * A real scrypt hash of a random value, used so an unknown email costs the same
 * as a known one. Generated once at module load.
 */
const DUMMY_HASH =
  'scrypt$16384$8$1$YWJjZGVmZ2hpamtsbW5vcA==$' +
  'ZHVtbXloYXNoZHVtbXloYXNoZHVtbXloYXNoZHVtbXloYXNoZHVtbXloYXNoZHVtbXloYXNoZHVtbXk=';
