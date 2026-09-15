import type { Principal } from '../../auth/principal.js';
import { canGradeEnrollment, canViewGrades } from '../../authz/policies.js';
import { requireTenantId } from '../../db/scope.js';
import type { TenantDb } from '../../db/tenant-db.js';
import { Prisma, type Grade } from '../../generated/prisma/client.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../lib/errors.js';
import type { AuditLogger } from '../audit/audit.service.js';
import type { EnrollmentRow, EnrollmentsService } from '../enrollments/enrollments.service.js';
import { factsOf, enrollmentInclude } from '../enrollments/enrollments.service.js';
import type { Outbox } from '../outbox/outbox.service.js';

export interface GradeView {
  id: string;
  enrollmentId: string;
  title: string;
  score: number;
  maxScore: number;
  feedback: string | null;
  gradedById: string | null;
  gradedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface GradeSummary {
  count: number;
  totalScore: number;
  totalMaxScore: number;
  /** Share of the available points earned, 0-100 with two decimals; null before any grade. */
  percentage: number | null;
}

export interface GradeInput {
  title: string;
  score: number;
  maxScore: number;
  feedback?: string | null | undefined;
}

const toView = (grade: Grade): GradeView => ({
  id: grade.id,
  enrollmentId: grade.enrollmentId,
  title: grade.title,
  score: grade.score.toNumber(),
  maxScore: grade.maxScore.toNumber(),
  feedback: grade.feedback,
  gradedById: grade.gradedById,
  gradedAt: grade.gradedAt,
  createdAt: grade.createdAt,
  updatedAt: grade.updatedAt,
});

/** Decimal arithmetic, so a column of 0.1s adds up to what the gradebook shows. */
export function summarize(grades: readonly Pick<Grade, 'score' | 'maxScore'>[]): GradeSummary {
  const zero = new Prisma.Decimal(0);
  const totalScore = grades.reduce((sum, grade) => sum.plus(grade.score), zero);
  const totalMaxScore = grades.reduce((sum, grade) => sum.plus(grade.maxScore), zero);
  return {
    count: grades.length,
    totalScore: totalScore.toNumber(),
    totalMaxScore: totalMaxScore.toNumber(),
    percentage: totalMaxScore.isZero()
      ? null
      : totalScore.div(totalMaxScore).times(100).toDecimalPlaces(2).toNumber(),
  };
}

/** Grades can be recorded while a student is enrolled or after they complete, not once dropped. */
const GRADABLE = new Set(['active', 'completed']);

const gradeNotFound = () => new NotFoundError('Grade not found.');

const assertScoreWithinMax = (score: number, maxScore: number) => {
  if (score > maxScore) {
    throw new UnprocessableError('score cannot be greater than maxScore.', {
      code: 'INVALID_SCORE',
    });
  }
};

// Decimal(7, 2) columns: pass exact decimal strings so binary floats never reach the database.
const decimal = (value: number) => value.toFixed(2);

export class GradesService {
  constructor(
    private readonly deps: {
      db: TenantDb;
      audit: AuditLogger;
      outbox: Outbox;
      enrollments: EnrollmentsService;
    },
  ) {}

  async list(
    principal: Principal,
    enrollmentId: string,
  ): Promise<{ data: GradeView[]; summary: GradeSummary }> {
    const enrollment = await this.deps.enrollments.loadVisible(principal, enrollmentId);
    if (!canViewGrades(principal, factsOf(enrollment)))
      throw new NotFoundError('Enrollment not found.');
    const grades = await this.deps.db.client.grade.findMany({
      where: { enrollmentId },
      orderBy: [{ gradedAt: 'asc' }, { id: 'asc' }],
    });
    return { data: grades.map(toView), summary: summarize(grades) };
  }

