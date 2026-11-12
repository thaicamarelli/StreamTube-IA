import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1793200624302 implements MigrationInterface {
  name = 'CreateVideos1793200624302';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."video_processing_events_status_enum" AS ENUM('processing', 'ready', 'error')`,
    );
    await queryRunner.query(
      `CREATE TABLE "video_processing_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "video_id" uuid NOT NULL, "status" "public"."video_processing_events_status_enum" NOT NULL, "attempt" integer NOT NULL, "message" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_3ff3e42c0d9c2835cf13e4af857" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f99826001754f9ccaddb996895" ON "video_processing_events" ("video_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'error')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "channel_id" uuid NOT NULL, "title" character varying(255), "original_filename" character varying(255) NOT NULL, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "storage_key" character varying(255) NOT NULL, "thumbnail_key" character varying(255), "duration_seconds" integer, "upload_id" character varying(255), "error_reason" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_6ce3c9805943abd5b2950847b64" UNIQUE ("storage_key"), CONSTRAINT "UQ_63237f2f04617cf97d11aa27a29" UNIQUE ("thumbnail_key"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "video_processing_events" ADD CONSTRAINT "FK_f99826001754f9ccaddb9968958" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `ALTER TABLE "video_processing_events" DROP CONSTRAINT "FK_f99826001754f9ccaddb9968958"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f99826001754f9ccaddb996895"`,
    );
    await queryRunner.query(`DROP TABLE "video_processing_events"`);
    await queryRunner.query(
      `DROP TYPE "public"."video_processing_events_status_enum"`,
    );
  }
}
