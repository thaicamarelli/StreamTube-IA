import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class CreateVideoDto {
  /** The original file name as provided by the client. */
  @IsString()
  @IsNotEmpty()
  originalFilename: string;

  /**
   * Declared file size in bytes. Must be a positive integer — the 10GB
   * upload limit (per phase-03-videos/TD-03) is a business rule enforced
   * by VideosService as FILE_TOO_LARGE, not a schema validation rule, so
   * it is intentionally not capped here with @Max.
   */
  @IsInt()
  @Min(1)
  fileSizeBytes: number;
}
