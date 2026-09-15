import type { Principal } from '../../auth/principal.js';
import {
  canManageEnrollment,
  canViewEnrollment,
  type EnrollmentFacts,
} from '../../authz/policies.js';
import { visibleEnrollmentsWhere } from '../../authz/scopes.js';
import { requireTenantId } from '../../db/scope.js';
import type { DbClient, TenantDb } from '../../db/tenant-db.js';
import {
  Prisma,
  type EnrollmentSource,
  type EnrollmentStatus,
} from '../../generated/prisma/client.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../lib/errors.js';
import { keysetArgs, keysetPage, type SortOption } from '../../lib/keyset.js';
import type { Page } from '../../lib/pagination.js';
import type { AuditLogger } from '../audit/audit.service.js';
import type { Outbox } from '../outbox/outbox.service.js';
import type { TenantsService } from '../tenants/tenants.service.js';
import { canTransition, holdsSeat } from './enrollment-status.js';

export const ENROLLMENT_SORT_FIELDS = ['createdAt'] as const;

export interface EnrollmentView {
  id: string;
  status: EnrollmentStatus;
  source: EnrollmentSource;
  student: { id: string; name: string; email: string };
  section: { id: string; name: string; term: string | null };
  course: { id: string; code: string; title: string };
  completedAt: Date | null;
  droppedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnrollmentListQuery {
  limit: number;
  cursor?: string | undefined;
  sort: SortOption<(typeof ENROLLMENT_SORT_FIELDS)[number]>;
  sectionId?: string | undefined;
  courseId?: string | undefined;
  studentId?: string | undefined;
  status?: EnrollmentStatus | undefined;
}

export const enrollmentInclude = {
  student: { select: { id: true, name: true, email: true } },
  section: {
    select: {
      id: true,
      name: true,
      term: true,
      instructorId: true,
      course: { select: { id: true, code: true, title: true, ownerId: true } },
    },
  },
} satisfies Prisma.EnrollmentInclude;

export type EnrollmentRow = Prisma.EnrollmentGetPayload<{ include: typeof enrollmentInclude }>;

export const factsOf = (enrollment: EnrollmentRow): EnrollmentFacts => ({
  studentId: enrollment.studentId,
  courseOwnerId: enrollment.section.course.ownerId,
  sectionInstructorId: enrollment.section.instructorId,
});

const toView = (enrollment: EnrollmentRow): EnrollmentView => ({
  id: enrollment.id,
  status: enrollment.status,
  source: enrollment.source,
  student: enrollment.student,
  section: {
    id: enrollment.section.id,
    name: enrollment.section.name,
    term: enrollment.section.term,
  },
  course: {
    id: enrollment.section.course.id,
    code: enrollment.section.course.code,
    title: enrollment.section.course.title,
  },
  completedAt: enrollment.completedAt,
  droppedAt: enrollment.droppedAt,
  createdAt: enrollment.createdAt,
  updatedAt: enrollment.updatedAt,
});

const enrollmentNotFound = () => new NotFoundError('Enrollment not found.');
const sectionNotFound = () =>
  new NotFoundError('Section not found.', { code: 'SECTION_NOT_FOUND' });

export class EnrollmentsService {
  constructor(
    private readonly deps: {
      db: TenantDb;
      audit: AuditLogger;
      outbox: Outbox;
      tenants: TenantsService;
    },
  ) {}

