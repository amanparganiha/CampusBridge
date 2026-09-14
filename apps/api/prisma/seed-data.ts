/**
 * Demo data for local development and the README walkthrough. Deterministic and hand-written,
 * so screenshots, docs and tests can refer to the same people and courses.
 * Every account's password is DEMO_PASSWORD.
 */

export const DEMO_PASSWORD = 'Password123!';

export interface SeedCourse {
  code: string;
  title: string;
  description: string;
  status: 'draft' | 'published' | 'archived';
  priceCents?: number;
  ownerEmail: string;
  sections: {
    name: string;
    term: string;
    capacity: number;
    instructorEmail: string;
    /** Students enrolled in this section, with optional grades. */
    enrollments: {
      studentEmail: string;
      grades?: { title: string; score: number; maxScore: number; feedback?: string }[];
    }[];
  }[];
}

export interface SeedTenant {
  slug: string;
  name: string;
  settings: {
    branding: { displayName: string; primaryColor: string };
    features: Record<string, boolean>;
  };
  admin: { email: string; name: string };
  instructors: { email: string; name: string }[];
  students: { email: string; name: string }[];
  courses: SeedCourse[];
}

export const SEED_TENANTS: SeedTenant[] = [
  {
    slug: 'lincoln',
    name: 'Lincoln High School',
    settings: {
      branding: { displayName: 'Lincoln High', primaryColor: '#1d4ed8' },
      features: { selfEnrollment: true, payments: true, ai: true },
    },
    admin: { email: 'admin@lincoln.test', name: 'Lincoln Administrator' },
    instructors: [
      { email: 'maya.patel@lincoln.test', name: 'Maya Patel' },
      { email: 'david.okafor@lincoln.test', name: 'David Okafor' },
    ],
    students: [
      { email: 'jordan.lee@lincoln.test', name: 'Jordan Lee' },
      { email: 'priya.shah@lincoln.test', name: 'Priya Shah' },
      { email: 'marcus.brown@lincoln.test', name: 'Marcus Brown' },
      { email: 'sofia.garcia@lincoln.test', name: 'Sofia Garcia' },
      { email: 'ethan.nguyen@lincoln.test', name: 'Ethan Nguyen' },
      { email: 'amara.okeke@lincoln.test', name: 'Amara Okeke' },
    ],
    courses: [
      {
        code: 'ALG-1',
        title: 'Algebra I',
        description: 'Linear equations, inequalities, functions and graphing.',
        status: 'published',
        ownerEmail: 'maya.patel@lincoln.test',
        sections: [
          {
            name: 'Period 2',
            term: 'Fall 2026',
            capacity: 30,
            instructorEmail: 'maya.patel@lincoln.test',
            enrollments: [
              {
                studentEmail: 'jordan.lee@lincoln.test',
                grades: [
                  {
                    title: 'Unit 1 quiz',
                    score: 18,
                    maxScore: 20,
                    feedback: 'Strong work on slope.',
                  },
                ],
              },
              {
                studentEmail: 'priya.shah@lincoln.test',
                grades: [{ title: 'Unit 1 quiz', score: 20, maxScore: 20 }],
              },
              {
                studentEmail: 'marcus.brown@lincoln.test',
                grades: [{ title: 'Unit 1 quiz', score: 14, maxScore: 20 }],
              },
              { studentEmail: 'sofia.garcia@lincoln.test' },
            ],
          },
        ],
      },
      {
        code: 'BIO-1',
        title: 'Biology',
        description: 'Cells, genetics, evolution and ecosystems, with weekly labs.',
        status: 'published',
        ownerEmail: 'david.okafor@lincoln.test',
        sections: [
          {
            name: 'Period 4',
            term: 'Fall 2026',
            capacity: 28,
            instructorEmail: 'david.okafor@lincoln.test',
            enrollments: [
              {
                studentEmail: 'ethan.nguyen@lincoln.test',
                grades: [{ title: 'Lab report 1', score: 45, maxScore: 50 }],
              },
              {
                studentEmail: 'amara.okeke@lincoln.test',
                grades: [{ title: 'Lab report 1', score: 48, maxScore: 50 }],
              },
              { studentEmail: 'jordan.lee@lincoln.test' },
            ],
          },
        ],
      },
      {
        code: 'CS-101',
        title: 'Intro to Programming (Summer Camp)',
        description: 'A two-week Python camp. Paid enrollment.',
        status: 'published',
        priceCents: 4900,
        ownerEmail: 'maya.patel@lincoln.test',
        sections: [
          {
            name: 'Camp A',
            term: 'Summer 2026',
            capacity: 20,
            instructorEmail: 'maya.patel@lincoln.test',
            enrollments: [],
          },
        ],
      },
      {
        code: 'ART-2',
        title: 'Digital Art',
        description: 'Illustration and design fundamentals. Draft, not yet visible to students.',
        status: 'draft',
        ownerEmail: 'david.okafor@lincoln.test',
        sections: [],
      },
    ],
  },
  {
    slug: 'riverside',
    name: 'Riverside University',
    settings: {
      branding: { displayName: 'Riverside University', primaryColor: '#047857' },
      features: { selfEnrollment: true, payments: true, ai: false },
    },
    admin: { email: 'admin@riverside.test', name: 'Riverside Administrator' },
    instructors: [
      { email: 'sam.rivera@riverside.test', name: 'Sam Rivera' },
      { email: 'grace.kim@riverside.test', name: 'Grace Kim' },
    ],
    students: [
      { email: 'alex.chen@riverside.test', name: 'Alex Chen' },
      { email: 'noah.williams@riverside.test', name: 'Noah Williams' },
      { email: 'olivia.martin@riverside.test', name: 'Olivia Martin' },
      { email: 'liam.johnson@riverside.test', name: 'Liam Johnson' },
    ],
    courses: [
      {
        code: 'CS-201',
        title: 'Data Structures',
        description: 'Lists, trees, graphs and complexity analysis.',
        status: 'published',
        priceCents: 19900,
        ownerEmail: 'sam.rivera@riverside.test',
        sections: [
          {
            name: 'Lecture 001',
            term: 'Fall 2026',
            capacity: 120,
            instructorEmail: 'sam.rivera@riverside.test',
            enrollments: [
              {
                studentEmail: 'alex.chen@riverside.test',
                grades: [{ title: 'Problem set 1', score: 92, maxScore: 100 }],
              },
              {
                studentEmail: 'noah.williams@riverside.test',
                grades: [{ title: 'Problem set 1', score: 78, maxScore: 100 }],
              },
            ],
          },
        ],
      },
      {
        code: 'HIST-110',
        title: 'World History',
        description: 'Global history from 1500 to the present.',
        status: 'published',
        ownerEmail: 'grace.kim@riverside.test',
        sections: [
          {
            name: 'Seminar A',
            term: 'Fall 2026',
            capacity: 25,
            instructorEmail: 'grace.kim@riverside.test',
            enrollments: [
              { studentEmail: 'olivia.martin@riverside.test' },
              { studentEmail: 'liam.johnson@riverside.test' },
              { studentEmail: 'alex.chen@riverside.test' },
            ],
          },
        ],
      },
      {
        code: 'MATH-240',
        title: 'Linear Algebra',
        description: 'Vector spaces, linear maps, eigenvalues.',
        status: 'published',
        ownerEmail: 'sam.rivera@riverside.test',
        sections: [
          {
            name: 'Lecture 001',
            term: 'Spring 2027',
            capacity: 80,
            instructorEmail: 'sam.rivera@riverside.test',
            enrollments: [],
          },
        ],
      },
    ],
  },
];
