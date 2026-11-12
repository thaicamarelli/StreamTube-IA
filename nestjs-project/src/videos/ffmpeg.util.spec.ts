import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { extractDurationSeconds, generateThumbnail } from './ffmpeg.util';

jest.mock('node:child_process');

const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

function mockSpawnOnce(behavior: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  spawnError?: Error;
}): FakeChildProcess {
  const fake = new FakeChildProcess();
  mockedSpawn.mockReturnValueOnce(fake as any);

  // Deferred so the caller can attach listeners (as the real implementation
  // does) before any event fires.
  queueMicrotask(() => {
    if (behavior.spawnError) {
      fake.emit('error', behavior.spawnError);
      return;
    }
    if (behavior.stdout) {
      fake.stdout.emit('data', Buffer.from(behavior.stdout));
    }
    if (behavior.stderr) {
      fake.stderr.emit('data', Buffer.from(behavior.stderr));
    }
    fake.emit('close', behavior.exitCode ?? 0);
  });

  return fake;
}

describe('ffmpeg.util', () => {
  afterEach(() => {
    mockedSpawn.mockReset();
  });

  describe('extractDurationSeconds', () => {
    it('parses and rounds format.duration from ffprobe JSON output', async () => {
      mockSpawnOnce({
        stdout: JSON.stringify({ format: { duration: '12.345000' } }),
      });

      const result = await extractDurationSeconds('/tmp/source');

      expect(result).toBe(12);
      expect(mockedSpawn).toHaveBeenCalledWith('ffprobe', [
        '-print_format',
        'json',
        '-show_format',
        '/tmp/source',
      ]);
    });

    it('throws when ffprobe output is not valid JSON', async () => {
      mockSpawnOnce({ stdout: 'not json at all' });

      await expect(extractDurationSeconds('/tmp/source')).rejects.toThrow(
        'not valid JSON',
      );
    });

    it('throws when format.duration is missing', async () => {
      mockSpawnOnce({ stdout: JSON.stringify({ format: {} }) });

      await expect(extractDurationSeconds('/tmp/source')).rejects.toThrow(
        'did not include a numeric format.duration',
      );
    });

    it('throws when format.duration is a non-numeric string (e.g. "N/A")', async () => {
      mockSpawnOnce({
        stdout: JSON.stringify({ format: { duration: 'N/A' } }),
      });

      await expect(extractDurationSeconds('/tmp/source')).rejects.toThrow(
        'did not include a numeric format.duration',
      );
    });

    it('throws an error identifying the command when ffprobe exits non-zero', async () => {
      mockSpawnOnce({ stderr: 'invalid data found', exitCode: 1 });

      await expect(extractDurationSeconds('/tmp/source')).rejects.toThrow(
        /ffprobe exited with code 1/,
      );
    });

    it('propagates spawn-level errors (e.g. binary not found)', async () => {
      mockSpawnOnce({ spawnError: new Error('ENOENT') });

      await expect(extractDurationSeconds('/tmp/source')).rejects.toThrow(
        'ENOENT',
      );
    });
  });

  describe('generateThumbnail', () => {
    it('invokes ffmpeg with a fast seek before -i and -y to overwrite', async () => {
      mockSpawnOnce({ exitCode: 0 });

      await generateThumbnail('/tmp/source', '/tmp/out.jpg', 1.2);

      expect(mockedSpawn).toHaveBeenCalledWith('ffmpeg', [
        '-ss',
        '1.2',
        '-i',
        '/tmp/source',
        '-vframes',
        '1',
        '-y',
        '/tmp/out.jpg',
      ]);
    });

    it('rejects when ffmpeg exits non-zero', async () => {
      mockSpawnOnce({ stderr: 'could not open file', exitCode: 1 });

      await expect(
        generateThumbnail('/tmp/source', '/tmp/out.jpg', 0),
      ).rejects.toThrow(/ffmpeg exited with code 1/);
    });
  });
});