  async list(principal: Principal, query: EnrollmentListQuery): Promise<Page<EnrollmentView>> {
    const keyset = keysetArgs(query.sort, query.cursor, (_field, value) => new Date(String(value)));
    const filters: Prisma.EnrollmentWhereInput = {
      ...(query.sectionId ? { sectionId: query.sectionId } : {}),
      ...(query.courseId ? { section: { courseId: query.courseId } } : {}),
      ...(query.studentId ? { studentId: query.studentId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const rows = await this.deps.db.client.enrollment.findMany({
      where: {
        AND: [
          visibleEnrollmentsWhere(principal),
          filters,
          keyset.where as Prisma.EnrollmentWhereInput,
        ],
      },
      orderBy: keyset.orderBy as Prisma.EnrollmentOrderByWithRelationInput[],
      take: query.limit + 1,
      include: enrollmentInclude,
    });
    return keysetPage(rows, query.limit, query.sort, (row) => row.createdAt.toISOString(), toView);
  }

  async get(principal: Principal, id: string): Promise<EnrollmentView> {
    return toView(await this.loadVisible(principal, id));
  }

  /** The enrollment if the principal may see it; 404 otherwise. Shared with grades. */
  async loadVisible(principal: Principal, id: string): Promise<EnrollmentRow> {
    const enrollment = await this.deps.db.client.enrollment.findUnique({
      where: { id },
      include: enrollmentInclude,
    });
    if (!enrollment || !canViewEnrollment(principal, factsOf(enrollment)))
      throw enrollmentNotFound();
    return enrollment;
  }

  /**
   * Self-enrollment (students, free published courses, when the school allows it) or enrollment
   * by staff who teach the section. Capacity is enforced with an atomic conditional increment,
   * so concurrent requests can never overfill a section.
   */
  async enroll(
    principal: Principal,
    input: { sectionId: string; studentId?: string | undefined },
  ): Promise<EnrollmentView> {
    const selfService =
      principal.kind === 'user' && (!input.studentId || input.studentId === principal.userId);
    const studentId = input.studentId ?? (principal.kind === 'user' ? principal.userId : undefined);
    if (!studentId) {
      throw new UnprocessableError('studentId is required when an API key enrolls a student.', {
        code: 'STUDENT_REQUIRED',
      });
    }
    const source: EnrollmentSource = selfService ? 'self' : 'admin';

    return this.deps.db.transaction(async (tx) => {
      const section = await tx.section.findUnique({
        where: { id: input.sectionId },
        include: {
          course: { select: { id: true, ownerId: true, status: true, priceCents: true } },
        },
      });
      if (!section) throw sectionNotFound();

      if (selfService) {
        if (!principal.permissions.has('enrollment:self'))
          throw new ForbiddenError('You cannot enroll yourself.');
        // Unpublished courses are invisible to students, so they get the same 404 as a missing one.
        if (section.course.status !== 'published') throw sectionNotFound();
        if (!(await this.deps.tenants.features()).selfEnrollment) {
          throw new ForbiddenError('Self-enrollment is turned off at this school.', {
            code: 'SELF_ENROLLMENT_DISABLED',
          });
        }
        if ((section.course.priceCents ?? 0) > 0) {
          throw new ConflictError('This course requires payment. Enroll through checkout.', {
            code: 'PAYMENT_REQUIRED',
          });
        }
      } else {
        const facts = {
          studentId,
          courseOwnerId: section.course.ownerId,
          sectionInstructorId: section.instructorId,
        };
        if (!canManageEnrollment(principal, facts)) {
          throw new ForbiddenError('You can only enroll students in sections you teach.');
        }
        if (section.course.status === 'archived') {
          throw new ConflictError('This course is archived.', { code: 'COURSE_ARCHIVED' });
        }
        const student = await tx.user.findUnique({
          where: { id: studentId },
          select: { status: true },
        });
        if (student?.status !== 'active') {
          throw new UnprocessableError('The student must be an active user at this school.', {
            code: 'INVALID_STUDENT',
          });
        }
      }

      const tenantId = requireTenantId();
      const existing = await tx.enrollment.findUnique({
        where: { tenantId_sectionId_studentId: { tenantId, sectionId: section.id, studentId } },
      });
      if (existing && existing.status !== 'dropped') {
        throw new ConflictError('The student is already enrolled in this section.', {
          code: 'ALREADY_ENROLLED',
        });
      }

      await takeSeat(tx, section.id);
      const enrollment = existing
        ? await tx.enrollment.update({
            where: { id: existing.id },
            data: { status: 'active', source, droppedAt: null },
            include: enrollmentInclude,
          })
        : await tx.enrollment
            .create({
              data: { tenantId, sectionId: section.id, studentId, status: 'active', source },
              include: enrollmentInclude,
            })
            .catch((error: unknown) => {
              if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                throw new ConflictError('The student is already enrolled in this section.', {
                  code: 'ALREADY_ENROLLED',
                });
              }
              throw error;
            });

      await this.deps.audit.record({
        action: 'enrollment.created',
        resourceType: 'enrollment',
        resourceId: enrollment.id,
        metadata: { sectionId: section.id, studentId, source, reactivated: existing !== null },
      });
      await this.deps.outbox.emit({
        type: 'enrollment.created',
        aggregateType: 'enrollment',
        aggregateId: enrollment.id,
        payload: {
          enrollmentId: enrollment.id,
          sectionId: section.id,
          courseId: section.course.id,
          studentId,
          source,
        },
      });
      return toView(enrollment);
    });
  }

  /** Students may drop their own enrollment; staff who teach it may make any allowed change. */
  async changeStatus(
    principal: Principal,
    id: string,
    target: EnrollmentStatus,
  ): Promise<EnrollmentView> {
    return this.deps.db.transaction(async (tx) => {
      const enrollment = await this.loadVisible(principal, id);
      const facts = factsOf(enrollment);
      const ownDrop =
        principal.kind === 'user' &&
        enrollment.studentId === principal.userId &&
        target === 'dropped' &&
        principal.permissions.has('enrollment:self');
      if (!ownDrop && !canManageEnrollment(principal, facts)) {
        throw new ForbiddenError('You cannot change this enrollment.');
      }

      const from = enrollment.status;
      if (from === target) return toView(enrollment);
      if (!canTransition(from, target)) {
        throw new ConflictError(`An enrollment cannot go from ${from} to ${target}.`, {
          code: 'INVALID_TRANSITION',
        });
      }

      if (!holdsSeat(from) && holdsSeat(target)) await takeSeat(tx, enrollment.section.id);
      const now = new Date();
      // Conditional on the status we read: a concurrent change makes this a no-op, not a lost update.
      const changed = await tx.enrollment.updateMany({
        where: { id, status: from },
        data: {
          status: target,
          droppedAt: target === 'dropped' ? now : null,
          ...(target === 'completed'
            ? { completedAt: now }
            : target === 'active'
              ? { completedAt: null }
              : {}),
        },
      });
      if (changed.count !== 1) {
        throw new ConflictError('The enrollment changed concurrently. Reload and retry.', {
          code: 'CONCURRENT_CHANGE',
        });
      }
      if (holdsSeat(from) && !holdsSeat(target)) {
        await tx.section.update({
          where: { id: enrollment.section.id },
          data: { enrolledCount: { decrement: 1 } },
        });
      }

      await this.deps.audit.record({
        action: 'enrollment.status_changed',
        resourceType: 'enrollment',
        resourceId: id,
        metadata: { from, to: target, studentId: enrollment.studentId },
      });
      await this.deps.outbox.emit({
        type: 'enrollment.status_changed',
        aggregateType: 'enrollment',
        aggregateId: id,
        payload: {
          enrollmentId: id,
          studentId: enrollment.studentId,
          sectionId: enrollment.section.id,
          from,
          to: target,
        },
      });
      return toView(
        await tx.enrollment.findUniqueOrThrow({ where: { id }, include: enrollmentInclude }),
      );
    });
  }
}

/**
 * Takes one seat, atomically: `UPDATE sections SET enrolled_count = enrolled_count + 1 WHERE id = ?
 * AND (capacity IS NULL OR enrolled_count < capacity)`. The row lock serialises concurrent
 * enrollments and the re-checked condition rejects the one that would overfill the section.
 */
async function takeSeat(tx: DbClient, sectionId: string): Promise<void> {
  const taken = await tx.section.updateMany({
    where: {
      id: sectionId,
      OR: [{ capacity: null }, { enrolledCount: { lt: tx.section.fields.capacity } }],
    },
    data: { enrolledCount: { increment: 1 } },
  });
  if (taken.count === 0) throw new ConflictError('This section is full.', { code: 'SECTION_FULL' });
}
