import { bootstrap } from './worker-main';

describe('worker-main bootstrap', () => {
  it('initializes an ApplicationContext without opening an HTTP port', async () => {
    const app = await bootstrap();

    expect(app).toBeDefined();
    // ApplicationContext (unlike a full INestApplication) has no
    // `getHttpServer`/`listen` surface — its absence is the concrete proof
    // that no HTTP port was opened.
    expect((app as unknown as { listen?: unknown }).listen).toBeUndefined();

    await app.close();
  }, 30000);
});
