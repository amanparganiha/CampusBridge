import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requirePrincipal } from '../../auth/authenticate.js';
import { sortQuerySchema } from '../../lib/keyset.js';
import { pageSchema, paginationQuerySchema } from '../../lib/pagination.js';
import {
  COURSE_SORT_FIELDS,
  type CatalogCourseView,
  type CourseDetailView,
  type CoursesService,
  type CourseSummaryView,
  type SectionView,
} from './courses.service.js';

export interface CourseRoutesOptions {
  courses: CoursesService;
}

// ─── Schemas ───────────────────────────────────────────────────────────────────────────────────

/** Catalog codes are upper-case: "cs 101" is stored as "CS-101". Mirrors courses_code_format. */
const courseCode = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase().replace(/\s+/g, '-'))
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,31}$/, 'Use letters, digits and hyphens (max 32).'));

const personSchema = z.object({ id: z.uuid(), name: z.string() });
const iso = z.iso.datetime();

const sectionSchema = z.object({
  id: z.uuid(),
  courseId: z.uuid(),
  name: z.string(),
  term: z.string().nullable(),
  instructor: personSchema.nullable(),
  capacity: z.number().int().nullable(),
  enrolledCount: z.number().int(),
  seatsAvailable: z.number().int().nullable(),
  startsAt: iso.nullable(),
  endsAt: iso.nullable(),
});

const courseSummarySchema = z.object({
  id: z.uuid(),
  code: z.string(),
  title: z.string(),
  status: z.enum(['draft', 'published', 'archived']),
  priceCents: z.number().int().nullable(),
  currency: z.string(),
  owner: personSchema,
  sectionCount: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
});

const courseDetailSchema = courseSummarySchema.omit({ sectionCount: true }).extend({
  description: z.string(),
  summary: z.string().nullable(),
  sections: z.array(sectionSchema),
});

const catalogCourseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  title: z.string(),
  description: z.string(),
  priceCents: z.number().int().nullable(),
  currency: z.string(),
  sections: z.array(sectionSchema.omit({ courseId: true, enrolledCount: true })),
});

const courseBody = z.object({
  code: courseCode,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).optional(),
  priceCents: z
    .number()
    .int()
    .min(0)
    .max(100_000_00)
    .nullable()
    .optional()
    .describe('Null or 0 means free.'),
  currency: z
    .string()
    .regex(/^[a-zA-Z]{3}$/)
    .transform((value) => value.toLowerCase())
    .optional(),
  ownerId: z
    .uuid()
    .optional()
    .describe('Defaults to you. Administrators may assign another instructor.'),
});

const sectionFields = {
  name: z.string().trim().min(1).max(120),
  term: z.string().trim().max(60).nullable().optional(),
  instructorId: z.uuid().nullable().optional(),
  capacity: z
    .number()
    .int()
    .min(1)
    .max(100_000)
    .nullable()
    .optional()
    .describe('Null means unlimited.'),
  startsAt: z.iso.datetime().nullable().optional(),
  endsAt: z.iso.datetime().nullable().optional(),
};

const toDate = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null ? null : new Date(value);

// ─── Serialisers ───────────────────────────────────────────────────────────────────────────────

const isoOrNull = (value: Date | null) => value?.toISOString() ?? null;

export const toSectionResponse = (section: SectionView) => ({
  ...section,
  startsAt: isoOrNull(section.startsAt),
  endsAt: isoOrNull(section.endsAt),
});

const toSummaryResponse = (course: CourseSummaryView) => ({
  ...course,
  createdAt: course.createdAt.toISOString(),
  updatedAt: course.updatedAt.toISOString(),
});

const toDetailResponse = (course: CourseDetailView) => ({
  ...course,
  sections: course.sections.map(toSectionResponse),
  createdAt: course.createdAt.toISOString(),
  updatedAt: course.updatedAt.toISOString(),
});

const toCatalogResponse = (course: CatalogCourseView) => ({
  ...course,
  sections: course.sections.map((section) => ({
    ...section,
    startsAt: isoOrNull(section.startsAt),
    endsAt: isoOrNull(section.endsAt),
  })),
});

// ─── Routes ────────────────────────────────────────────────────────────────────────────────────

const idParams = z.object({ id: z.uuid() });

