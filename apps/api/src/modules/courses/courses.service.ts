import type { PermissionResolver } from '../../auth/permission-resolver.js';
import type { Principal } from '../../auth/principal.js';
import {
  canDeleteCourse,
  canManageCourse,
  canViewCourse,
  type CourseFacts,
} from '../../authz/policies.js';
import { visibleCoursesWhere } from '../../authz/scopes.js';
import { requireTenantId } from '../../db/scope.js';
import type { TenantDb } from '../../db/tenant-db.js';
import { Prisma, type CourseStatus } from '../../generated/prisma/client.js';
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

export const COURSE_SORT_FIELDS = ['code', 'title', 'createdAt'] as const;
type CourseSortField = (typeof COURSE_SORT_FIELDS)[number];

export interface PersonRef {
  id: string;
  name: string;
}

export interface SectionView {
  id: string;
  courseId: string;
  name: string;
  term: string | null;
  instructor: PersonRef | null;
  capacity: number | null;
  enrolledCount: number;
  seatsAvailable: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
}

export interface CourseSummaryView {
  id: string;
  code: string;
  title: string;
  status: CourseStatus;
  priceCents: number | null;
  currency: string;
  owner: PersonRef;
  sectionCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CourseDetailView extends Omit<CourseSummaryView, 'sectionCount'> {
  description: string;
  summary: string | null;
  sections: SectionView[];
}

export interface CatalogCourseView {
  id: string;
  code: string;
  title: string;
  description: string;
  priceCents: number | null;
  currency: string;
  sections: Omit<SectionView, 'courseId' | 'enrolledCount'>[];
}

export interface CourseListQuery {
  limit: number;
  cursor?: string | undefined;
  sort: SortOption<CourseSortField>;
  status?: CourseStatus | undefined;
  q?: string | undefined;
  ownerId?: string | undefined;
}

export interface CourseInput {
  code: string;
  title: string;
  description?: string | undefined;
  priceCents?: number | null | undefined;
  currency?: string | undefined;
  ownerId?: string | undefined;
}

export interface SectionInput {
  name: string;
  term?: string | null | undefined;
  instructorId?: string | null | undefined;
  capacity?: number | null | undefined;
  startsAt?: Date | null | undefined;
  endsAt?: Date | null | undefined;
}

const summaryInclude = {
  owner: { select: { id: true, name: true } },
  _count: { select: { sections: true } },
} satisfies Prisma.CourseInclude;

const sectionInclude = {
  instructor: { select: { id: true, name: true } },
} satisfies Prisma.SectionInclude;

const detailInclude = {
  owner: { select: { id: true, name: true } },
  sections: { orderBy: { id: 'asc' }, include: sectionInclude },
} satisfies Prisma.CourseInclude;

type SummaryRow = Prisma.CourseGetPayload<{ include: typeof summaryInclude }>;
type DetailRow = Prisma.CourseGetPayload<{ include: typeof detailInclude }>;
type SectionRow = Prisma.SectionGetPayload<{ include: typeof sectionInclude }>;

const seatsAvailable = (section: { capacity: number | null; enrolledCount: number }) =>
  section.capacity === null ? null : Math.max(0, section.capacity - section.enrolledCount);

export const toSectionView = (section: SectionRow): SectionView => ({
  id: section.id,
  courseId: section.courseId,
  name: section.name,
  term: section.term,
  instructor: section.instructor,
  capacity: section.capacity,
  enrolledCount: section.enrolledCount,
  seatsAvailable: seatsAvailable(section),
  startsAt: section.startsAt,
  endsAt: section.endsAt,
});

const toSummary = (course: SummaryRow): CourseSummaryView => ({
  id: course.id,
  code: course.code,
  title: course.title,
  status: course.status,
  priceCents: course.priceCents,
  currency: course.currency,
  owner: course.owner,
  sectionCount: course._count.sections,
  createdAt: course.createdAt,
  updatedAt: course.updatedAt,
});

const toDetail = (course: DetailRow): CourseDetailView => ({
  id: course.id,
  code: course.code,
  title: course.title,
  status: course.status,
  priceCents: course.priceCents,
  currency: course.currency,
  owner: course.owner,
  description: course.description,
  summary: course.summary,
  sections: course.sections.map(toSectionView),
  createdAt: course.createdAt,
  updatedAt: course.updatedAt,
});

const courseNotFound = () => new NotFoundError('Course not found.');
const sectionNotFound = () => new NotFoundError('Section not found.');

export class CoursesService {
  constructor(
    private readonly deps: {
      db: TenantDb;
      audit: AuditLogger;
      outbox: Outbox;
      permissions: PermissionResolver;
    },
  ) {}

  // ─── Queries ────────────────────────────────────────────────────────────────────────────────

