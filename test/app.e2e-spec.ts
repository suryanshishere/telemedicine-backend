import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { ConsultationStatus, Role } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import request from 'supertest';
import { CryptoService } from '../src/common/services/crypto.service';
import { PrismaService } from '../src/database/prisma.service';

const enabled = process.env.RUN_E2E === 'true';
const describeWithDependencies = enabled ? describe : describe.skip;

describeWithDependencies('application smoke (PostgreSQL + Redis)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let crypto: CryptoService;

  beforeAll(async () => {
    const required = [
      'DATABASE_URL',
      'REDIS_URL',
      'JWT_SECRET',
      'FIELD_ENCRYPTION_KEYS',
      'ACTIVE_FIELD_KEY_ID',
    ];
    const missing = required.filter((name) => !process.env[name]);
    if (missing.length) {
      throw new Error(`RUN_E2E=true requires: ${missing.join(', ')}`);
    }

    process.env.NODE_ENV = 'test';
    process.env.SKIP_DATABASE_CONNECT = 'false';
    process.env.SKIP_REDIS_CONNECT = 'false';

    const [{ AppModule }, { buildOpenApi, configureApplication }] = await Promise.all([
      import('../src/app.module'),
      import('../src/bootstrap'),
    ]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const expressApp = moduleRef.createNestApplication<NestExpressApplication>();
    configureApplication(expressApp);
    SwaggerModule.setup('docs', expressApp, buildOpenApi(expressApp), {
      jsonDocumentUrl: 'docs/openapi.json',
    });
    await expressApp.init();
    app = expressApp;
    prisma = app.get(PrismaService);
    crypto = app.get(CryptoService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('reports liveness and real dependency readiness', async () => {
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('ok');
        expect(new Date(body.timestamp).toString()).not.toBe('Invalid Date');
      });

    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual(
          expect.objectContaining({
            status: 'ready',
            checks: { database: true, redis: true },
          }),
        );
      });
  });

  it('publishes OpenAPI and protects a clinical route', async () => {
    await request(app.getHttpServer())
      .get('/docs/openapi.json')
      .expect(200)
      .expect(({ body }) => {
        expect(body.info.title).toBe('Amrutam Telemedicine API');
        expect(body.paths['/v1/bookings']).toBeDefined();
      });

    await request(app.getHttpServer()).get('/v1/consultations').expect(401);
  });

  it('executes the secured booking-to-prescription workflow with scoping and replay', async () => {
    const runId = randomUUID().slice(0, 8);
    const password = 'Correct-Horse-42!';
    const adminEmail = `admin-${runId}@example.test`;
    const doctorEmail = `doctor-${runId}@example.test`;
    const patientEmail = `patient-${runId}@example.test`;
    const otherPatientEmail = `other-${runId}@example.test`;
    const adminSecret = authenticator.generateSecret();

    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await argon2.hash(password, {
          type: argon2.argon2id,
          memoryCost: 19_456,
          timeCost: 2,
          parallelism: 1,
        }),
        role: Role.ADMIN,
        mfaEnabled: true,
        mfaSecretEncrypted: crypto.encrypt(adminSecret),
        profile: { create: { fullName: 'E2E Administrator' } },
      },
    });

    const adminLogin = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: adminEmail, password, totpCode: authenticator.generate(adminSecret) })
      .expect(200);
    const adminToken = adminLogin.body.accessToken as string;

    const doctorRegistration = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({
        email: doctorEmail,
        password,
        fullName: 'E2E Doctor',
        role: Role.DOCTOR,
        specialization: 'Ayurveda',
        licenseNumber: `MED-${runId}`,
        consultationFeeCents: 15_000,
      })
      .expect(201);
    const doctorId = doctorRegistration.body.doctor.id as string;

    const doctorLogin = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: doctorEmail, password })
      .expect(200);
    const doctorPreMfaToken = doctorLogin.body.accessToken as string;

    const mfaSetup = await request(app.getHttpServer())
      .post('/v1/auth/mfa/setup')
      .set('Authorization', `Bearer ${doctorPreMfaToken}`)
      .expect(200);
    const doctorSecret = mfaSetup.body.secret as string;
    const mfaVerification = await request(app.getHttpServer())
      .post('/v1/auth/mfa/verify')
      .set('Authorization', `Bearer ${doctorPreMfaToken}`)
      .send({ code: authenticator.generate(doctorSecret) })
      .expect(200);
    const doctorToken = mfaVerification.body.accessToken as string;

    await request(app.getHttpServer())
      .patch(`/v1/admin/doctors/${doctorId}/activation`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: true })
      .expect(200)
      .expect(({ body }) => expect(body.active).toBe(true));

    const startsAt = new Date(Date.now() + 10 * 60_000);
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const availabilityBody = { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
    const availabilityKey = `availability-${runId}`;
    const availability = await request(app.getHttpServer())
      .post('/v1/doctors/me/availability')
      .set('Authorization', `Bearer ${doctorToken}`)
      .set('Idempotency-Key', availabilityKey)
      .send(availabilityBody)
      .expect(201)
      .expect('Idempotency-Replayed', 'false');
    const slotId = availability.body.id as string;

    await request(app.getHttpServer())
      .post('/v1/doctors/me/availability')
      .set('Authorization', `Bearer ${doctorToken}`)
      .set('Idempotency-Key', availabilityKey)
      .send(availabilityBody)
      .expect(201)
      .expect('Idempotency-Replayed', 'true')
      .expect(({ body }) => expect(body.id).toBe(slotId));

    await request(app.getHttpServer())
      .get('/v1/doctors')
      .query({ specialization: 'Ayurveda' })
      .expect(200)
      .expect(({ body }) => {
        expect(body.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: doctorId, fullName: 'E2E Doctor' }),
          ]),
        );
      });

    const patientRegistration = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: patientEmail, password, fullName: 'E2E Patient', role: Role.PATIENT })
      .expect(201);
    const patientId = patientRegistration.body.id as string;
    const patientLogin = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: patientEmail, password })
      .expect(200);
    const patientToken = patientLogin.body.accessToken as string;

    await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({
        email: otherPatientEmail,
        password,
        fullName: 'E2E Other Patient',
        role: Role.PATIENT,
      })
      .expect(201);
    const otherPatientLogin = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: otherPatientEmail, password })
      .expect(200);
    const otherPatientToken = otherPatientLogin.body.accessToken as string;

    const bookingBody = { slotId, reason: 'Recurring migraine and nausea' };
    const bookingKey = `booking-${runId}`;
    const booking = await request(app.getHttpServer())
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${patientToken}`)
      .set('Idempotency-Key', bookingKey)
      .send(bookingBody)
      .expect(201)
      .expect('Idempotency-Replayed', 'false');
    const consultationId = booking.body.id as string;
    expect(booking.body).toEqual(
      expect.objectContaining({
        id: consultationId,
        patientId,
        doctorId,
        status: ConsultationStatus.SCHEDULED,
        version: 1,
      }),
    );

    await request(app.getHttpServer())
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${patientToken}`)
      .set('Idempotency-Key', bookingKey)
      .send(bookingBody)
      .expect(201)
      .expect('Idempotency-Replayed', 'true')
      .expect(({ body }) => expect(body.id).toBe(consultationId));

    await request(app.getHttpServer())
      .get(`/v1/consultations/${consultationId}`)
      .set('Authorization', `Bearer ${otherPatientToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/v1/consultations/${consultationId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .get('/v1/consultations')
      .set('Authorization', `Bearer ${doctorToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.items).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: consultationId })]),
        );
      });

    const inProgress = await request(app.getHttpServer())
      .patch(`/v1/consultations/${consultationId}/status`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({
        status: ConsultationStatus.IN_PROGRESS,
        expectedVersion: 1,
        clinicalNotes: 'Hydration advised; monitor symptoms.',
      })
      .expect(200);
    expect(inProgress.body).toEqual(
      expect.objectContaining({ status: ConsultationStatus.IN_PROGRESS, version: 2 }),
    );

    const prescriptionBody = {
      medications: [
        {
          name: 'Herbal formulation',
          dosage: '1 tablet',
          frequency: 'twice daily',
          duration: '5 days',
        },
      ],
      instructions: 'Take after meals.',
    };
    const prescriptionKey = `prescription-${runId}`;
    const prescription = await request(app.getHttpServer())
      .post(`/v1/consultations/${consultationId}/prescriptions`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .set('Idempotency-Key', prescriptionKey)
      .send(prescriptionBody)
      .expect(201)
      .expect('Idempotency-Replayed', 'false');
    const prescriptionId = prescription.body.id as string;

    await request(app.getHttpServer())
      .post(`/v1/consultations/${consultationId}/prescriptions`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .set('Idempotency-Key', prescriptionKey)
      .send(prescriptionBody)
      .expect(201)
      .expect('Idempotency-Replayed', 'true')
      .expect(({ body }) => expect(body.id).toBe(prescriptionId));

    await request(app.getHttpServer())
      .patch(`/v1/consultations/${consultationId}/status`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ status: ConsultationStatus.COMPLETED, expectedVersion: 2 })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual(
          expect.objectContaining({ status: ConsultationStatus.COMPLETED, version: 3 }),
        );
      });

    await request(app.getHttpServer())
      .get(`/v1/consultations/${consultationId}`)
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual(
          expect.objectContaining({
            id: consultationId,
            reason: bookingBody.reason,
            clinicalNotes: 'Hydration advised; monitor symptoms.',
            status: ConsultationStatus.COMPLETED,
            prescription: expect.objectContaining({
              id: prescriptionId,
              medications: prescriptionBody.medications,
              instructions: prescriptionBody.instructions,
            }),
          }),
        );
      });
  }, 60_000);
});