  async record(principal: Principal, enrollmentId: string, input: GradeInput): Promise<GradeView> {
    assertScoreWithinMax(input.score, input.maxScore);
    return this.deps.db.transaction(async (tx) => {
      const enrollment = await this.deps.enrollments.loadVisible(principal, enrollmentId);
      this.#assertCanGrade(principal, enrollment);
      if (!GRADABLE.has(enrollment.status)) {
        throw new ConflictError(
          `Grades cannot be recorded for a ${enrollment.status} enrollment.`,
          {
            code: 'ENROLLMENT_NOT_GRADABLE',
          },
        );
      }

      const grade = await tx.grade.create({
        data: {
          tenantId: requireTenantId(),
          enrollmentId,
          title: input.title,
          score: decimal(input.score),
          maxScore: decimal(input.maxScore),
          feedback: input.feedback ?? null,
          gradedById: principal.kind === 'user' ? principal.userId : null,
        },
      });
      await this.deps.audit.record({
        action: 'grade.recorded',
        resourceType: 'grade',
        resourceId: grade.id,
        metadata: { enrollmentId, studentId: enrollment.studentId, title: grade.title },
      });
      await this.deps.outbox.emit({
        type: 'grade.recorded',
        aggregateType: 'grade',
        aggregateId: grade.id,
        payload: {
          gradeId: grade.id,
          enrollmentId,
          studentId: enrollment.studentId,
          courseId: enrollment.section.course.id,
          title: grade.title,
          score: grade.score.toNumber(),
          maxScore: grade.maxScore.toNumber(),
        },
      });
      return toView(grade);
    });
  }

  async update(
    principal: Principal,
    gradeId: string,
    patch: Partial<GradeInput>,
  ): Promise<GradeView> {
    return this.deps.db.transaction(async (tx) => {
      const { grade, enrollment } = await this.#loadGradable(principal, gradeId);
      assertScoreWithinMax(
        patch.score ?? grade.score.toNumber(),
        patch.maxScore ?? grade.maxScore.toNumber(),
      );

      const updated = await tx.grade.update({
        where: { id: gradeId },
        data: {
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.score !== undefined ? { score: decimal(patch.score) } : {}),
          ...(patch.maxScore !== undefined ? { maxScore: decimal(patch.maxScore) } : {}),
          ...(patch.feedback !== undefined ? { feedback: patch.feedback } : {}),
          gradedById: principal.kind === 'user' ? principal.userId : grade.gradedById,
          gradedAt: new Date(),
        },
      });
      await this.deps.audit.record({
        action: 'grade.updated',
        resourceType: 'grade',
        resourceId: gradeId,
        metadata: {
          enrollmentId: grade.enrollmentId,
          studentId: enrollment.studentId,
          before: { score: grade.score.toNumber(), maxScore: grade.maxScore.toNumber() },
          after: { score: updated.score.toNumber(), maxScore: updated.maxScore.toNumber() },
        },
      });
      return toView(updated);
    });
  }

  async delete(principal: Principal, gradeId: string): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const { grade, enrollment } = await this.#loadGradable(principal, gradeId);
      await tx.grade.delete({ where: { id: gradeId } });
      await this.deps.audit.record({
        action: 'grade.deleted',
        resourceType: 'grade',
        resourceId: gradeId,
        metadata: {
          enrollmentId: grade.enrollmentId,
          studentId: enrollment.studentId,
          title: grade.title,
          score: grade.score.toNumber(),
          maxScore: grade.maxScore.toNumber(),
        },
      });
    });
  }

  /** 404 unless the grade's enrollment is visible; 403 if visible but not gradable by the caller. */
  async #loadGradable(
    principal: Principal,
    gradeId: string,
  ): Promise<{ grade: Grade; enrollment: EnrollmentRow }> {
    const grade = await this.deps.db.client.grade.findUnique({
      where: { id: gradeId },
      include: { enrollment: { include: enrollmentInclude } },
    });
    if (!grade || !canViewGrades(principal, factsOf(grade.enrollment))) throw gradeNotFound();
    this.#assertCanGrade(principal, grade.enrollment);
    const { enrollment, ...row } = grade;
    return { grade: row, enrollment };
  }

  #assertCanGrade(principal: Principal, enrollment: EnrollmentRow): void {
    if (!canGradeEnrollment(principal, factsOf(enrollment))) {
      throw new ForbiddenError('Only staff who teach this section can grade it.');
    }
  }
}