  async list(principal: Principal, query: CourseListQuery): Promise<Page<CourseSummaryView>> {
    const keyset = keysetArgs(query.sort, query.cursor, (field, value) =>
      field === 'createdAt' ? new Date(String(value)) : value,
    );
    const filters: Prisma.CourseWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.ownerId ? { ownerId: query.ownerId } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { code: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const rows = await this.deps.db.client.course.findMany({
      where: {
        AND: [visibleCoursesWhere(principal), filters, keyset.where as Prisma.CourseWhereInput],
      },
      orderBy: keyset.orderBy as Prisma.CourseOrderByWithRelationInput[],
      take: query.limit + 1,
      include: summaryInclude,
    });
    return keysetPage(
      rows,
      query.limit,
      query.sort,
      (row) => sortValue(row, query.sort.field),
      toSummary,
    );
  }

  /** Published courses with open sections: what students browse to enroll. */
  async catalog(
    query: Omit<CourseListQuery, 'status' | 'ownerId'>,
  ): Promise<Page<CatalogCourseView>> {
    const keyset = keysetArgs(query.sort, query.cursor, (field, value) =>
      field === 'createdAt' ? new Date(String(value)) : value,
    );
    const rows = await this.deps.db.client.course.findMany({
      where: {
        AND: [
          { status: 'published' },
          query.q
            ? {
                OR: [
                  { title: { contains: query.q, mode: 'insensitive' } },
                  { code: { contains: query.q, mode: 'insensitive' } },
                ],
              }
            : {},
          keyset.where as Prisma.CourseWhereInput,
        ],
      },
      orderBy: keyset.orderBy as Prisma.CourseOrderByWithRelationInput[],
      take: query.limit + 1,
      include: detailInclude,
    });
    return keysetPage(
      rows,
      query.limit,
      query.sort,
      (row) => sortValue(row, query.sort.field),
      (course): CatalogCourseView => ({
        id: course.id,
        code: course.code,
        title: course.title,
        description: course.description,
        priceCents: course.priceCents,
        currency: course.currency,
        sections: course.sections.map((section) => ({
          id: section.id,
          name: section.name,
          term: section.term,
          instructor: section.instructor,
          capacity: section.capacity,
          seatsAvailable: seatsAvailable(section),
          startsAt: section.startsAt,
          endsAt: section.endsAt,
        })),
      }),
    );
  }

  async get(principal: Principal, id: string): Promise<CourseDetailView> {
    const { course } = await this.#loadVisible(principal, id);
    return toDetail(course);
  }

  // ─── Course commands ────────────────────────────────────────────────────────────────────────

  async create(principal: Principal, input: CourseInput): Promise<CourseDetailView> {
    const ownerId = input.ownerId ?? (principal.kind === 'user' ? principal.userId : undefined);
    if (!ownerId) {
      throw new UnprocessableError('ownerId is required when an API key creates a course.', {
        code: 'OWNER_REQUIRED',
      });
    }
    const assigningSomeoneElse = principal.kind === 'user' && ownerId !== principal.userId;
    if (assigningSomeoneElse && !principal.permissions.has('course:manage_all')) {
      throw new ForbiddenError('Only administrators can create courses for someone else.', {
        code: 'CANNOT_ASSIGN_OWNER',
      });
    }

    return this.deps.db.transaction(async (tx) => {
      await this.#assertTeacher(ownerId, 'INVALID_OWNER');
      const course = await tx.course
        .create({
          data: {
            tenantId: requireTenantId(),
            code: input.code,
            title: input.title,
            description: input.description ?? '',
            priceCents: input.priceCents ?? null,
            currency: input.currency ?? 'usd',
            ownerId,
          },
          include: detailInclude,
        })
        .catch(courseCodeTaken(input.code));
      await this.deps.audit.record({
        action: 'course.created',
        resourceType: 'course',
        resourceId: course.id,
        metadata: { code: course.code, title: course.title, ownerId },
      });
      await this.deps.outbox.emit({
        type: 'course.created',
        aggregateType: 'course',
        aggregateId: course.id,
        payload: { courseId: course.id, code: course.code, title: course.title, ownerId },
      });
      return toDetail(course);
    });
  }

  async update(
    principal: Principal,
    id: string,
    input: Partial<CourseInput>,
  ): Promise<CourseDetailView> {
    return this.deps.db.transaction(async (tx) => {
      const { course } = await this.#loadManageable(principal, id);
      if (input.ownerId !== undefined && input.ownerId !== course.ownerId) {
        if (principal.kind === 'user' && !principal.permissions.has('course:manage_all')) {
          throw new ForbiddenError('Only administrators can transfer a course.', {
            code: 'CANNOT_ASSIGN_OWNER',
          });
        }
        await this.#assertTeacher(input.ownerId, 'INVALID_OWNER');
      }

      const changes: Prisma.CourseUncheckedUpdateInput = {};
      const changed: string[] = [];
      for (const field of [
        'code',
        'title',
        'description',
        'priceCents',
        'currency',
        'ownerId',
      ] as const) {
        const value = input[field];
        if (value !== undefined && value !== course[field]) {
          Object.assign(changes, { [field]: value });
          changed.push(field);
        }
      }
      if (changed.length === 0) return toDetail(course);

      const updated = await tx.course
        .update({ where: { id }, data: changes, include: detailInclude })
        .catch(courseCodeTaken(input.code ?? course.code));
      await this.deps.audit.record({
        action: 'course.updated',
        resourceType: 'course',
        resourceId: id,
        metadata: { changed },
      });
      await this.deps.outbox.emit({
        type: 'course.updated',
        aggregateType: 'course',
        aggregateId: id,
        payload: { courseId: id, changed },
      });
      return toDetail(updated);
    });
  }

  /** draft|archived -> published, draft|published -> archived. Repeating a transition is a no-op. */
  async setStatus(
    principal: Principal,
    id: string,
    target: 'published' | 'archived',
  ): Promise<CourseDetailView> {
    return this.deps.db.transaction(async (tx) => {
      const { course } = await this.#loadManageable(principal, id);
      if (course.status === target) return toDetail(course);

      const updated = await tx.course.update({
        where: { id },
        data: { status: target },
        include: detailInclude,
      });
      const event = target === 'published' ? 'course.published' : 'course.archived';
      await this.deps.audit.record({
        action: event,
        resourceType: 'course',
        resourceId: id,
        metadata: { from: course.status, to: target },
      });
      await this.deps.outbox.emit({
        type: event,
        aggregateType: 'course',
        aggregateId: id,
        payload: { courseId: id, code: course.code, from: course.status, to: target },
      });
      return toDetail(updated);
    });
  }

  /** Only courses nobody ever enrolled in can be deleted; others are archived instead. */
  async delete(principal: Principal, id: string): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const { course } = await this.#loadVisible(principal, id);
      if (!canDeleteCourse(principal, course))
        throw new ForbiddenError('You cannot delete this course.');
      const enrollments = await tx.enrollment.count({ where: { section: { courseId: id } } });
      if (enrollments > 0) {
        throw new ConflictError('This course has enrollments. Archive it instead.', {
          code: 'COURSE_HAS_ENROLLMENTS',
        });
      }
      await tx.course.delete({ where: { id } });
      await this.deps.audit.record({
        action: 'course.deleted',
        resourceType: 'course',
        resourceId: id,
        metadata: { code: course.code, title: course.title },
      });
      await this.deps.outbox.emit({
        type: 'course.deleted',
        aggregateType: 'course',
        aggregateId: id,
        payload: { courseId: id, code: course.code },
      });
    });
  }

  // ─── Section commands ───────────────────────────────────────────────────────────────────────

  async createSection(
    principal: Principal,
    courseId: string,
    input: SectionInput,
  ): Promise<SectionView> {
    return this.deps.db.transaction(async (tx) => {
      await this.#loadManageable(principal, courseId);
      if (input.instructorId) await this.#assertTeacher(input.instructorId, 'INVALID_INSTRUCTOR');
      const section = await tx.section.create({
        data: {
          tenantId: requireTenantId(),
          courseId,
          name: input.name,
          term: input.term ?? null,
          instructorId: input.instructorId ?? null,
          capacity: input.capacity ?? null,
          startsAt: input.startsAt ?? null,
          endsAt: input.endsAt ?? null,
        },
        include: sectionInclude,
      });
      await this.deps.audit.record({
        action: 'section.created',
        resourceType: 'section',
        resourceId: section.id,
        metadata: { courseId, name: section.name },
      });
      return toSectionView(section);
    });
  }

  async updateSection(
    principal: Principal,
    sectionId: string,
    input: Partial<SectionInput>,
  ): Promise<SectionView> {
    return this.deps.db.transaction(async (tx) => {
      const section = await this.#sectionOf(sectionId);
      await this.#loadManageable(principal, section.courseId, sectionNotFound);
      if (input.instructorId) await this.#assertTeacher(input.instructorId, 'INVALID_INSTRUCTOR');
      const startsAt = input.startsAt === undefined ? section.startsAt : input.startsAt;
      const endsAt = input.endsAt === undefined ? section.endsAt : input.endsAt;
      if (startsAt && endsAt && startsAt >= endsAt) {
        throw new UnprocessableError('startsAt must be before endsAt.', {
          code: 'INVALID_SCHEDULE',
        });
      }

      // Conditional update: a concurrent enrollment cannot sneak past the new capacity.
      const capacity = input.capacity;
      const updated = await tx.section.updateMany({
        where: {
          id: sectionId,
          ...(typeof capacity === 'number' ? { enrolledCount: { lte: capacity } } : {}),
        },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.term !== undefined ? { term: input.term } : {}),
          ...(input.instructorId !== undefined ? { instructorId: input.instructorId } : {}),
          ...(capacity !== undefined ? { capacity } : {}),
          ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
          ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
        },
      });
      if (updated.count === 0) {
        throw new ConflictError('Capacity cannot be lower than the number of enrolled students.', {
          code: 'CAPACITY_BELOW_ENROLLMENT',
        });
      }
      await this.deps.audit.record({
        action: 'section.updated',
        resourceType: 'section',
        resourceId: sectionId,
        metadata: {
          courseId: section.courseId,
          changed: Object.keys(input).filter(
            (key) => input[key as keyof SectionInput] !== undefined,
          ),
        },
      });
      return toSectionView(
        await tx.section.findUniqueOrThrow({ where: { id: sectionId }, include: sectionInclude }),
      );
    });
  }

  async deleteSection(principal: Principal, sectionId: string): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const section = await this.#sectionOf(sectionId);
      await this.#loadManageable(principal, section.courseId, sectionNotFound);
      if ((await tx.enrollment.count({ where: { sectionId } })) > 0) {
        throw new ConflictError('This section has enrollments.', {
          code: 'SECTION_HAS_ENROLLMENTS',
        });
      }
      await tx.section.delete({ where: { id: sectionId } });
      await this.deps.audit.record({
        action: 'section.deleted',
        resourceType: 'section',
        resourceId: sectionId,
        metadata: { courseId: section.courseId, name: section.name },
      });
    });
  }

  // ─── Access helpers ─────────────────────────────────────────────────────────────────────────

  /** The course if the principal may see it; otherwise 404, never revealing that it exists. */
  async #loadVisible(
    principal: Principal,
    id: string,
    notFound: () => NotFoundError = courseNotFound,
  ): Promise<{ course: DetailRow; facts: CourseFacts }> {
    const course = await this.deps.db.client.course.findUnique({
      where: { id },
      include: detailInclude,
    });
    if (!course) throw notFound();
    const enrolled =
      principal.kind === 'user' &&
      (await this.deps.db.client.enrollment.count({
        where: {
          studentId: principal.userId,
          status: { in: ['active', 'completed'] },
          section: { courseId: id },
        },
      })) > 0;
    const facts: CourseFacts = {
      ownerId: course.ownerId,
      status: course.status,
      instructorIds: course.sections.flatMap((section) =>
        section.instructorId ? [section.instructorId] : [],
      ),
      enrolledStudentIds: enrolled ? [principal.userId] : [],
    };
    if (!canViewCourse(principal, facts)) throw notFound();
    return { course, facts };
  }

  /** The course if the principal may manage it: 404 when invisible, 403 when visible but not theirs. */
  async #loadManageable(
    principal: Principal,
    id: string,
    notFound: () => NotFoundError = courseNotFound,
  ) {
    const loaded = await this.#loadVisible(principal, id, notFound);
    if (!canManageCourse(principal, loaded.course)) {
      throw new ForbiddenError('Only the course owner or an administrator can change this course.');
    }
    return loaded;
  }

  async #sectionOf(sectionId: string) {
    const section = await this.deps.db.client.section.findUnique({ where: { id: sectionId } });
    if (!section) throw sectionNotFound();
    return section;
  }

  /** Owners and instructors must be active staff at this school who can manage courses. */
  async #assertTeacher(
    userId: string,
    code: 'INVALID_OWNER' | 'INVALID_INSTRUCTOR',
  ): Promise<void> {
    const user = await this.deps.db.client.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    const canTeach =
      user?.status === 'active' &&
      (await this.deps.permissions.forUser(userId)).permissions.has('course:update');
    if (!canTeach) {
      throw new UnprocessableError(
        `${code === 'INVALID_OWNER' ? 'The owner' : 'The instructor'} must be an active instructor or administrator at this school.`,
        { code },
      );
    }
  }
}

function sortValue(
  row: { code: string; title: string; createdAt: Date },
  field: CourseSortField,
): string {
  return field === 'createdAt' ? row.createdAt.toISOString() : row[field];
}

/** Turns the unique-code violation into a clear 409. */
function courseCodeTaken(code: string) {
  return (error: unknown): never => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictError(`A course with code ${code} already exists.`, {
        code: 'COURSE_CODE_TAKEN',
      });
    }
    throw error;
  };
}
