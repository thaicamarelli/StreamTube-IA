import { spawn } from 'node:child_process';

interface FfprobeFormat {
  format?: { duration?: string };
}

// fluent-ffmpeg was archived in May 2025 and is no longer maintained (per
// phase-03-videos/TD-04) — spawning the CLI directly keeps this worker
// compatible with whatever FFmpeg version is installed, with no wrapper
// library maintenance risk.
function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `${command} exited with code ${code}: ${(stderr || stdout).trim()}`,
          ),
        );
      }
    });
  });
}

export async function extractDurationSeconds(
  filePath: string,
): Promise<number> {
  const stdout = await runCommand('ffprobe', [
    '-print_format',
    'json',
    '-show_format',
    filePath,
  ]);

  let parsed: FfprobeFormat;
  try {
    parsed = JSON.parse(stdout) as FfprobeFormat;
  } catch {
    throw new Error('ffprobe returned output that is not valid JSON');
  }

  const duration = parsed.format?.duration;
  const parsedDuration = duration === undefined ? NaN : parseFloat(duration);
  if (!Number.isFinite(parsedDuration)) {
    throw new Error(
      `ffprobe output did not include a numeric format.duration (got: ${JSON.stringify(duration)})`,
    );
  }
  return Math.round(parsedDuration);
}

// Frame extracted at 10% of total duration, per phase-03-videos/TD-04's
// clarification. `-ss` before `-i` performs a fast (keyframe) seek.
export async function generateThumbnail(
  filePath: string,
  outputPath: string,
  seekSeconds: number,
): Promise<void> {
  await runCommand('ffmpeg', [
    '-ss',
    String(seekSeconds),
    '-i',
    filePath,
    '-vframes',
    '1',
    '-y',
    outputPath,
  ]);
}
