import type { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAsTenant } from '../../../src/context/request-context.js';
import type { ProblemDetails } from '../../../src/lib/errors.js';
import { AuditLogsService } from '../../../src/modules/audit/audit-logs.service.js';
import { AuditLogger } from '../../../src/modules/audit/audit.service.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { connectTestDatabases, type TestDatabases } from '../helpers/database.js';
import { as, createPublishedCourse, createSchool, type SchoolFixture } from '../helpers/school.js';

interface AuditEntryBody {
  id: string;
  action: string;
  actor: { type: string; id: string | null };
  resourceType: string;
  resourceId: string | null;
  userAgent: string | null;
  createdAt: string;
}
interface PageBody<T> {
  data: T[];
  pageInfo: { hasMore: boolean; nextCursor: string | null };
}

const problem = (response: { body: unknown }) => response.body as ProblemDetails;

async function readAll(stream: Readable): Promise<string> {
  let text = '';
  for await (const chunk of stream) text += String(chunk);
  return text;
}

/** Minimal RFC 4180 parser for assertions (quoted cells may contain commas and quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && text[index + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      index += 1;
    } else cell += char;
  }
  return rows;
}

describe('the audit log', () => {
  let dbs: TestDatabases;
  let testApp: TestApp;
  let school: SchoolFixture;

  beforeAll(async () => {
    dbs = connectTestDatabases();
    testApp = await startTestApp();
    school = await createSchool(dbs, testApp.app, 'audit');
    // A course change made from a hostile user agent, to prove exports neutralise formulas.
    await as(testApp.app, school.instructor)
      .post('/api/v1/courses')
      .set('user-agent', '=HYPERLINK("https://evil.example","click")')
      .send({ code: 'AUD-1', title: 'Audited course' })
      .expect(201);
    await createPublishedCourse(testApp.app, school.instructor);
  });

  afterAll(async () => {
    await testApp.close();
    await dbs.close();
  });

  it('lists newest first and filters by action prefix, actor and resource', async () => {
    const all = (
      await as(testApp.app, school.admin).get('/api/v1/audit-logs?limit=100').expect(200)
    ).body as PageBody<AuditEntryBody>;
    const times = all.data.map((entry) => entry.createdAt);
    expect(times.length).toBeGreaterThan(5);
    expect(times).toEqual([...times].sort().reverse());

    const logins = (
      await as(testApp.app, school.admin).get('/api/v1/audit-logs?action=auth.*').expect(200)
    ).body as PageBody<AuditEntryBody>;
    expect(logins.data.length).toBeGreaterThanOrEqual(3);
    expect(logins.data.every((entry) => entry.action.startsWith('auth.'))).toBe(true);

    const byInstructor = (
      await as(testApp.app, school.admin)
        .get(
          `/api/v1/audit-logs?actorId=${school.instructor.id}&resourceType=course&action=course.created`,
        )
        .expect(200)
    ).body as PageBody<AuditEntryBody>;
    expect(byInstructor.data).toHaveLength(2);
    expect(byInstructor.data.every((entry) => entry.actor.id === school.instructor.id)).toBe(true);
  });

  it('pages through the trail with cursors', async () => {
    const first = (
      await as(testApp.app, school.admin).get('/api/v1/audit-logs?limit=2').expect(200)
    ).body as PageBody<AuditEntryBody>;
    expect(first.pageInfo.hasMore).toBe(true);
    const second = (
      await as(testApp.app, school.admin)
        .get(`/api/v1/audit-logs?limit=2&cursor=${first.pageInfo.nextCursor ?? ''}`)
        .expect(200)
    ).body as PageBody<AuditEntryBody>;
    const firstIds = first.data.map((entry) => entry.id);
    expect(second.data).toHaveLength(2);
    expect(second.data.some((entry) => firstIds.includes(entry.id))).toBe(false);
    expect((second.data[0]?.createdAt ?? '') <= (first.data[1]?.createdAt ?? '')).toBe(true);
  });

  it('validates filters', async () => {
    await as(testApp.app, school.admin).get('/api/v1/audit-logs?action=DROP%20TABLE').expect(400);
    await as(testApp.app, school.admin)
      .get('/api/v1/audit-logs?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z')
      .expect(400);
  });

  it('is visible to administrators only', async () => {
    const response = await as(testApp.app, school.instructor).get('/api/v1/audit-logs').expect(403);
    expect(problem(response).code).toBe('PERMISSION_DENIED');
    await as(testApp.app, school.instructor).get('/api/v1/audit-logs/export').expect(403);
  });

  it('exports CSV safe to open in a spreadsheet, and audits the export itself', async () => {
    const response = await as(testApp.app, school.admin)
      .get('/api/v1/audit-logs/export?resourceType=course')
      .expect(200);

    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="audit-log-.+\.csv"$/,
    );
    expect(response.headers['x-export-truncated']).toBe('false');

    const [header, ...rows] = parseCsv(response.text);
    expect(header).toEqual([
      'created_at',
      'action',
      'actor_type',
      'actor_id',
      'resource_type',
      'resource_id',
      'ip',
      'user_agent',
      'request_id',
      'metadata',
    ]);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((row) => row[4] === 'course')).toBe(true);
    const hostile = rows.find((row) => row[7]?.includes('HYPERLINK'));
    expect(hostile?.[7]).toBe(`'=HYPERLINK("https://evil.example","click")`);
    expect(JSON.parse(hostile?.[9] ?? '{}')).toMatchObject({ code: 'AUD-1' });

    const exported = await dbs.owner.auditLog.findFirstOrThrow({
      where: { tenantId: school.id, action: 'data.exported' },
    });
    expect(exported).toMatchObject({ actorId: school.admin.id, resourceType: 'audit_log' });
    expect(exported.metadata).toEqual({
      format: 'csv',
      truncated: false,
      filters: { resourceType: 'course' },
    });
  });

  it('caps large exports at the newest rows and says so', async () => {
    const service = new AuditLogsService({
      db: dbs.db,
      audit: new AuditLogger(dbs.db),
      maxExportRows: 3,
    });

    const csv = await runAsTenant(school.id, async () => {
      const { stream, truncated } = await service.exportCsv({});
      expect(truncated).toBe(true);
      return readAll(stream);
    });

    const rows = parseCsv(csv).slice(1);
    expect(rows).toHaveLength(3);
    const newest = await dbs.owner.auditLog.findMany({
      where: { tenantId: school.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 4,
    });
    // The export's own audit row is written before the first batch, so it is the newest row.
    expect(rows[0]?.[1]).toBe('data.exported');
    expect(rows.map((row) => row[1])).toEqual(newest.slice(0, 3).map((entry) => entry.action));
  });
});
