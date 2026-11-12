import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVideosChannelIdIndex1793201853195 implements MigrationInterface {
  name = 'AddVideosChannelIdIndex1793201853195';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_023a8e4f3f1a34ff3d8ca04a4c" ON "videos" ("channel_id") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_023a8e4f3f1a34ff3d8ca04a4c"`,
    );
  }
}
