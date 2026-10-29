import { Test } from '@nestjs/testing';
import { WorkerModule } from './worker.module';
import { VideoProcessingConsumer } from '../videos/video-processing.consumer';

describe('WorkerModule', () => {
  it('should compile standalone, without any HTTP/API modules', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module).toBeDefined();

    const consumer = module.get(VideoProcessingConsumer);
    expect(consumer).toBeInstanceOf(VideoProcessingConsumer);

    await module.close();
  }, 30000);

  it('declares no HTTP controllers in its @Module metadata', () => {
    // The @Module({...}) decorator only sets a 'controllers' metadata key
    // when the options object includes one. WorkerModule's definition has
    // no `controllers:` entry, so this key must be entirely absent — the
    // concrete check that this module is isolated from the HTTP layer.
    expect(Reflect.getMetadata('controllers', WorkerModule)).toBeUndefined();
  });
});
