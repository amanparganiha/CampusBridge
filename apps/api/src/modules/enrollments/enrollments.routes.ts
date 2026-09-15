import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requirePrincipal } from '../../auth/authenticate.js';
import { sortQuerySchema } from '../../lib/keyset.js';
import { pageSchema, paginationQuerySchema } from '../../lib/pagination.js';
import {
  ENROLLMENT_SORT_FIELDS,
  type EnrollmentsService,
  type EnrollmentView,
} from './enrollments.service.js';

export interface EnrollmentRoutesOptions {
  enrollments: EnrollmentsService;
}

const enrollmentStatus = z.enum(['pending_payment', 'active', 'dropped', 'completed']);

export const enrollmentSchema = z.object({
  id: z.uuid(),
  status: enrollmentStatus,
  source: z.enum(['admin', 'self', 'payment', 'sync']),
  student: z.object({ id: z.uuid(), name: z.string(), email: z.string() }),
  section: z.object({ id: z.uuid(), name: z.string(), term: z.string().nullable() }),
  course: z.object({ id: z.uuid(), code: z.string(), title: z.string() }),
  completedAt: z.iso.datetime().nullable(),
  droppedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const toEnrollment = (enrollment: EnrollmentView) => ({
  ...enrollment,
  completedAt: enrollment.completedAt?.toISOString() ?? null,
  droppedAt: enrollment.droppedAt?.toISOString() ?? null,
  createdAt: enrollment.createdAt.toISOString(),
  updatedAt: enrollment.updatedAt.toISOString(),
});

const idParams = z.object({ id: z.uuid() });

export const enrollmentRoutes: FastifyPluginAsyncZod<EnrollmentRoutesOptions> = async (
  app,
  { enrollments },
) => {
  const tags = ['enrollments'];

  app.get(
    '/',
    {
      config: { permissions: ['enrollment:read'] },
      schema: {
        tags,
        summary: 'Your enrollments, or those in sections you teach (all for administrators)',
        querystring: paginationQuerySchema.extend({
          sort: sortQuerySchema(ENROLLMENT_SORT_FIELDS, '-createdAt'),
          sectionId: z.uuid().optional(),
          courseId: z.uuid().optional(),
          studentId: z.uuid().optional(),
          status: enrollmentStatus.optional(),
        }),
        response: { 200: pageSchema(enrollmentSchema) },
      },
    },
    async (request) => {
      const page = await enrollments.list(requirePrincipal(request), request.query);
      return { data: page.data.map(toEnrollment), pageInfo: page.pageInfo };
    },
  );

  app.post(
    '/',
    {
      config: { anyPermission: ['enrollment:self', 'enrollment:manage'], idempotent: true },
      schema: {
        tags,
        summary: 'Enroll yourself, or a student, in a section',
        description:
          'Omit studentId to enroll yourself in a free, published course (when the school allows ' +
          'self-enrollment). Staff who teach the section may enroll any active student. Seats are ' +
          'claimed atomically: a full section returns 409 SECTION_FULL. Supports Idempotency-Key.',
        body: z.object({ sectionId: z.uuid(), studentId: z.uuid().optional() }),
        response: { 201: enrollmentSchema },
      },
    },
    async (request, reply) => {
      const enrollment = await enrollments.enroll(requirePrincipal(request), request.body);
      return reply.status(201).send(toEnrollment(enrollment));
    },
  );

  app.get(
    '/:id',
    {
      config: { permissions: ['enrollment:read'] },
      schema: {
        tags,
        summary: 'Get an enrollment',
        params: idParams,
        response: { 200: enrollmentSchema },
      },
    },
    async (request) =>
      toEnrollment(await enrollments.get(requirePrincipal(request), request.params.id)),
  );

  app.patch(
    '/:id',
    {
      config: { anyPermission: ['enrollment:self', 'enrollment:manage'] },
      schema: {
        tags,
        summary: 'Drop, complete or reinstate an enrollment',
        description:
          'Students may drop their own enrollment. Staff who teach the section may also mark it ' +
          'completed or reinstate it (which needs a free seat). A pending payment can only be ' +
          'activated by the payment itself.',
        params: idParams,
        body: z.object({ status: z.enum(['active', 'dropped', 'completed']) }),
        response: { 200: enrollmentSchema },
      },
    },
    async (request) =>
      toEnrollment(
        await enrollments.changeStatus(
          requirePrincipal(request),
          request.params.id,
          request.body.status,
        ),
      ),
  );
};