export const courseRoutes: FastifyPluginAsyncZod<CourseRoutesOptions> = async (
  app,
  { courses },
) => {
  const tags = ['courses'];
  const listQuery = paginationQuerySchema.extend({
    sort: sortQuerySchema(COURSE_SORT_FIELDS, 'code'),
    q: z.string().trim().min(1).max(100).optional(),
  });

  app.get(
    '/',
    {
      config: { permissions: ['course:read'] },
      schema: {
        tags,
        summary: 'Courses you own, teach or are enrolled in (all courses for administrators)',
        querystring: listQuery.extend({
          status: z.enum(['draft', 'published', 'archived']).optional(),
          ownerId: z.uuid().optional(),
        }),
        response: { 200: pageSchema(courseSummarySchema) },
      },
    },
    async (request) => {
      const page = await courses.list(requirePrincipal(request), request.query);
      return { data: page.data.map(toSummaryResponse), pageInfo: page.pageInfo };
    },
  );

  app.post(
    '/',
    {
      config: { permissions: ['course:create'] },
      schema: {
        tags,
        summary: 'Create a draft course',
        body: courseBody,
        response: { 201: courseDetailSchema },
      },
    },
    async (request, reply) => {
      const course = await courses.create(requirePrincipal(request), request.body);
      return reply.status(201).send(toDetailResponse(course));
    },
  );

  app.get(
    '/:id',
    {
      config: { permissions: ['course:read'] },
      schema: {
        tags,
        summary: 'Get a course with its sections',
        params: idParams,
        response: { 200: courseDetailSchema },
      },
    },
    async (request) =>
      toDetailResponse(await courses.get(requirePrincipal(request), request.params.id)),
  );

  app.patch(
    '/:id',
    {
      config: { permissions: ['course:update'] },
      schema: {
        tags,
        summary: 'Update a course (owner or administrator)',
        params: idParams,
        body: courseBody.partial(),
        response: { 200: courseDetailSchema },
      },
    },
    async (request) =>
      toDetailResponse(
        await courses.update(requirePrincipal(request), request.params.id, request.body),
      ),
  );

  for (const [action, status] of [
    ['publish', 'published'],
    ['archive', 'archived'],
  ] as const) {
    app.post(
      `/:id/${action}`,
      {
        config: { permissions: ['course:update'] },
        schema: {
          tags,
          summary:
            action === 'publish' ? 'Publish a course (visible in the catalog)' : 'Archive a course',
          params: idParams,
          response: { 200: courseDetailSchema },
        },
      },
      async (request) =>
        toDetailResponse(
          await courses.setStatus(requirePrincipal(request), request.params.id, status),
        ),
    );
  }

  app.delete(
    '/:id',
    {
      config: { permissions: ['course:delete'] },
      schema: {
        tags,
        summary: 'Delete a course that never had enrollments',
        params: idParams,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await courses.delete(requirePrincipal(request), request.params.id);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/:id/sections',
    {
      config: { permissions: ['course:update'] },
      schema: {
        tags,
        summary: 'Add a section (term, instructor, capacity) to a course',
        params: idParams,
        body: z
          .object(sectionFields)
          .refine((body) => !body.startsAt || !body.endsAt || body.startsAt < body.endsAt, {
            message: 'startsAt must be before endsAt.',
            path: ['endsAt'],
          }),
        response: { 201: sectionSchema },
      },
    },
    async (request, reply) => {
      const { startsAt, endsAt, ...rest } = request.body;
      const section = await courses.createSection(requirePrincipal(request), request.params.id, {
        ...rest,
        startsAt: toDate(startsAt),
        endsAt: toDate(endsAt),
      });
      return reply.status(201).send(toSectionResponse(section));
    },
  );
};

export const sectionRoutes: FastifyPluginAsyncZod<CourseRoutesOptions> = async (
  app,
  { courses },
) => {
  const tags = ['courses'];

  app.patch(
    '/:id',
    {
      config: { permissions: ['course:update'] },
      schema: {
        tags,
        summary: 'Update a section',
        params: idParams,
        body: z.object(sectionFields).partial(),
        response: { 200: sectionSchema },
      },
    },
    async (request) => {
      const { startsAt, endsAt, ...rest } = request.body;
      const section = await courses.updateSection(requirePrincipal(request), request.params.id, {
        ...rest,
        startsAt: toDate(startsAt),
        endsAt: toDate(endsAt),
      });
      return toSectionResponse(section);
    },
  );

  app.delete(
    '/:id',
    {
      config: { permissions: ['course:update'] },
      schema: {
        tags,
        summary: 'Delete a section without enrollments',
        params: idParams,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await courses.deleteSection(requirePrincipal(request), request.params.id);
      return reply.status(204).send(null);
    },
  );
};

export const catalogRoutes: FastifyPluginAsyncZod<CourseRoutesOptions> = async (
  app,
  { courses },
) => {
  app.get(
    '/',
    {
      config: { permissions: ['course:read'] },
      schema: {
        tags: ['courses'],
        summary: 'Published courses and their open seats (for self-enrollment)',
        querystring: paginationQuerySchema.extend({
          sort: sortQuerySchema(COURSE_SORT_FIELDS, 'code'),
          q: z.string().trim().min(1).max(100).optional(),
        }),
        response: { 200: pageSchema(catalogCourseSchema) },
      },
    },
    async (request) => {
      const page = await courses.catalog(request.query);
      return { data: page.data.map(toCatalogResponse), pageInfo: page.pageInfo };
    },
  );
};
