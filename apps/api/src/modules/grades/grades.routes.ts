import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requirePrincipal } from '../../auth/authenticate.js';
import type { GradesService, GradeView } from './grades.service.js';

export interface GradeRoutesOptions {
  grades: GradesService;
}

/** Up to 99999.99, with at most two decimal places (the column is numeric(7, 2)). */
const points = z
  .number()
  .min(0)
  .max(99_999.99)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6,
    'Use at most two decimal places.',
  );

const gradeSchema = z.object({
  id: z.uuid(),
  enrollmentId: z.uuid(),
  title: z.string(),
  score: z.number(),
  maxScore: z.number(),
  feedback: z.string().nullable(),
  gradedById: z.uuid().nullable(),
  gradedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const gradeFields = {
  title: z.string().trim().min(1).max(200),
  score: points,
  maxScore: points.refine((value) => value > 0, 'maxScore must be greater than 0.'),
  feedback: z.string().max(5_000).nullable().optional(),
};

const toGrade = (grade: GradeView) => ({
  ...grade,
  gradedAt: grade.gradedAt.toISOString(),
  createdAt: grade.createdAt.toISOString(),
  updatedAt: grade.updatedAt.toISOString(),
});

const idParams = z.object({ id: z.uuid() });
const tags = ['grades'];

/** Registered under /enrollments: the grades of one enrollment. */
export const enrollmentGradeRoutes: FastifyPluginAsyncZod<GradeRoutesOptions> = async (
  app,
  { grades },
) => {
  app.get(
    '/:id/grades',
    {
      config: { permissions: ['grade:read'] },
      schema: {
        tags,
        summary: "An enrollment's grades and running total",
        params: idParams,
        response: {
          200: z.object({
            data: z.array(gradeSchema),
            summary: z.object({
              count: z.number().int(),
              totalScore: z.number(),
              totalMaxScore: z.number(),
              percentage: z.number().nullable(),
            }),
          }),
        },
      },
    },
    async (request) => {
      const result = await grades.list(requirePrincipal(request), request.params.id);
      return { data: result.data.map(toGrade), summary: result.summary };
    },
  );

  app.post(
    '/:id/grades',
    {
      config: { permissions: ['grade:write'], idempotent: true },
      schema: {
        tags,
        summary: 'Record a grade (staff who teach the section)',
        description: 'Supports the Idempotency-Key header.',
        params: idParams,
        body: z.object(gradeFields).refine((body) => body.score <= body.maxScore, {
          message: 'score cannot exceed maxScore.',
          path: ['score'],
        }),
        response: { 201: gradeSchema },
      },
    },
    async (request, reply) => {
      const grade = await grades.record(requirePrincipal(request), request.params.id, request.body);
      return reply.status(201).send(toGrade(grade));
    },
  );
};

/** Registered under /grades: one grade by id. */
export const gradeRoutes: FastifyPluginAsyncZod<GradeRoutesOptions> = async (app, { grades }) => {
  app.patch(
    '/:id',
    {
      config: { permissions: ['grade:write'] },
      schema: {
        tags,
        summary: 'Correct a grade',
        params: idParams,
        body: z
          .object(gradeFields)
          .partial()
          .refine((body) => Object.keys(body).length > 0, 'Nothing to update.'),
        response: { 200: gradeSchema },
      },
    },
    async (request) =>
      toGrade(await grades.update(requirePrincipal(request), request.params.id, request.body)),
  );

  app.delete(
    '/:id',
    {
      config: { permissions: ['grade:write'] },
      schema: { tags, summary: 'Delete a grade', params: idParams, response: { 204: z.null() } },
    },
    async (request, reply) => {
      await grades.delete(requirePrincipal(request), request.params.id);
      return reply.status(204).send(null);
    },
  );
};
